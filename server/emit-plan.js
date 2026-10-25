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
/**
 * 菜单来源优先级：显式指定 > 真实门店缓存 data/menu-<storeCode>.json > 前端 Mock
 *
 * 之前默认读 web/mock/menu.json，那是给前端联调用的副本（基于旧快照，比真实缓存少
 * 「脆脆薯条」等新品），演示时会少候选品。真实门店缓存才是权威数据源。
 */
function resolveMenuFile(storeCode, explicit) {
  if (explicit) return path.resolve(ROOT, explicit);
  const real = path.join(ROOT, 'data', `menu-${storeCode}.json`);
  if (fs.existsSync(real)) return real;
  return path.join(ROOT, 'web', 'mock', 'menu.json');
}

function buildPayload(opts) {
  const {
    traceId = `t${Date.now()}`,
    storeCode = '1450713',
    intent = '',
    constraints = { budget: 60, calorie_limit: null, people: 1, excluded: [] },
    objective = 'balanced',
    // 用户提到、但当前数据无法参与求解的偏好（如「中辣」）。
    // 必须显式回传并说明原因，不能假装已生效，也不能悄悄丢弃。
    notes = [],
    // 调用方（如 server/api.js）已经读过菜单时直接传进来，避免重复读文件
    menu: injectedMenu = null,
    // 优惠券：由 server/coupons.js 解析出的真实券数组（含 priceAfterFen / 有效期 / 渠道）。
    // 为空数组或 undefined 时不参与求解，行为与加券前完全一致。
    coupons = null,
  } = opts || {};
  const menuFile = resolveMenuFile(storeCode, opts.menuFile);

  let menu = injectedMenu;
  if (!menu) {
    try {
      menu = JSON.parse(fs.readFileSync(path.resolve(ROOT, menuFile), 'utf8'));
    } catch (e) {
      return {
        traceId,
        createdAt: new Date().toISOString(),
        status: 'error',
        request: { storeCode, storeName: null, constraints, intent, notes },
        success: false,
        message: `菜单读取失败: ${e.message}`,
        error: { code: 'INTERNAL_ERROR', detail: `菜单读取失败: ${e.message}`, retryable: false },
    items: [],
    alternatives: [],
    plans: [],
    plan: null,
    nutrition: null,
      };
    }
  }

  const t0 = Date.now();
  const res = solve(
    menu.items,
    { ...constraints, storeCode, storeName: menu.store?.name, objective, ...(Array.isArray(coupons) ? { coupons } : {}) },
    opts.options || {}
  );
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

  // 求解器自己也会产出 notes（例如「不要冰饮」因菜单无温度数据无法执行），
  // 与调用方传入的 notes 合并去重后一起回传，保证未生效的诉求不会被静默丢弃。
  const solverNotes = Array.isArray(res.notes) ? res.notes : [];
  const seenNotes = new Set(notes.map(n => `${n.text}|${n.reason}`));
  for (const n of solverNotes) {
    const k = `${n.text}|${n.reason}`;
    if (!seenNotes.has(k)) { seenNotes.add(k); notes.push(n); }
  }

  const payload = {
    traceId,
    createdAt: new Date().toISOString(),
    status,
    request: { storeCode, storeName: menu.store?.name || null, constraints, intent, notes },
    success: !!res.success,
    message: res.message ?? null,
    objective: res.objective ?? null,
    plan: res.plan ?? null,
    items: res.items ?? [],
    nutrition: res.nutrition ?? null,
    // v1.2 多方案：1～3 个策略化方案（省钱优先 / 均衡推荐 / 预算吃满 / 最低卡），
    // 每个都是完整可下单、可独立校验的方案，plans[0] 即顶层主方案。
    plans: res.plans ?? [],
    alternatives: res.alternatives ?? [],
    suggestion: res.suggestion ?? null,
    reason: res.reason ?? null,
    // 冲突维度（如「预算 vs 人数」）来自 solver，前端 Mock 里也有此字段，不能漏
    conflict: res.conflict ?? null,
    hint: res.hint ?? null,
    error: res.error ?? null,
    source_note: res.source_note ?? null,
    // 券：生效/未生效清单与免责说明。前端要能说清「省的钱里多少来自券、券为什么没用上」
    coupons: res.coupons ?? null,
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
    for (const n of payload.request.notes || []) console.log(`[注意] 「${n.text}」${n.reason}`);
    console.log(`共 ${payload.plans.length} 个方案（均满足约束，按策略区分）：`);
    payload.plans.forEach((p, i) => {
      console.log(
        `  ${i + 1}. ${p.label}（${p.strategy}） ¥${p.plan.total_price} / ${p.plan.total_calorie} kcal · ${p.highlight}`
      );
      console.log(`     ${p.items.map((it) => `${it.name}×${it.quantity}`).join(' + ')}`);
    });
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
  // --want "冰淇淋x1,麦香鸡x2"：正向诉求带精确数量，数量是硬约束
  const wants = arg('want', '') ? arg('want').split(/[,，]+/).filter(Boolean).map(s => {
    const m = s.match(/^(.+?)(?:[x×*]\s*(\d+))?$/);
    return { keyword: m[1].trim(), qty: Number(m[2] || 1) };
  }) : [];

  // --note "中辣|菜单无辣度分级数据，该偏好已记录但未参与求解"
  const notes = arg('note', '') ? arg('note').split(/[;；]+/).filter(Boolean).map(s => {
    const [text, reason] = s.split('|').map(x => x.trim());
    return { text, reason: reason || '当前菜单数据无法参与求解，已记录但未生效' };
  }) : [];

  const { payload } = emit({
    traceId: arg('traceId', null) || `t${Date.now()}`,
    menuFile: arg('menu', null), // 不传则自动选真实门店缓存
    storeCode: arg('store', '1450713'),
    intent: arg('intent', ''),
    objective: arg('objective', 'balanced'),
    notes,
    constraints: {
      budget: Number(arg('budget', 60)),
      // 关键：没传 --calorie 就是 null，绝不替用户编造热量上限
      calorie_limit: calorieRaw == null || calorieRaw === '' ? null : Number(calorieRaw),
      people: Number(arg('people', 1)),
      excluded,
      wants,
    },
  });

  // 菜单读不出来属于环境故障，给非零退出码便于脚本判断
  if (payload.status === 'error' && payload.error?.code === 'INTERNAL_ERROR') process.exit(1);
}

if (require.main === module) main();

module.exports = { buildPayload, emit, emitPlanPath: path.join(ROOT, 'data', 'skill-outbox') };
