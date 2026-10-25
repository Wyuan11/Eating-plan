/**
 * 麦门智选助手 · 确定性求解器（Schema v1 输出）
 *
 * 设计原则（答辩核心论点）：
 *   LLM 只负责把自然语言翻译成结构化约束；价格、热量、组合寻优全部由这里算。
 *   大模型做加法会错，所以数值一律由本文件产出 —— 这是"保证不超标"的唯一来源。
 *
 * 另一条底线：只使用 calorie_source === 'official' 的可信池。
 *   官方未公布营养数据的新品（龙焰系列、枫糖厚松饼堡…）一律不参与求解，
 *   宁可少选也不估算 —— 热量数据必须 100% 可核验。
 *
 * CLI:
 *   node server/solver.js --budget 60 --calorie 1200 --people 2 --exclude 辣
 *   node server/solver.js --budget 60 --people 2 --out web/mock/plan.success.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------- 输入归一化

/** 只保留可信池：单品 + 官方热量 + 在售 */
function trustedPool(items) {
  return items.filter(
    (i) => i.kind === 'single' && i.calorie_source === 'official' && i.available !== false
  );
}

/** 忌口过滤：tag 精确命中 or 品名包含关键词 */
function applyExclusions(items, excluded = []) {
  if (!excluded.length) return items;
  return items.filter((i) => {
    const tags = i.tags || [];
    if (tags.some((t) => excluded.includes(t))) return false;
    return !excluded.some((k) => i.name.includes(k));
  });
}

// ---------------------------------------------------------------- 组合枚举

const MAIN = ['主食'];
const SIDE = ['小食', '饮品', '甜品'];

function combos(arr, k) {
  const out = [];
  (function dfs(start, cur) {
    if (cur.length === k) return out.push(cur.slice());
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      dfs(i + 1, cur);
      cur.pop();
    }
  })(0, []);
  return out;
}

/** 生成所有满足硬约束的候选套餐（含去重剪枝） */
function* enumerate(pool, people, budget, calorieLimit, maxSides = 3) {
  const mains = pool.filter((i) => MAIN.includes(i.category));
  const sides = pool.filter((i) => SIDE.includes(i.category));
  if (mains.length < 1) return;

  const mainSets = combos(mains, Math.min(people, mains.length));
  // 配餐 0..maxSides 件
  const sideSets = [[]];
  for (let k = 1; k <= Math.min(maxSides, sides.length); k++) {
    sideSets.push(...combos(sides, k));
  }

  for (const ms of mainSets) {
    const basePrice = ms.reduce((s, i) => s + i.price, 0);
    const baseCal = ms.reduce((s, i) => s + i.calorie, 0);
    if (basePrice > budget) continue;
    if (calorieLimit != null && baseCal > calorieLimit) continue;

    for (const ss of sideSets) {
      const price = basePrice + ss.reduce((s, i) => s + i.price, 0);
      if (price > budget) continue;
      const cal = baseCal + ss.reduce((s, i) => s + i.calorie, 0);
      if (calorieLimit != null && cal > calorieLimit) continue;
      yield [...ms, ...ss];
    }
  }
}

// ---------------------------------------------------------------- 评分

