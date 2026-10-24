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
}

export interface PlanSummary {
  total_price: number; // 实付合计
  total_calorie: number; // 已计入的官方热量合计（unknown 项不计入）
  original_price: number; // 原价合计
  saved: number; // 省了多少
  budget_usage: string; // "95%"
  calorie_usage: string; // "80%"；无热量约束时为 "—"
}

/** 求解目标：均衡 / 最省钱 / 最低卡。顶层 objective 是当前主方案所用目标。 */
export type Objective = 'balanced' | 'cheapest' | 'lowest_calorie';

export interface Alternative {
  objective: Objective;
  label: string; // "最省钱" / "最低卡"
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
  plan: PlanSummary | null;
  items: PlanItem[];
  nutrition: Nutrition | null;
  alternatives: Alternative[];
  suggestion: string | null;

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
}

export interface OrderResponse {
  success: boolean;
  message: string;
  order?: {
    orderId: string;
    total_price: number;
    payH5Url: string; // 渲染成二维码即可
    expireAt: string;
  };
  error?: ApiError;
  meta: Meta;
}
