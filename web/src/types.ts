// 麦门智选助手 · 前端数据契约类型定义（Schema v1.1）
// 来源：docs/api-schema.md，与 server/emit-plan.js 真实落盘结构逐字段对齐
// 约定：Mock（web/mock/plan.*.json）与线上落盘（data/skill-outbox/plan-<traceId>.json）
//       由同一份代码 buildPayload 生成，结构完全一致，前端只需一套解析。

// ---------- 通用 ----------
export interface Meta {
  storeCode?: string;
  generatedAt?: string; // ISO8601
  traceId?: string;
  elapsedMs?: number;
  [k: string]: unknown; // solver 后续可能追加字段，前端勿硬依赖
}

export interface ApiError {
  code:
    | 'BAD_REQUEST'
    | 'MCP_UPSTREAM_ERROR'
    | 'NO_SOLUTION'
    | 'STORE_CLOSED'
    | 'NOT_FOUND'
    | 'INTERNAL_ERROR';
  detail: string;
  retryable: boolean;
}

// ---------- 门店 ----------
export interface Store {
  code: string;
  name: string;
  address: string;
  distance?: string; // 展示用，如 "0.3km"
  beType: number; // 1=到店自取 2=外送麦乐送 6=团餐
}

export interface StoresResponse {
  success: true;
  items: Store[];
  meta: Meta;
}

// ---------- 菜单 ----------
export type ItemKind = 'single' | 'combo' | 'merch';
/** official=官方营养表官方值 / estimated=按同类估算 / unknown=官方未公布 / not_applicable=套餐或周边 */
export type CalorieSource = 'official' | 'estimated' | 'unknown' | 'not_applicable';

export interface Nutrition {
  protein: number; // g
  fat: number; // g
  carbohydrate: number; // g
  sodium: number; // mg
  calcium: number; // mg
}

export interface MenuItem {
  code: string;
  name: string;
  price: number;
  original_price: number; // 原价，price < original_price 表示有促销
  kind: ItemKind;
  category: '主食' | '小食' | '饮品' | '甜品' | '其他';
  calorie: number | null; // 无数据为 null，前端必须能处理（不是 0）
  calorie_source: CalorieSource;
  nutrition: Nutrition | null;
  tags: string[]; // 如 ["不辣","鸡肉","麦咖啡"]
  available: boolean;
}

export interface MenuResponse {
  success: true;
  store: Pick<Store, 'code' | 'name' | 'address'>;
  count: number;
  items: MenuItem[];
  meta: Meta;
}

// ---------- 约束 ----------
export interface Constraints {
  budget: number; // 必填，元
  calorie_limit?: number | null; // 大卡；未指定时为 null，不得由前端替用户填默认值
  people?: number; // 默认 1
  excluded?: string[]; // 忌口关键词，如 ["辣","牛肉"]
}

export interface PlanRequest {
  storeCode: string;
  constraints: Constraints;
}

// ---------- 方案内容 ----------
export interface PlanItem {
  code: string;
  name: string;
  price: number; // 单价
  calorie: number | null; // 未知为 null
  calorie_source: CalorieSource;
  category: string;
  quantity: number;
  nutrition: Nutrition | null;
  tags: string[];
  /** v1.4：该商品命中了券，price 已是券后价 */
  coupon?: {
    title: string; // 券名
    before_price: number; // 用券前的门店促销价
    after_price: number; // 券后价（= 上面 price）
    saved: number; // 单件省了多少
  } | null;
}

export interface PlanSummary {
  total_price: number; // 券后实付合计（无券时即促销价合计）
  total_calorie: number; // 已计入的官方热量合计（unknown 项不计入）
  original_price: number; // 原价合计
  saved: number; // 省了多少（含券省）
  /** v1.4：saved 里来自券的部分；无券为 0 */
  coupon_saved?: number;
  /** v1.4：未用券时的总价 = total_price + coupon_saved */
  price_before_coupon?: number;
  budget_usage: string; // "95%"
  calorie_usage: string; // "80%"；无热量约束时为 "—"
}

/**
 * v1.4 券报告：生效了哪几张、没生效的为什么。
 * 注意 disclaimer —— 券接口不返回券码，核价与下单不带券，实付以核价结果为准，前端不能说成「实付立减」。
 */
export interface CouponReport {
  total: number;
  applied: Array<{ title: string; code: string; name: string; before: number; after: number; saved: number }>;
  skipped: Array<{ title: string; status: 'no_match' | 'ambiguous' | 'not_cheaper' | 'unsupported' | 'not_now'; reason: string }>;
  disclaimer: string;
}