function summarize(items, constraints) {
  const qty = new Map();
  for (const i of items) qty.set(i.code, (qty.get(i.code) || 0) + 1);
  const list = [...qty.entries()].map(([code, n]) => {
    const src = items.find((i) => i.code === code);
    return { ...src, quantity: n };
  });

  const total_price = round2(list.reduce((s, i) => s + i.price * i.quantity, 0));
  const original_price = round2(list.reduce((s, i) => s + (i.original_price ?? i.price) * i.quantity, 0));
  const total_calorie = list.reduce((s, i) => s + i.calorie * i.quantity, 0);
  const nutrition = { protein: 0, fat: 0, carbohydrate: 0, sodium: 0, calcium: 0 };
  for (const i of list) {
    if (i.nutrition) {
      for (const k of Object.keys(nutrition)) nutrition[k] += i.nutrition[k] * i.quantity;
    }
  }
  const budget = constraints.budget;
  const limit = constraints.calorie_limit;
  return {
    list,
    plan: {
      total_price,
      total_calorie,
      original_price,
      saved: round2(original_price - total_price),
      budget_usage: budget ? `${Math.round((total_price / budget) * 100)}%` : '—',
      calorie_usage: limit ? `${Math.round((total_calorie / limit) * 100)}%` : '—',
    },
    nutrition,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 均衡分：预算利用 × 热量贴合 × 品类齐全 × 蛋白占比 × 省得更多 */
function balancedScore(s, constraints) {
  const budget = constraints.budget;
  const limit = constraints.calorie_limit;

  const budgetFit = budget ? 1 - Math.abs(budget - s.plan.total_price) / budget : 0.5;

  let calFit;
  if (limit) {
    // 减脂场景：吃到上限的 80% 最理想（吃得饱又留余量）
    calFit = 1 - Math.abs(s.plan.total_calorie - limit * 0.8) / limit;
  } else {
    calFit = 1 - Math.min(1, s.plan.total_calorie / 2500);
  }

  const cats = new Set(s.list.map((i) => i.category));
  const variety = Math.min(1, cats.size / 3);

  const proteinRatio = s.plan.total_calorie ? (s.nutrition.protein * 4) / s.plan.total_calorie : 0;
  const proteinFit = Math.min(1, proteinRatio / 0.22);

  const savedFit = s.plan.original_price
    ? Math.min(1, s.plan.saved / Math.max(1, s.plan.original_price * 0.2))
    : 0;

  return (
    budgetFit * 0.3 + calFit * 0.3 + variety * 0.2 + proteinFit * 0.1 + savedFit * 0.1
  );
}

// ---------------------------------------------------------------- 主入口

/**
 * @param {Array} menuItems  web/mock/menu.json 的 items（或 MCP 实时菜单归一化后）
 * @param {Object} c         { budget, calorie_limit?, people?, excluded? }
 * @returns Schema v1 的 PlanSuccess | PlanNoSolution
 */
function solve(menuItems, c) {
  const constraints = {
    budget: Number(c.budget),
    calorie_limit: c.calorie_limit == null ? null : Number(c.calorie_limit),
    people: Math.max(1, Number(c.people) || 1),
    excluded: c.excluded || [],
  };

  const meta = { storeCode: c.storeCode, storeName: c.storeName, generatedAt: new Date().toISOString() };
  const fail = (reason, conflict, hint) => ({
    success: false,
    message: '约束过严，无法生成可行方案',
    reason,
    conflict,
    hint,
    constraints,
    source_note: '数据来自麦当劳官方 MCP 实时菜单与营养表',
    meta,
  });

  if (!constraints.budget || constraints.budget <= 0) {
    return { success: false, message: '参数错误', error: { code: 'BAD_REQUEST', detail: 'budget 必须大于 0', retryable: false }, meta };
  }

  const pool = applyExclusions(trustedPool(menuItems), constraints.excluded);
  const mains = pool.filter((i) => MAIN.includes(i.category));

  // 硬门槛：每人至少一份主食
  if (mains.length < constraints.people) {
    return fail(
      `${constraints.people} 人用餐至少需要 ${constraints.people} 份主食，当前门店可信主食仅 ${mains.length} 款`,
      '忌口 vs 人数',
      '放宽忌口条件，或减少人数'
    );
  }
  const cheapestMain = Math.min(...mains.map((i) => i.price));
  const minCost = round2(cheapestMain * constraints.people);
  if (minCost > constraints.budget) {
    return fail(
      `${constraints.people} 人用餐最少需要 ${constraints.people} 份主食，当前门店最便宜的主食为 ${mains.find((i) => i.price === cheapestMain).name} ${cheapestMain} 元，${constraints.people} 份已需 ${minCost} 元，超出 ${constraints.budget} 元预算`,
      '预算 vs 人数',
      `把预算提高到 ${minCost} 元以上，或把人数调整为 1 人（单人最低可行方案约 ${cheapestMain} 元）`
    );
  }
  if (constraints.calorie_limit != null) {
    const cheapestCal = Math.min(...mains.map((i) => i.calorie));
    if (cheapestCal * constraints.people > constraints.calorie_limit) {
      return fail(
        `${constraints.people} 份主食的最低热量已达 ${cheapestCal * constraints.people} 大卡，超过 ${constraints.calorie_limit} 大卡上限`,
        '热量 vs 人数',
        `把热量上限提高到 ${cheapestCal * constraints.people} 大卡以上，或减少人数`
      );
    }
  }

  // 枚举 + 三种目标各取最优
  let best = null;
  let cheapest = null;
  let lightest = null;
  let count = 0;

  for (const items of enumerate(pool, constraints.people, constraints.budget, constraints.calorie_limit)) {
    count++;
    const s = summarize(items, constraints);
    const sc = balancedScore(s, constraints);
    if (!best || sc > best.sc) best = { sc, s };
    if (!cheapest || s.plan.total_price < cheapest.s.plan.total_price) cheapest = { sc, s };
    if (!lightest || s.plan.total_calorie < lightest.s.plan.total_calorie) lightest = { sc, s };
  }

  if (!best) {
    return fail(
      `在预算 ${constraints.budget} 元${constraints.calorie_limit ? `、热量 ${constraints.calorie_limit} 大卡` : ''}内，可信餐品无法组成满足 ${constraints.people} 人用餐的方案`,
      '预算 vs 热量 vs 人数',
      '提高预算或热量上限，或减少人数'
    );
  }

  const toPlanItem = (i) => ({
    code: i.code, name: i.name, price: i.price,
    calorie: i.calorie, calorie_source: i.calorie_source,
    category: i.category, quantity: i.quantity,
    nutrition: i.nutrition ?? null, tags: i.tags ?? [],
  });

  const toAlt = (label, x) => ({
    label,
    total_price: x.s.plan.total_price,
    total_calorie: x.s.plan.total_calorie,
    items: x.s.list.map((i) => ({ name: i.name, price: i.price, calorie: i.calorie })),
  });

  const main = best.s;
  const alternatives = [];
  const seen = new Set([sig(main.list)]);
  for (const [label, x] of [['更省钱的', cheapest], ['更低卡的', lightest]]) {
    const k = sig(x.s.list);
    if (!seen.has(k)) { alternatives.push(toAlt(label, x)); seen.add(k); }
  }

  return {
    success: true,
    message: '推荐完成',
    constraints,
    plan: main.plan,
    items: main.list.map(toPlanItem),
    nutrition: main.nutrition,
    alternatives,
    suggestion: buildSuggestion(main, constraints, count),
    source_note: '数据来自麦当劳官方 MCP 实时菜单与营养表',
    meta: { ...meta, traceId: `solver-${Date.now()}`, candidates: count },
  };
}

function sig(list) {
  return list.map((i) => `${i.code}x${i.quantity}`).sort().join('|');
}

function buildSuggestion(s, c, count) {
  const p = s.plan;
  const parts = [`共 ${s.list.length} 件，实付 ${p.total_price} 元，占预算 ${p.budget_usage}。`];
  if (c.calorie_limit) parts.push(`热量 ${p.total_calorie} 大卡，占上限 ${p.calorie_usage}。`);
  parts.push(`蛋白质 ${s.nutrition.protein}g / 碳水 ${s.nutrition.carbohydrate}g / 脂肪 ${s.nutrition.fat}g。`);
  if (p.saved > 0) parts.push(`已享优惠省下 ${p.saved} 元。`);
  parts.push(
    `本方案在 ${count} 个可行组合中选出，热量与价格均为官方数据精确累加，不含估算值——` +
      `官方尚未公布营养数据的新品（如龙焰系列）未参与计算，这是刻意的。`
  );
  return parts.join('');
}

// ---------------------------------------------------------------- CLI

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const menuFile = arg('menu', path.join(ROOT, 'web/mock/menu.json'));
  const out = arg('out', null);
  const excluded = arg('exclude', '') ? arg('exclude').split(/[,，\s]+/).filter(Boolean) : [];
  const constraints = {
    budget: Number(arg('budget', 60)),
    calorie_limit: arg('calorie', null) == null ? null : Number(arg('calorie')),
    people: Number(arg('people', 1)),
    excluded,
  };

  const menu = JSON.parse(fs.readFileSync(menuFile, 'utf8'));
  const storeCodeArg = arg('store', menu.store?.code || '1450713');
  const t0 = Date.now();
  const res = solve(menu.items, { ...constraints, storeCode: menu.store?.code || storeCodeArg, storeName: menu.store?.name });
  if (res.meta) res.meta.elapsedMs = Date.now() - t0;

  const json = JSON.stringify(res, null, 2);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(ROOT, out)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, out), json, 'utf8');
    console.log(`已写入 ${out}`);
  }
  if (res.success) {
    console.log(`方案：${res.items.map((i) => `${i.name}×${i.quantity}`).join(' + ')}`);
    console.log(`合计 ¥${res.plan.total_price} / ${res.plan.total_calorie} kcal  预算${res.plan.budget_usage} 热量${res.plan.calorie_usage}`);
    console.log(`营养：蛋白 ${res.nutrition.protein}g 脂肪 ${res.nutrition.fat}g 碳水 ${res.nutrition.carbohydrate}g 钠 ${res.nutrition.sodium}mg`);
    console.log(`备选：${res.alternatives.map((a) => `${a.label}(¥${a.total_price}/${a.total_calorie}kcal)`).join('  ')}`);
  } else {
    console.log(`无解：${res.reason}\n建议：${res.hint || res.error?.detail}`);
  }
}

module.exports = { solve, trustedPool, applyExclusions, summarize };

if (require.main === module) main();
