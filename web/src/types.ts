// 麦门智选助手 · 前端数据契约类型定义（Schema v1）
// 来源：docs/api-schema.md
// 约定：所有字段与后端/Skill 输出严格一致，后端接上后只需换数据源，本文件不改。

// ---------- 通用 ----------
export interface Meta {
  storeCode?: string;
  storeName?: string;
  traceId?: string;
  generatedAt?: string; // ISO8601
  source?: string;
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
  calorie: number | null; // 无数据为 null，前端必须能处理
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

// ---------- 推荐求解 ----------
export interface Constraints {
  budget: number; // 必填，元
  calorie_limit?: number | null; // 大卡，可选
  people?: number; // 默认 1
  excluded?: string[]; // 忌口关键词，如 ["辣","牛肉"]
}

export interface PlanRequest {
  storeCode: string;
  constraints: Constraints;
}

export interface PlanItem {
  code: string;
  name: string;
  price: number; // 单价
  calorie: number | null;
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
  budget_usage: string; // "96%"
  calorie_usage: string; // "74%"，无热量约束时为 "—"
}

export interface Alternative {
  label: string; // "更省钱的" / "更低卡的"
  total_price: number;
  total_calorie: number;
  items: Array<{ name: string; price: number; calorie: number | null }>;
}

export interface PlanSuccess {
  success: true;
  message: string;
  constraints: Constraints;
  plan: PlanSummary;
  items: PlanItem[];
  nutrition: Nutrition;
  alternatives: Alternative[];
  suggestion: string; // 一句话解释，直接展示
  source_note: string;
  meta: Meta;
}

export interface PlanNoSolution {
  success: false;
  message: string;
  reason: string; // 哪条约束导致无解
  conflict: string; // 如 "预算 vs 人数"
  hint: string; // 放宽到多少可行
  constraints: Constraints;
  source_note: string;
  meta: Meta;
}

export interface PlanFailure {
  success: false;
  message: string;
  error: ApiError;
  meta: Meta;
}

export type PlanResponse = PlanSuccess | PlanNoSolution | PlanFailure;

/** 判别守卫：错误码 NO_SOLUTION 走无解态，其余 error 字段存在走异常态 */
export function isNoSolution(r: PlanResponse): r is PlanNoSolution {
  return !r.success && 'conflict' in r;
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
