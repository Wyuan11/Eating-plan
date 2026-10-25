/**
 * API 客户端：前端只认 /api/*。
 * 后端（server/api.js）在线 → 走真实链路；不在线 → 回退内置 mock 数据。
 * 回退是透明的：上层拿到 { data, mock, fallbackReason } 自行决定如何提示。
 */

import planSuccess from '../../mock/plan.success.json';
import planNoSolution from '../../mock/plan.nosolution.json';
import planError from '../../mock/plan.error.json';
import storesMock from '../../mock/stores.json';
import { normalizePlan } from './normalize.js';

const STORES_TIMEOUT = 4000;
const PLAN_TIMEOUT = 30000; // solver 组合枚举可能稍慢

async function fetchWithTimeout(url, options = {}, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** GET /api/stores */
export async function getStores(params = {}) {
  try {
    const qs = new URLSearchParams(params).toString();
    const res = await fetchWithTimeout(`/api/stores?${qs}`, {}, STORES_TIMEOUT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.items || [];
    return { data: list, mock: false };
  } catch {
    return { data: storesMock, mock: true };
  }
}

/**
 * POST /api/plan
 * @param {{storeCode:string, query?:string, constraints:Object}} payload
 */
export async function submitPlan(payload) {
  try {
    const res = await fetchWithTimeout(
      '/api/plan',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      PLAN_TIMEOUT
    );
    // 无解 / 参数错误时后端返回非 2xx 但 body 仍是 Schema v1，尽量解析出来
    const body = await res.json().catch(() => null);
    // 不管后端是 v1 旧形态还是 v1.1，先归一化成 canonical 再交给组件
    if (body) return { data: normalizePlan(body), mock: false };
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    // 回退 mock：仅当约束明显不可行时展示"无解"态，否则展示成功样例（标注为演示数据）
    const c = payload?.constraints || {};
    const people = Number(c.people) || 1;
    const budget = Number(c.budget) || 0;
    const cheapestMain = 17; // 演示门店可信主食最低价（与 mock 菜单一致）
    const infeasible = budget > 0 && budget < people * cheapestMain;
    const invalid = budget < 0 || people < 1;

    // 三态各有对应 mock：参数错误 > 明显无解 > 成功样例
    const base = invalid ? planError : infeasible ? planNoSolution : planSuccess;
    // 先归一化再覆写约束，避免出现 undefined.budget 这类取值崩溃
    const basePlan = normalizePlan(base);

    // 把用户实际输入的约束写回结果，让顶部"你的约束"与用户一致（方案条目仍是固定演示数据）
    const data = normalizePlan({
      ...base,
      request: {
        ...(base.request || {}),
        constraints: {
          budget: budget || basePlan.constraints.budget,
          calorie_limit: c.calorie_limit == null ? null : Number(c.calorie_limit),
          people,
          excluded: c.excluded || [],
        },
      },
      meta: {
        ...basePlan.meta,
        storeCode: payload?.storeCode || basePlan.meta.storeCode,
        generatedAt: new Date().toISOString(),
      },
    });

    return {
      data,
      mock: true,
      fallbackReason:
        err?.name === 'AbortError'
          ? '连接后端超时，已切换内置演示数据'
          : '未连接后端 /api/plan，已切换内置演示数据',
    };
  }
}
