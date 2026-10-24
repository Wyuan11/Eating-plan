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
const { readPlan } = require('./outbox');

const GATEWAY = process.env.CODEBUDDY_GATEWAY_URL || 'http://127.0.0.1:63698';
const TOKEN = process.env.CODEBUDDY_GATEWAY_PASSWORD;
const OUTBOX = path.join(__dirname, '..', 'data', 'skill-outbox');

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

  // 把 traceId 写进消息，Skill 侧按约定用同名 traceId 落盘
  const fullText = `${text}\n【系统约定】traceId=${traceId}，请用麦门智选助手处理，方案以该 traceId 落盘，无需追问。`;

  const t0 = Date.now();
  const run = await postRun(fullText);
  console.log(`[OK] 已受理 runId=${run.runId} status=${run.status} (${Date.now() - t0}ms)`);

  if (noWait) {
    console.log(`提示: 方案稍后将写入 data/skill-outbox/plan-${traceId}.json`);
    return;
  }

  console.log('等待 Skill 执行并落盘…');
  const plan = await pollOutbox(traceId, deadline);
  if (plan) {
    const status = plan.status;
    console.log(`[DONE] traceId=${traceId} status=${status}`);
    if (status === 'success') {
      console.log(`方案：${(plan.items || []).map((i) => `${i.name}×${i.quantity}`).join(' + ')}`);
      console.log(`合计 ¥${plan.plan.total_price} / ${plan.plan.total_calorie} kcal`);
    } else {
      console.log(`原因：${plan.reason}`);
      console.log(`建议：${plan.hint}`);
    }
  } else {
    await pollRun(run.runId, deadline);
    console.log(`[TIMEOUT] ${timeoutSec}s 内未等到 plan-${traceId}.json，请检查 WorkBuddy 会话是否在处理该消息`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
