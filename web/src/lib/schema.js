/**
 * Schema v1 数据契约（前端侧类型说明 + 常量）
 *
 * 与后端 docs/api-schema.md / solver.js 输出严格一致，字段名不许改。
 * 前端只做：收集参数、渲染、可视化、算术校验 —— 不写推荐逻辑、不直接调 MCP。
 */

/** 菜品大类（后端已用麦当劳官方分类判定） */
export const CATEGORIES = ['主食', '小食', '饮品', '甜品'];

/** 热量来源可信度（前端据此渲染标签） */
export const CALORIE_SOURCE_LABEL = {
  official: '官方营养数据',
  estimated: '估算值',
  unknown: '未公布',
  not_applicable: '—',
};

/**
 * @typedef {Object} PlanItem
 * @property {string} code
 * @property {string} name
 * @property {number} price
 * @property {number|null} calorie
 * @property {'official'|'estimated'|'unknown'} calorie_source
 * @property {'主食'|'小食'|'饮品'|'甜品'} category
 * @property {number} quantity
 * @property {string|null} image
 * @property {string[]} tags
 * @property {{protein:number,fat:number,carbohydrate:number,sodium:number}|null} [nutrition]
 */

/**
 * @typedef {Object} RecommendResult   Schema v1 完整结果
 * @property {boolean} success
 * @property {string} message
 * @property {{budget:number,calorie_limit:number|null,people:number,excluded:string[]}} constraints
 * @property {{total_price:number,total_calorie:number,original_price:number,saved:number,budget_usage:string,calorie_usage:string}} plan
 * @property {PlanItem[]} items
 * @property {{protein:number,fat:number,carbohydrate:number,sodium:number}} nutrition
 * @property {Array<{label:string,total_price:number,total_calorie:number,items:Array<{name:string,price:number,calorie:number|null}>}>} alternatives
 * @property {string} suggestion
 * @property {string} source_note
 * @property {{storeName:string,storeCode:string,traceId:string,generatedAt:string}} meta
 */

/**
 * 忌口可选项（与后端 solver.js 的 excluded 语义严格对齐）
 *
 * 分三类，求解器处理方式不同：
 *   1) 原料词（辣/牛肉/…）      → tag 精确匹配 + 品名包含
 *   2) 品类词（饮料/甜品）      → 按 category 整类过滤（solver CATEGORY_ALIASES：饮料→饮品）
 *   3) 温度词（冰饮/冷饮/热饮） → 仅当菜单有 temperature 字段才生效，
 *                                否则求解器只在 notes 里如实披露「无法执行」，绝不猜冷热
 * 「咖啡」是子类标签词，走 tag.includes 单向匹配，用于命中「麦咖啡™咖啡」这类长标签。
 */
export const EXCLUDE_OPTIONS = [
  // 原料 / 过敏原（成品原有，覆盖更细，保留）
  '辣', '牛肉', '猪肉', '鸡肉', '鱼', '海鲜', '洋葱', '葱', '蒜', '蛋', '奶', '花生', '芝麻', '坚果', '芥末', '香菜',
  // 品类级整类过滤（来自 v2）
  '饮料', '甜品',
  // 温度级（来自 v2；无数据时如实披露而非静默失效）
  '冰饮', '冷饮', '热饮',
  // 子类标签（来自 v2）
  '咖啡',
];

/** 快捷示例（空态 / 演示用），点击即回填表单 */
export const QUICK_PRESETS = [
  { label: '两人减脂 · 不吃辣', query: '两个女生，预算 60，在减脂，不吃辣，想低卡又划算', constraints: { budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'] } },
  { label: '一人省钱 · 不设热量', query: '我一个人，预算 40，想吃顿划算的', constraints: { budget: 40, calorie_limit: null, people: 1, excluded: [] } },
  { label: '多人 · 多重忌口', query: '三个人，预算 80，不吃辣和牛肉', constraints: { budget: 80, calorie_limit: 1000, people: 3, excluded: ['辣', '牛肉'] } },
];

export const DEFAULT_STORE = {
  code: '1450713',
  name: '麦当劳上海黄浦华旭国际大厦餐厅',
  address: '西藏中路336号',
};
