/**
 * Web/外部 → Skill 的 HTTP 触发脚本（WorkBuddy 本机 Gateway，已实测可用）
 *
 * 链路：
 *   本脚本 → POST http://127.0.0.1:63698/api/v1/runs
 *         → WorkBuddy 会话收到消息，触发 mcd-smart-order Skill
 *         → Skill 调 server/emit-plan.js 原子落盘
 *         → 本脚本轮询 data/skill-outbox/plan-<traceId>.json 等结果
 *
 * 用法（工作目录=项目根，且在 WorkBuddy 会话派生的终端里运行，
 *       CODEBUDDY_GATEWAY_PASSWORD 已在进程环境中）：
 *
 *   node server/trigger-skill.js --text "两个人午餐，预算60元，1200大卡以内，不要辣" --traceId web-001
 *   node server/trigger-skill.js --text "..." --traceId web-002 --no-wait   # 只触发不等结果
 *
 * 鉴权：Bearer <CODEBUDDY_GATEWAY_PASSWORD>。该值由 WorkBuddy 主进程生成并注入
 *       会话进程环境，WorkBuddy 重启后会变化。禁止写死进代码或提交 git。
 *       在独立终端手动运行时，可先执行：
 *         PowerShell: $env:CODEBUDDY_GATEWAY_PASSWORD = "<从 WorkBuddy 设置/远程控制获取>"
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readPlan, writePlan } = require('./outbox');
const { buildPayload } = require('./emit-plan');

const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.CODEBUDDY_GATEWAY_PASSWORD;

/**
 * 网关地址解析：环境变量 → 本机会话文件 → 兜底默认值
 *
 * 端口由 WorkBuddy 主进程按会话分配（本次是 63698，重启后会变），写死会导致
 * WorkBuddy 重启后脚本全部失效。会话文件里存了真实 endpoint，自动读取最稳。
 */
function resolveGateway() {
  if (process.env.CODEBUDDY_GATEWAY_URL) {
    return { url: process.env.CODEBUDDY_GATEWAY_URL, from: '环境变量 CODEBUDDY_GATEWAY_URL' };
  }
  const dir = path.join(os.homedir(), '.workbuddy', 'sessions');
  try {
    let best = null;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!j.endpoint) continue;
      // 优先取 cwd 与本项目一致的会话；其次取心跳最新的
      const sameCwd = j.cwd && path.resolve(j.cwd) === path.resolve(ROOT);
      const score = (sameCwd ? 1e15 : 0) + Number(j.lastHeartbeat || 0);
      if (!best || score > best.score) {
        best = { score, url: j.endpoint, from: `会话文件 ${f}${sameCwd ? '（同项目）' : ''}` };
      }
    }
    if (best) return { url: best.url, from: best.from };
  } catch {
    /* 读不到就走兜底 */
  }
  return { url: 'http://127.0.0.1:63698', from: '兜底默认值' };
}

const GATEWAY_INFO = resolveGateway();
const GATEWAY = GATEWAY_INFO.url;
const OUTBOX = path.join(ROOT, 'data', 'skill-outbox');

function arg(k, d) {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
}

