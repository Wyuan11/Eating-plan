/**
 * 契约归一化 —— 前端拿到任何形态的方案，都先过这一层再交给组件渲染。
 *
 * 为什么要这一层：
 * 1. 后端 A 的 server/api.js 还没写完，它最终返回什么形态未定；
 *    而 Skill 侧真实落盘（emit-plan.js）已经是 v1.1 形态。
 * 2. 队友最初的内置 mock 是 v1 旧形态（顶层 constraints、success 布尔）。
 * 没有归一化，同一份组件代码要同时认识两套字段，改一处漏一处。
 *
 * 归一化的结果（canonical v1.1）同时保留两套键，旧组件代码不用改：
 *   status              'success' | 'nosolution' | 'error'  ← 三态唯一判据
 *   success             布尔，等于 status === 'success'      ← 兼容旧代码
 *   request.constraints 约束（权威位置）
 *   constraints         同一个对象引用                      ← 兼容旧代码
 *   objective           'balanced' | 'lowest_price' | 'lowest_calorie'
 *   meta                { storeCode, traceId, generatedAt, elapsedMs }
 */

const EMPTY_CONSTRAINTS = { budget: null, calorie_limit: null, people: 1, excluded: [] };

/** 推断三态：优先信 status，没有就按 success / error 反推 */
function inferStatus(raw) {
  // 后端可能返回 'pending'（异步未落盘）等状态，一律原样保留，
  // 否则会被误判成「无解」，前端就停止轮询、给用户弹错误。
  if (typeof raw.status === 'string' && raw.status) return raw.status;
  if (raw.error) return 'error';
  if (raw.success === false) return 'nosolution';
  if (raw.success === true) return 'success';
  // 既没有 status 也没有 success：有方案就是成功，否则无解
  return raw.plan ? 'success' : 'nosolution';
}

function normalizeConstraints(raw) {
  const c = raw.request?.constraints || raw.constraints || {};
  return {
    // budget 允许 null：用户明确「不设预算」。与「没给」同形但不替用户编造默认值
    budget: c.budget == null ? null : Number(c.budget),
    // 关键：没给热量上限就是 null，绝不在这里替用户编造一个值
    calorie_limit: c.calorie_limit == null ? null : Number(c.calorie_limit),
    people: Number(c.people) || 1,
    excluded: Array.isArray(c.excluded) ? c.excluded : [],
    // 正向诉求透传（展示「想吃 X×N」与披露用）
    wants: Array.isArray(c.wants) ? c.wants : [],
  };
}

/** 策略标签（与 solver 的 OBJECTIVE_LABELS 对齐） */
const LABELS = { balanced: '均衡推荐', cheapest: '省钱优先', lowest_calorie: '最低卡', max_value: '预算吃满' };

function normalizeItem(it = {}) {
  return { ...it, quantity: it.quantity || 1, calorie: it.calorie == null ? null : it.calorie };
}

/** v1.2 单个方案条目：完整 items（可直接下单与校验）+ plan 汇总 + 策略说明 */
function normalizePlanEntry(p = {}, fallback = {}) {
  const items = (p.items || []).map(normalizeItem);
  const plan =
    p.plan ||
    (p.total_price != null
      ? { total_price: p.total_price, total_calorie: p.total_calorie, saved: p.saved ?? 0, original_price: p.original_price ?? p.total_price }
      : null);
  return {
    key: p.key || p.objective || fallback.key || null,
    objective: p.objective || p.key || null,
    label: p.label || LABELS[p.objective] || fallback.label || '方案',
    strategy: p.strategy || null,
    highlight: p.highlight || null,
    plan,
    items,
    nutrition: p.nutrition || null,
  };
}

/**
 * 老形态（顶层 plan + alternatives）补成 plans 数组：
 * 后端没升级、或读的是旧 mock 时，前端依然能按多方案渲染。
 */
function synthesizePlans(raw, mainLabel) {
  const main = normalizePlanEntry(
    { plan: raw.plan, items: raw.items, nutrition: raw.nutrition, objective: raw.objective, key: raw.objective },
    { label: mainLabel, key: raw.objective || 'balanced' }
  );
  if (!main.plan) return [];
  const rest = (raw.alternatives || []).map((a) =>
    normalizePlanEntry({ ...a, objective: a.objective, plan: a.plan || { total_price: a.total_price, total_calorie: a.total_calorie } })
  );
  return [main, ...rest].slice(0, 3);
}

/**
 * @param {Object} raw 任意形态的方案（v1 旧 mock / v1.1 真实落盘 / 后端 API）
 * @returns {Object|null} canonical v1.1
 */
export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const status = inferStatus(raw);
  const constraints = normalizeConstraints(raw);
  const request = { ...(raw.request || {}), constraints };
  const meta = {
    storeCode: raw.meta?.storeCode || raw.request?.storeCode || null,
    traceId: raw.meta?.traceId || raw.traceId || null,
    generatedAt: raw.meta?.generatedAt || raw.createdAt || null,
    elapsedMs: raw.meta?.elapsedMs ?? null,
  };

  const objective = raw.objective || 'balanced';
  // v1.2：优先用后端给的 plans（1～3 个策略化方案）；没有就由主方案 + alternatives 合成
  const plans = Array.isArray(raw.plans) && raw.plans.length
    ? raw.plans.map((p) => normalizePlanEntry(p))
    : synthesizePlans(raw, LABELS[objective] || '均衡推荐');

  return {
    ...raw,
    status,
    success: status === 'success',
    request,
    constraints,
    objective,
    plan: raw.plan || null,
    items: (raw.items || []).map(normalizeItem),
    nutrition: raw.nutrition || null,
    plans,
    alternatives: plans.slice(1).map((p) => ({
      label: p.label,
      objective: p.objective,
      strategy: p.strategy,
      highlight: p.highlight,
      total_price: p.plan?.total_price ?? 0,
      total_calorie: p.plan?.total_calorie ?? null,
      items: p.items,
    })),
    suggestion: raw.suggestion ?? null,
    reason: raw.reason ?? null,
    hint: raw.hint ?? null,
    conflict: raw.conflict ?? null,
    source_note: raw.source_note ?? null,
    error: raw.error || null,
    meta,
  };
}

/** 三态判据（组件请一律用这三个，不要直接读 success） */
export const isSuccess = (p) => p?.status === 'success';
export const isNoSolution = (p) => p?.status === 'nosolution';
export const isError = (p) => p?.status === 'error';
export { EMPTY_CONSTRAINTS };