/**
 * v1.2 求解目标：均衡 / 省钱优先 / 最低卡 / 预算吃满。
 * 顶层 objective 是当前主方案（plans[0]）所用目标。
 */
export type Objective = 'balanced' | 'cheapest' | 'lowest_calorie' | 'max_value';

/**
 * v1.2 单个方案：完整可下单、可独立重算校验。
 * 成功响应里 plans 有 1～3 个，全部满足同一组硬约束，只是优化目标不同。
 */
export interface PlanEntry {
  key: Objective;
  objective: Objective; // 兼容旧字段，等于 key
  label: string; // "均衡推荐" / "省钱优先" / "预算吃满" / "最低卡"
  strategy: string | null; // 一句话说明这套方案在优化什么
  highlight: string | null; // 与主方案的差异，如 "比主方案省 ¥25.0"
  plan: PlanSummary;
  items: PlanItem[]; // 完整条目，含 code/quantity/nutrition
  nutrition: Nutrition | null;
}

export interface Alternative {
  objective: Objective;
  label: string; // "省钱优先" / "预算吃满" / "最低卡"
  strategy?: string | null;
  highlight?: string | null;
  total_price: number;
  total_calorie: number;
  items: PlanItem[]; // 完整条目，含 code/quantity，可直接下单与校验
}

// ---------- 统一响应封装（三态）----------
/**
 * status 是唯一判别依据：
 *   success    → plan/items/nutrition/alternatives 可用
 *   nosolution → plan=null，读 reason + conflict + hint 给用户解释
 *   error      → 参数或数据问题，读 error.code + error.detail
 * 注意：success 布尔字段保留仅为兼容，新代码一律用 status 判断。
 */
export type PlanStatus = 'success' | 'nosolution' | 'error';

export interface PlanEnvelope {
  traceId: string; // 轮询/排查用，贯穿整条链路
  createdAt: string; // ISO8601
  status: PlanStatus;
  request: {
    storeCode: string;
    storeName: string | null;
    constraints: Constraints; // 约束在这里，不在顶层
    intent?: string; // 用户原始自然语言
  };
  /** @deprecated 兼容旧代码，请用 status */
  success: boolean;
  objective: Objective | null;
  message: string | null;

  // success 态
  plan: PlanSummary | null; // 主方案合计（= plans[0].plan）
  items: PlanItem[]; // 主方案条目（= plans[0].items）
  nutrition: Nutrition | null;
  /** v1.2：1～3 个策略化方案，全部满足约束；新代码优先读这里 */
  plans: PlanEntry[];
  alternatives: Alternative[]; // = plans.slice(1)，兼容旧代码
  suggestion: string | null;
  /** v1.4：券报告。仅当请求带 coupons / useCoupons 时出现，否则为 null */
  coupons?: CouponReport | null;

  // nosolution 态
  reason: string | null; // 哪条约束导致无解
  conflict: string | null; // 如 "预算 vs 人数"
  hint: string | null; // 放宽到多少可行

  // error 态
  error: ApiError | null;

  source_note: string | null;
  meta: Meta | null;
}

export type PlanResponse = PlanEnvelope;

/** 判别守卫：优先用 status；无 status 的旧数据回退到 success + conflict 组合 */
export function isNoSolution(r: PlanResponse): boolean {
  if (r.status) return r.status === 'nosolution';
  return !r.success && 'conflict' in r;
}

export function isError(r: PlanResponse): boolean {
  if (r.status) return r.status === 'error';
  return !r.success && !('conflict' in r);
}

export function isSuccess(r: PlanResponse): boolean {
  if (r.status) return r.status === 'success';
  return !!r.success;
}

// ---------- 下单 ----------
export interface OrderRequest {
  storeCode: string;
  items: Array<{ code: string; quantity: number }>;
  beType?: number; // 1: 到店取餐（默认）/ 2: 麦乐送 / 5: 得来速 / 6: 团餐
  mock?: boolean; // 仅演示用：不调 MCP，响应 meta.source='mock'
}

export interface OrderResponse {
  success: boolean;
  message: string;
  order?: {
    orderId: string;
    total_price: number;
    payH5Url: string; // 渲染成二维码即可，禁止自动跳转/自动支付
    expireAt: string | null; // MCP 未返回支付截止时间时为 null，前端不要编造倒计时
    storeName?: string | null;
    orderStatus?: string | null;
  };
  /** 核价结果：快照价 vs MCP 实时价，matched=false 时后端已拦截（409），不会下单 */
  price_check?: {
    expected_price: number | null;
    actual_price: number;
    product_price: number;
    delivery_price: number;
    discount: number;
    matched: boolean | null;
  };
  error?: ApiError;
  meta: Meta;
}