async function postRun(text) {
  if (!TOKEN) {
    throw new Error('缺少环境变量 CODEBUDDY_GATEWAY_PASSWORD（网关鉴权密钥）');
  }
  const id = `web-${Date.now()}`;
  const res = await fetch(`${GATEWAY}/api/v1/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      id,
      type: 'message',
      text,
      sender: { id: 'mcd-web', name: '麦门Web前端' },
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 401) throw new Error('网关鉴权失败：CODEBUDDY_GATEWAY_PASSWORD 无效或已轮换');
  if (res.status === 429) throw new Error('网关限频，请稍后重试');
  if (!res.ok) throw new Error(`网关 HTTP ${res.status}`);
  const body = await res.json();
  const run = body.data || body;
  if (!run.runId) throw new Error(`网关未返回 runId：${JSON.stringify(body).slice(0, 200)}`);
  return run;
}

async function pollRun(runId, deadline) {
  while (Date.now() < deadline) {
    const res = await fetch(`${GATEWAY}/api/v1/runs/${runId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const { data } = await res.json();
      if (data && data.active === false) return 'done';
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 'timeout';
}

async function pollOutbox(traceId, deadline) {
  const file = path.join(OUTBOX, `plan-${traceId}.json`);
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      try {
        const plan = readPlan(traceId);
        return plan;
      } catch {
        /* 半截文件理论上不会出现（原子写），保险起见继续等 */
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

/** 从 CLI 解析结构化约束；只有全部给出时才能走本地降级（本地没有语义解析能力） */
function structuredConstraints() {
  const budget = arg('budget', null);
  if (budget == null) return null;
  const calorie = arg('calorie', null);
  const excluded = arg('exclude', '') ? arg('exclude').split(/[,，\s]+/).filter(Boolean) : [];
  return {
    budget: Number(budget),
    calorie_limit: calorie == null || calorie === '' ? null : Number(calorie),
    people: Number(arg('people', 1)),
    excluded,
  };
}

/**
 * 降级：网关不可用或 Skill 未按时落盘时，本地直算并落盘。
 * 代价是跳过 Skill 的语义理解（所以必须自带结构化约束），好处是演示不会卡死在轮询上。
 */
function fallbackLocal(traceId, text, constraints, reason) {
  if (!constraints) {
    console.error(
      `[FATAL] ${reason}\n` +
        `降级需要结构化约束，请补 --budget [--calorie N] [--people N] [--exclude 辣,牛肉]，例如：\n` +
        `  node server/trigger-skill.js --text "..." --traceId web-001 --budget 60 --calorie 1200 --people 2 --exclude 辣`,
    );
    return null;
  }
  console.warn(`[FALLBACK] ${reason} → 本地直算落盘（跳过 Skill 语义层，方案仍然有效）`);
  const payload = buildPayload({
    traceId,
    constraints,
    intent: text,
    objective: arg('objective', 'balanced'),
  });
  writePlan(traceId, payload);
  return payload;
}

function printPlan(plan) {
  const status = plan.status;
  console.log(`[DONE] traceId=${plan.traceId} status=${status}`);
  if (status === 'success') {
    console.log(`方案：${(plan.items || []).map((i) => `${i.name}×${i.quantity}`).join(' + ')}`);
    console.log(`合计 ¥${plan.plan.total_price} / ${plan.plan.total_calorie} kcal`);
    return;
  }
  if (status === 'error') {
    // error 态没有 reason/hint，只有 error.code + error.detail，别打印 null
    console.log(`错误码：${plan.error?.code ?? 'UNKNOWN'}`);
    console.log(`说明：${plan.error?.detail ?? plan.message ?? '未知错误'}`);
    return;
  }
  console.log(`原因：${plan.reason ?? plan.message ?? '约束过严'}`);
  console.log(`建议：${plan.hint ?? '放宽预算或人数'}`);
}

async function main() {
  const text = arg('text', null);
  if (!text) {
    console.error('用法: node server/trigger-skill.js --text "<点单需求>" --traceId <ID> [--no-wait]');
    process.exit(2);
  }
  const traceId = arg('traceId', `web-${Date.now()}`);
  const noWait = process.argv.includes('--no-wait');
  const timeoutSec = Number(arg('timeout', 180));
  const deadline = Date.now() + timeoutSec * 1000;
  const constraints = structuredConstraints();

  // 把 traceId 写进消息，Skill 侧按约定用同名 traceId 落盘
  const fullText = `${text}\n【系统约定】traceId=${traceId}，请用麦门智选助手处理，方案以该 traceId 落盘，无需追问。`;

  console.log(`网关：${GATEWAY}（来源：${GATEWAY_INFO.from}）`);

  const t0 = Date.now();
  let run;
  try {
    run = await postRun(fullText);
    console.log(`[OK] 已受理 runId=${run.runId} status=${run.status} (${Date.now() - t0}ms)`);
  } catch (e) {
    const plan = fallbackLocal(traceId, text, constraints, `网关触发失败：${e.message}`);
    if (!plan) process.exit(1);
    printPlan(plan);
    return;
  }

  if (noWait) {
    console.log(`提示: 方案稍后将写入 data/skill-outbox/plan-${traceId}.json`);
    return;
  }

  console.log('等待 Skill 执行并落盘…');
  const plan = await pollOutbox(traceId, deadline);
  if (plan) {
    printPlan(plan);
    return;
  }

  // 超时：Skill 可能被会话占用或没被触发，能降级就降级，别让演示干等
  await pollRun(run.runId, Date.now());
  const fallback = fallbackLocal(
    traceId,
    text,
    constraints,
    `${timeoutSec}s 内未等到 plan-${traceId}.json（Skill 可能未在会话中执行）`,
  );
  if (!fallback) {
    console.error('[TIMEOUT] 无法获取方案，请检查 WorkBuddy 会话是否在处理该消息');
    process.exit(1);
  }
  printPlan(fallback);
}

/**
 * 供 api.js 调用的编程式入口：触发 Skill 后立即返回（202 语义），
 * 落盘在后台轮询等待。调用方用 GET /api/plan/:traceId 轮询 outbox。
 */
async function triggerAsync({ text, traceId, timeoutSec = 180 }) {
  const fullText = `${text}\n【系统约定】traceId=${traceId}，请用麦门智选助手处理，方案以该 traceId 落盘，无需追问。`;
  const run = await postRun(fullText);
  const deadline = Date.now() + timeoutSec * 1000;
  pollOutbox(traceId, deadline).then((plan) => {
    if (!plan) console.warn(`[triggerAsync] ${timeoutSec}s 内未等到 plan-${traceId}.json（Skill 未执行？）`);
  });
  return { runId: run.runId, traceId, gateway: GATEWAY, gatewayFrom: GATEWAY_INFO.from };
}

// 加 require.main 守卫是为了能被测试脚本 require 而不触发一次真实请求
if (require.main === module) {
  main().catch((e) => {
    console.error(`[FATAL] ${e.message}`);
    process.exit(1);
  });
}

module.exports = { resolveGateway, structuredConstraints, fallbackLocal, triggerAsync };
