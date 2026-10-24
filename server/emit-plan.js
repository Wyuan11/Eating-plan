/**
 * Skill 落盘入口：约束 → 求解 → 原子写入 outbox（供 Web 轮询）
 *
 * 这是「Skill → Web」链路的最后一公里。Skill 只需拼出约束参数并调用本脚本，
 * 不需要自己拼 JSON、不需要关心原子写、不需要碰 MCP。
 *
 * CLI:
 *   node server/emit-plan.js --traceId demo-001 --budget 60 --calorie 1200 --people 2 --exclude 辣
 *   node server/emit-plan.js --budget 15 --people 3 --intent "三个人15元"
 *
 * 输出：data/skill-outbox/plan-<traceId>.json
 *   status = success    → plan/items/nutrition/alternatives 可用
 *   status = nosolution → plan=null，读 reason + hint 给用户解释
 *   status = error      → 数据或参数问题，读 message
 *
 * 红线：不调 MCP、不下单、不支付；未知热量来自 solver 的可信池策略，不在此补 0。
 */

const fs = require('fs');
const path = require('path');
const { solve } = require('./solver');
const { writePlan } = require('./outbox');

const ROOT = path.join(__dirname, '..');

/**
 * 构造落盘 payload（纯函数，不写文件）
 *
 * 抽出来导出是为了让 scripts/build_mock.js 复用同一份逻辑生成前端 Mock——
 * Mock 和真实落盘走同一段代码，就不可能出现「Mock 是旧结构、真实是新结构」的漂移。
 */
function buildPayload(opts) {
  const {
    traceId = `t${Date.now()}`,
    menuFile = path.join(ROOT, 'web/mock/menu.json'),
    storeCode = '1450713',
    intent = '',
    constraints = { budget: 60, calorie_limit: null, people: 1, excluded: [] },
    objective = 'balanced',
  } = opts || {};

  let menu;
  try {
    menu = JSON.parse(fs.readFileSync(path.resolve(ROOT, menuFile), 'utf8'));
  } catch (e) {
    return {
      traceId,
      createdAt: new Date().toISOString(),
      status: 'error',
      request: { storeCode, storeName: null, constraints, intent },
      success: false,
      message: `菜单读取失败: ${e.message}`,
      error: { code: 'INTERNAL_ERROR', detail: `菜单读取失败: ${e.message}`, retryable: false },
      items: [],
      alternatives: [],
      plan: null,
      nutrition: null,
    };
  }

  const t0 = Date.now();
  const res = solve(menu.items, { ...constraints, storeCode, storeName: menu.store?.name, objective });
  if (res.meta) {
    res.meta.elapsedMs = Date.now() - t0;
    // solver 自己会生成一个 solver-<ts> 的 traceId，和外层落盘用的不是同一个。
    // 不统一的话前端会拿到两个 ID（meta.traceId 与外层 traceId），排查时极易混淆。
    res.meta.traceId = traceId;
  }

  // v1.1 solver 有三类失败返回，必须区分，否则前端会把参数错误当成"无解"来展示：
  //   1) 约束过严  → {success:false, reason, conflict, hint}        → status=nosolution
  //   2) 参数错误  → {success:false, error:{code,detail}}           → status=error
  //   3) 数据异常  → {success:false, error:{code:INTERNAL_ERROR}}   → status=error
  const status = res.success
    ? 'success'
    : res.error && !res.reason
      ? 'error'
      : 'nosolution';

  const payload = {
    traceId,
    createdAt: new Date().toISOString(),
    status,
    request: { storeCode, storeName: menu.store?.name || null, constraints, intent },
    success: !!res.success,
    message: res.message ?? null,
    objective: res.objective ?? null,
    plan: res.plan ?? null,
    items: res.items ?? [],
    nutrition: res.nutrition ?? null,
    alternatives: res.alternatives ?? [],
    suggestion: res.suggestion ?? null,
    reason: res.reason ?? null,
    // 冲突维度（如「预算 vs 人数」）来自 solver，前端 Mock 里也有此字段，不能漏
    conflict: res.conflict ?? null,
    hint: res.hint ?? null,
    error: res.error ?? null,
    source_note: res.source_note ?? null,
    meta: res.meta ?? null,
  };

  return payload;
}

/** 构造 + 原子落盘 + 终端摘要。Skill 侧与 CLI 都走这里。 */
function emit(opts) {
  const payload = buildPayload(opts);

  if (payload.status === 'error') {
    console.log(`[ERROR] traceId=${payload.traceId}`);
    console.log(`错误码：${payload.error?.code}`);
    console.log(`说明：${payload.error?.detail}`);
  } else if (payload.status === 'success') {
    console.log(`[OK] traceId=${payload.traceId}`);
    console.log(`方案：${payload.items.map((i) => `${i.name}×${i.quantity}`).join(' + ')}`);
    console.log(`合计 ¥${payload.plan.total_price} / ${payload.plan.total_calorie} kcal`);
  } else {
    console.log(`[NO-SOLUTION] traceId=${payload.traceId}`);
    console.log(`原因：${payload.reason}`);
    console.log(`建议：${payload.hint || (payload.error && payload.error.detail) || '放宽预算或人数'}`);
  }

  const target = writePlan(payload.traceId, payload);
  console.log(`已写入 ${path.relative(ROOT, target)}`);
  return { payload, target };
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const calorieRaw = arg('calorie', null);
  const excluded = arg('exclude', '') ? arg('exclude').split(/[,，\s]+/).filter(Boolean) : [];

  const { payload } = emit({
    traceId: arg('traceId', null) || `t${Date.now()}`,
    menuFile: arg('menu', path.join(ROOT, 'web/mock/menu.json')),
    storeCode: arg('store', '1450713'),
    intent: arg('intent', ''),
    objective: arg('objective', 'balanced'),
    constraints: {
      budget: Number(arg('budget', 60)),
      // 关键：没传 --calorie 就是 null，绝不替用户编造热量上限
      calorie_limit: calorieRaw == null || calorieRaw === '' ? null : Number(calorieRaw),
      people: Number(arg('people', 1)),
      excluded,
    },
  });

  // 菜单读不出来属于环境故障，给非零退出码便于脚本判断
  if (payload.status === 'error' && payload.error?.code === 'INTERNAL_ERROR') process.exit(1);
}

if (require.main === module) main();

module.exports = { buildPayload, emit, emitPlanPath: path.join(ROOT, 'data', 'skill-outbox') };
