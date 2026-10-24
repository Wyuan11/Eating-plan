/**
 * 独立算术校验 —— 前端唯一的"业务"：拿到 plan 后重新累加，与声明值比对。
 *
 * 背景（答辩核心论点）：大模型做加法会错。所以 AI 负责语义理解与决策，
 * 确定性代码守住数值正确性。前端不信任 Skill 声明的 total_price / total_calorie，
 * 而是从 items 逐项重算，两者一致才亮"已校验 ✓"，不一致以重算值为准。
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 从 items 逐项重算总价 / 总热量 / 营养 */
export function recompute(items = []) {
  let total_price = 0;
  let total_calorie = 0;
  let unknownCalorieCount = 0;
  const nutrition = { protein: 0, fat: 0, carbohydrate: 0, sodium: 0 };

  for (const it of items) {
    const qty = it.quantity || 1;
    total_price += (it.price || 0) * qty;
    if (it.calorie == null) {
      unknownCalorieCount += qty;
    } else {
      total_calorie += it.calorie * qty;
    }
    if (it.nutrition) {
      for (const k of Object.keys(nutrition)) {
        nutrition[k] += (it.nutrition[k] || 0) * qty;
      }
    }
  }

  return {
    total_price: round2(total_price),
    total_calorie: round2(total_calorie),
    nutrition: Object.fromEntries(Object.entries(nutrition).map(([k, v]) => [k, round2(v)])),
    unknownCalorieCount,
  };
}

const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.01;

/**
 * 校验结果 -> 供 UI 渲染的判定
 * @returns {{
 *   computed: ReturnType<typeof recompute>,
 *   priceMatch: boolean, calorieMatch: boolean, nutritionMatch: boolean,
 *   priceOver: boolean, calorieOver: boolean,
 *   verified: boolean, note: string|null,
 * }}
 */
export function verify(result) {
  if (!result || result.success !== true) return null;

  const computed = recompute(result.items);
  const declared = result.plan || {};
  const constraints = result.constraints || {};

  const priceMatch = near(computed.total_price, declared.total_price);
  // 有 null 热量时，声明值只可能 >= 重算值（重算按 0 跳过），视为"部分可核验"
  const calorieMatch =
    computed.unknownCalorieCount === 0 && near(computed.total_calorie, declared.total_calorie);

  const nutrition = result.nutrition || {};
  const nutritionMatch =
    near(computed.nutrition.protein, nutrition.protein) &&
    near(computed.nutrition.fat, nutrition.fat) &&
    near(computed.nutrition.carbohydrate, nutrition.carbohydrate);

  const priceOver = constraints.budget
    ? computed.total_price > constraints.budget
    : false;
  const calorieOver =
    constraints.calorie_limit != null
      ? computed.unknownCalorieCount === 0 && computed.total_calorie > constraints.calorie_limit
      : false;

  const verified = priceMatch && calorieMatch && nutritionMatch;

  let note = null;
  if (!priceMatch) note = 'AI 声明的总价与逐项重算不一致，已以重算值为准';
  else if (!calorieMatch)
    note = computed.unknownCalorieCount
      ? `有 ${computed.unknownCalorieCount} 件菜品热量未公布，总热量无法完全核验`
      : 'AI 声明的总热量与逐项重算不一致，已以重算值为准';
  else if (!nutritionMatch) note = '营养总和与声明值不一致，已以重算值为准';

  return {
    computed,
    priceMatch,
    calorieMatch,
    nutritionMatch,
    priceOver,
    calorieOver,
    verified,
    note,
  };
}
