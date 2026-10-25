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

/** 忌口可选项（品名/标签子串 + 忌口特征词匹配），与后端 excluded 语义对齐 */
export const EXCLUDE_OPTIONS = ['辣', '牛肉', '猪肉', '鸡肉', '鱼', '海鲜', '洋葱', '葱', '蒜', '蛋', '奶', '花生', '芝麻', '坚果', '芥末', '香菜'];

export const DEFAULT_STORE = {
  code: '1450713',
  name: '麦当劳上海黄浦华旭国际大厦餐厅',
  address: '西藏中路336号',
};
