'use strict';
// Schema v1 compatible. Pure, offline solver: never calls MCP or creates orders.
const fs = require('node:fs');
const path = require('node:path');
const NUTRIENTS = ['protein', 'fat', 'carbohydrate', 'sodium', 'calcium'];
const CATEGORIES = ['主食', '小食', '饮品', '甜品'];
const OBJECTIVES = ['balanced', 'cheapest', 'lowest_calorie', 'max_value'];
const OBJECTIVE_LABELS = { balanced: '均衡推荐', cheapest: '省钱优先', lowest_calorie: '最低卡', max_value: '预算吃满' };
/** 策略一句话说明（前端直接展示，告诉用户这套方案在优化什么） */
const OBJECTIVE_STRATEGY = {
  cheapest: '总价最低，把预算省下来',
  balanced: '预算、热量、营养、多样性综合最优',
  max_value: '预算吃满，份量最足',
  lowest_calorie: '总热量最低',
};
/** 旧契约/别名归一：文档里出现过 lowest_price，前端也可能传 save / lowcal */
const OBJECTIVE_ALIASES = { lowest_price: 'cheapest', save: 'cheapest', lowcal: 'lowest_calorie', value: 'max_value', max_value: 'max_value' };
/** 多方案的排列优先级：主方案放第一，其余按「省钱 → 吃满 → 均衡 → 最低卡」取满 3 个 */
const PLAN_ORDER = ['cheapest', 'max_value', 'balanced', 'lowest_calorie'];
const round = n => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
const numeric = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function toFen(n) {
  if (!numeric(n) || !Number.isSafeInteger(Math.round(n * 100)) || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    throw new Error('金额必须为非负有限数，最多两位小数');
  }
  return Math.round(n * 100);
}
function trustedPool(items) {
  return items.filter(i => i.kind === 'single' && i.calorie_source === 'official' && i.available !== false);
}
// 品类级忌口：用户说「不要饮料/甜点/小吃」时按 category 整类过滤。
// 品类口径与菜单一致：主食/小食/饮品/甜品；同义词归一到菜单用词。
const CATEGORY_ALIASES = { '饮料': '饮品', '饮品': '饮品', '甜点': '甜品', '甜品': '甜品', '小吃': '小食', '小食': '小食' };
/** 温度类忌口：菜单若有 temperature 字段（cold/hot/any）才可执行；否则只能如实披露 */
const TEMP_KEYWORDS = { '冰饮': 'cold', '冰的': 'cold', '冰镇': 'cold', '冷饮': 'cold', '热饮': 'hot', '热的': 'hot' };
const TEMP_WORDS_RE = /(冰饮|冰的|冰镇|冷饮|热饮|热的)/;

function applyExclusions(items, excluded = []) {
  const bannedCats = new Set(excluded.map(k => CATEGORY_ALIASES[k]).filter(Boolean));
  const bannedTemps = new Set(excluded.map(k => TEMP_KEYWORDS[k]).filter(Boolean));
  return items.filter(i => {
    if (bannedCats.has(i.category)) return false;
    // 温度忌口：只对「菜单明确标了 temperature」的商品生效，没有温度数据的一律不动（不猜）
    if (bannedTemps.size && i.temperature && bannedTemps.has(i.temperature)) return false;
    return !excluded.some(k => {
      // Exact tag matching: 不辣 is not 辣. Remove the literal negation in names only.
      const name = k === '辣' ? i.name.replace(/不辣/g, '') : i.name;
      return (i.tags || []).includes(k) || name.includes(k);
    });
  });
}
/** The ONLY aggregation source. Input entries use unit price/calorie and quantity. */
function summarize(items, constraints = {}) {
  const groups = new Map();
  for (const item of items) {
    const q = item.quantity === undefined ? 1 : item.quantity;
    if (!Number.isSafeInteger(q) || q <= 0) throw new Error('quantity 必须为正整数');
    const old = groups.get(item.code);
    if (old) old.quantity += q;
    else groups.set(item.code, { ...item, quantity: q });
  }
  const list = [...groups.values()].sort((a, b) => a.code.localeCompare(b.code, 'en'));
  let priceFen = 0, originalFen = 0, calorie = 0, couponFen = 0;
  const nutrition = Object.fromEntries(NUTRIENTS.map(k => [k, 0]));
  for (const i of list) {
    if (i.calorie_source !== 'official' || !numeric(i.calorie)) throw new Error('汇总拒绝未知或无效热量');
    priceFen += toFen(i.price) * i.quantity;
    originalFen += toFen(i.original_price ?? i.price) * i.quantity;
    calorie += i.calorie * i.quantity;
    // 券后价：只有券模块【确定命中】该商品时才存在 coupon 字段，saved 是真实券后价与促销价之差
    if (i.coupon && numeric(i.coupon.saved)) couponFen += toFen(i.coupon.saved) * i.quantity;
    for (const k of NUTRIENTS) {
      if (!numeric(i.nutrition?.[k])) throw new Error(`缺失或无效营养数据: ${k}`);
      nutrition[k] += i.nutrition[k] * i.quantity;
    }
  }
  if (!Number.isSafeInteger(priceFen) || !Number.isSafeInteger(originalFen)) throw new Error('金额超出安全整数范围');
  for (const k of NUTRIENTS) nutrition[k] = round(nutrition[k]);
  return { list, priceFen, originalFen, nutrition, couponFen, plan: {
    total_price: priceFen / 100, total_calorie: round(calorie), original_price: originalFen / 100,
    saved: (originalFen - priceFen) / 100,
    // saved 里含券省的部分单独拆出来，前端才能说清「省的钱里有多少来自券」
    coupon_saved: couponFen / 100,
    price_before_coupon: (priceFen + couponFen) / 100,
    budget_usage: constraints.budget > 0 ? `${Math.round(priceFen / toFen(constraints.budget) * 100)}%` : '—',
    calorie_usage: constraints.calorie_limit != null ? `${Math.round(calorie / constraints.calorie_limit * 100)}%` : '—',
  } };
}
function* combinations(items, count, tick, start = 0, cur = []) {
  tick();
  if (cur.length === count) { yield cur.slice(); return; }
  for (let i = start; i < items.length; i++) {
    cur.push(items[i]);
    yield* combinations(items, count, tick, i, cur); // i, not i+1: repetitions allowed
    cur.pop();
  }
}
function signature(s) { return s.list.map(i => `${i.code}x${i.quantity}`).join('|'); }
/** 预算吃满：在约束内尽量用足预算，同时兼顾多样性与蛋白占比，避免纯粹堆价格 */
function valueScore(s, c) {
  const p = s.plan;
  const budgetFit = s.priceFen / toFen(c.budget); // 已过滤超预算组合，恒 <= 1
  const variety = Math.min(1, new Set(s.list.map(i => i.category)).size / 3);
  const protein = p.total_calorie ? Math.min(1, s.nutrition.protein * 4 / p.total_calorie / 0.22) : 0;
  return Math.min(1, budgetFit) * 0.55 + variety * 0.25 + protein * 0.2;
}
function balancedScore(s, c) {
  const p = s.plan;
  const budgetFit = s.priceFen / toFen(c.budget);
  const calFit = c.calorie_limit != null ? 1 - Math.abs(p.total_calorie - c.calorie_limit * 0.8) / c.calorie_limit : 1 - Math.min(1, p.total_calorie / (1250 * c.people));
  const variety = Math.min(1, new Set(s.list.map(i => i.category)).size / 3);
  const protein = p.total_calorie ? Math.min(1, s.nutrition.protein * 4 / p.total_calorie / 0.22) : 0;
  const savings = s.originalFen ? Math.max(0, Math.min(1, (s.originalFen - s.priceFen) / (s.originalFen * 0.2))) : 0;
  return budgetFit * 0.3 + calFit * 0.3 + variety * 0.2 + protein * 0.1 + savings * 0.1;
}
function solve(menuItems, c = {}, options = {}) {
  const meta = { ...(c.storeCode ? { storeCode: c.storeCode } : {}), ...(c.storeName ? { storeName: c.storeName } : {}), generatedAt: new Date().toISOString(), traceId: `solver-${require('node:crypto').randomUUID()}` };
  const error = (code, detail) => ({ success: false, message: '求解失败', error: { code, detail, retryable: false }, meta });
  const constraints = { budget: c.budget, calorie_limit: c.calorie_limit ?? null, people: c.people ?? 1, excluded: c.excluded ?? [], wants: c.wants ?? [] };
  const fail = (reason, conflict, hint) => ({ success: false, message: '约束过严，无法生成可行方案', reason, conflict, hint, constraints, source_note: '基于输入菜单快照及其标注的官方营养数据；未实时核价', meta });
  try {
    if (!Array.isArray(menuItems)) return error('BAD_REQUEST', 'menuItems 必须为数组');
    if (!numeric(constraints.budget) || constraints.budget <= 0) return error('BAD_REQUEST', 'budget 必须大于 0');
    const budgetFen = toFen(constraints.budget);
    if (!Number.isInteger(constraints.people) || constraints.people < 1 || constraints.people > 6) return error('BAD_REQUEST', 'people 必须为 1～6 的整数');
    if (constraints.calorie_limit !== null && (!numeric(constraints.calorie_limit) || constraints.calorie_limit <= 0)) return error('BAD_REQUEST', 'calorie_limit 必须为正数或 null');
    if (!Array.isArray(constraints.excluded) || constraints.excluded.some(k => typeof k !== 'string' || !k.trim())) return error('BAD_REQUEST', 'excluded 必须为非空字符串数组');
    constraints.excluded = [...new Set(constraints.excluded.map(k => k.trim()))];
    // 正向诉求（想吃 X × N）：数量是硬约束，不是提示——「一个冰淇淋」就只能是 1 个
    if (!Array.isArray(constraints.wants)) return error('BAD_REQUEST', 'wants 必须为数组');
    constraints.wants = constraints.wants
      .map(w => (typeof w === 'string' ? { keyword: w, qty: 1 } : { keyword: String(w?.keyword ?? '').trim(), qty: Math.floor(Number(w?.qty ?? 1)) }))
      .filter(w => w.keyword);
    for (const w of constraints.wants) {
      if (!Number.isInteger(w.qty) || w.qty < 1 || w.qty > 12) return error('BAD_REQUEST', `wants[].qty 必须为 1~12 的整数：${w.keyword}`);
    }
    { // 同名诉求合并数量
      const wm = new Map();
      for (const w of constraints.wants) wm.set(w.keyword, (wm.get(w.keyword) || 0) + w.qty);
      constraints.wants = [...wm].map(([keyword, qty]) => ({ keyword, qty }));
    }
    const maxNodes = options.maxNodes ?? 2000000;
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) return error('BAD_REQUEST', 'maxNodes 必须为正整数');
    const objective = OBJECTIVE_ALIASES[c.objective] || (c.objective ?? 'balanced');
    if (!OBJECTIVES.includes(objective)) return error('BAD_REQUEST', `objective 必须为 ${OBJECTIVES.join(' / ')}`);
    const seen = new Set();
    const trusted = trustedPool(menuItems).filter(i => CATEGORIES.includes(i.category));
    // Validate trusted inputs instead of silently converting missing values to zero.
    for (const i of trusted) {
      if (typeof i.code !== 'string' || !i.code || typeof i.name !== 'string' || !i.name) throw new Error('商品 code/name 无效');
      if (seen.has(i.code)) throw new Error(`商品编码重复: ${i.code}`);
      seen.add(i.code);
      if (!Array.isArray(i.tags) || i.tags.some(t => typeof t !== 'string')) throw new Error(`商品标签无效: ${i.code}`);
      summarize([i]);
    }
    let pool = applyExclusions(trusted, constraints.excluded).sort((a, b) => a.code.localeCompare(b.code, 'en'));
    // 优惠券：券后价替换进候选池，预算判定随之变成「券后价 ≤ 预算」。
    // 只有能唯一确定匹配到在售单品、且券后价确实更低的券才会 applied，其余一律 skipped + 真实原因。
    const couponInput = Array.isArray(c.coupons) ? c.coupons : [];
    const couponReport = couponInput.length
      ? require('./coupons').applyCoupons(pool, couponInput, { now: options.now ?? new Date(), channel: options.channel ?? '到店' })
      : { pool, applied: [], skipped: [] };
    pool = couponReport.pool;
    const matchesWant = (i, w) => i.name.includes(w.keyword) || (i.tags || []).includes(w.keyword);
    // 正向诉求匹配：在忌口过滤后的池里找；找不到时区分「菜单没有」与「被忌口过滤」
    const wantMatches = constraints.wants.map(w => {
      const inPool = pool.filter(i => matchesWant(i, w));
      const inTrusted = trusted.filter(i => matchesWant(i, w));
      return { ...w, inPool, blocked: inPool.length === 0 && inTrusted.length > 0 };
    });
    for (const w of wantMatches) {
      if (w.inPool.length) continue;
      return fail(
        `菜单${w.blocked ? '内符合忌口筛选的商品中没' : '里没'}有「${w.keyword}」，正向诉求无法满足`,
        w.blocked ? '正向诉求 vs 忌口' : '正向诉求 vs 菜单',
        w.blocked
          ? `「${w.keyword}」被忌口（${constraints.excluded.join('、') || '—'}）过滤了；确认是否真的不吃这类商品，或去掉相关忌口`
          : '换一家门店，或核对商品名称'
      );
    }
    // 数量硬约束：每种诉求的匹配商品总数量必须恰好等于 qty（「一个冰淇淋」≠ 两个）
    const wantsOK = s => wantMatches.every(w =>
      s.list.reduce((n, i) => n + (matchesWant(i, w) ? i.quantity : 0), 0) === w.qty
    );

    // 一人两杯咖啡不合理：饮品/甜品每人最多 1 件。
    // 用户点名要的数量（wants）在 people 基础上额外放宽，避免与数量硬约束互相打架。
    const CAPPED_CATEGORIES = ['饮品', '甜品'];
    const extraByCat = {};
    for (const w of wantMatches) {
      for (const cat of new Set(w.inPool.map(i => i.category))) {
        if (CAPPED_CATEGORIES.includes(cat)) extraByCat[cat] = (extraByCat[cat] || 0) + w.qty;
      }
    }
    const capOf = cat => constraints.people + (extraByCat[cat] || 0);
    const withinCategoryCap = s => CAPPED_CATEGORIES.every(cat =>
      s.list.filter(i => i.category === cat).reduce((n, i) => n + i.quantity, 0) <= capOf(cat)
    );

    // 温度类忌口能否执行：菜单没有温度属性就只能如实披露，绝不替用户猜某杯是冰的
    const tempExclusions = constraints.excluded.filter(k => TEMP_KEYWORDS[k]);
    const hasTempData = trusted.some(i => i.temperature);
    const notes = [];
    if (tempExclusions.length) {
      if (!hasTempData) {
        notes.push({
          text: `不要${tempExclusions.map(k => k.replace(/的$/, '')).join('、')}`,
          reason: '菜单快照没有温度属性数据，该忌口无法参与求解（未替你过滤任何商品，也未伪造冷热判断）',
        });
      } else {
        const unknown = trusted.filter(i => i.category === '饮品' && !i.temperature).length;
        notes.push({
          text: `不要${tempExclusions.map(k => k.replace(/的$/, '')).join('、')}`,
          reason: `已按菜单 temperature 字段过滤标注为冰饮的商品；另有 ${unknown} 件饮品未标注温度（无冰量选项≠已知冷热），未做处理`,
        });
      }
    }
    // 券的披露：生效了几张、没生效的为什么。券接口不返回券码，实付必须以核价为准，这里不做承诺。
    if (couponInput.length) {
      if (couponReport.applied.length) {
        notes.push({
          text: `已按券后价应用 ${couponReport.applied.length} 张券（${couponReport.applied.map(a => a.title).join('、')}）`,
          reason: '券后价参与组合筛选与预算判定；券接口不返回券码，下单时无法传给核价接口，实付金额以 MCP 实时核价为准',
        });
      } else {
        const reasons = couponReport.skipped.slice(0, 2).map(s => `${s.title}：${s.reason}`);
        notes.push({
          text: `账户里有 ${couponInput.length} 张券，本方案未使用任何一张`,
          reason: `${reasons.join('；')}${couponReport.skipped.length > 2 ? `；另有 ${couponReport.skipped.length - 2} 张同理` : ''}。未生效的券一律按原价计算，不虚报优惠`,
        });
      }
    }
    const mains = pool.filter(i => i.category === '主食');
    const sides = pool.filter(i => i.category !== '主食');
    if (!mains.length) return fail('过滤后没有可用的官方营养主食，无法满足每人一份主食', '可信主食 vs 忌口', '尝试更换门店；仅在符合本人需求时放宽口味偏好，不建议放宽过敏限制');
    let nodes = 0, candidates = 0;
    const tick = () => { if (++nodes > maxNodes) { const e = new Error('搜索节点超过上限；请减少人数或缩小菜单，未证明无解'); e.limit = true; throw e; } };
    // Evaluate main-only combinations to obtain exact conditional relaxation thresholds.
    let minPrice = Infinity, minCal = Infinity, budgetNeeded = Infinity, calorieNeeded = Infinity;
    let best = null, cheapest = null, lightest = null, bestScore = -Infinity, bestValue = null, bestValueScore = -Infinity;
    function consider(s) {
      candidates++;
      const key = signature(s);
      const score = balancedScore(s, constraints);
      if (!best || score > bestScore || (score === bestScore && key < signature(best))) { best = s; bestScore = score; }
      const vScore = valueScore(s, constraints);
      if (!bestValue || vScore > bestValueScore || (vScore === bestValueScore && key < signature(bestValue))) { bestValue = s; bestValueScore = vScore; }
      if (!cheapest || s.priceFen < cheapest.priceFen || (s.priceFen === cheapest.priceFen && (s.plan.total_calorie < cheapest.plan.total_calorie || (s.plan.total_calorie === cheapest.plan.total_calorie && key < signature(cheapest))))) cheapest = s;
      if (!lightest || s.plan.total_calorie < lightest.plan.total_calorie || (s.plan.total_calorie === lightest.plan.total_calorie && (s.priceFen < lightest.priceFen || (s.priceFen === lightest.priceFen && key < signature(lightest))))) lightest = s;
    }
    const sideSets = [[]];
    for (let k = 1; k <= 3; k++) for (const ss of combinations(sides, k, tick)) sideSets.push(ss);
    for (const ms of combinations(mains, constraints.people, tick)) {
      const base = summarize(ms, constraints);
      minPrice = Math.min(minPrice, base.priceFen);
      minCal = Math.min(minCal, base.plan.total_calorie);
      const calOK = constraints.calorie_limit === null || base.plan.total_calorie <= constraints.calorie_limit;
      if (calOK) budgetNeeded = Math.min(budgetNeeded, base.priceFen);
      if (base.priceFen <= budgetFen) calorieNeeded = Math.min(calorieNeeded, base.plan.total_calorie);
      if (base.priceFen > budgetFen || !calOK) continue;
      for (const ss of sideSets) {
        tick();
        const s = ss.length ? summarize([...ms, ...ss], constraints) : base;
        if (s.priceFen > budgetFen) continue;
        if (constraints.calorie_limit !== null && s.plan.total_calorie > constraints.calorie_limit) continue;
        if (!wantsOK(s)) continue; // 正向诉求数量不满足的组合直接淘汰
        if (!withinCategoryCap(s)) continue; // 一人两杯饮品/甜品不合理
        consider(s);
      }
    }
    if (!best) {
      const hints = [];
      if (Number.isFinite(budgetNeeded) && budgetNeeded > budgetFen) hints.push(`保留当前热量上限，预算提高到 ${budgetNeeded / 100} 元即可组成主食方案`);
      if (Number.isFinite(calorieNeeded) && constraints.calorie_limit !== null && calorieNeeded > constraints.calorie_limit) hints.push(`保留当前预算，热量上限提高到 ${calorieNeeded} kcal 即可组成主食方案`);
      if (!hints.length) hints.push('单独放宽预算或热量都不足以满足约束，请同时调整两项或减少人数');
      if (wantMatches.length) hints.push(`正向诉求（${wantMatches.map(w => `${w.keyword}×${w.qty}`).join('、')}）也在参与筛选：数量改小一点，或放宽预算/热量后再试`);
      const conflict = minPrice > budgetFen && constraints.calorie_limit !== null && minCal > constraints.calorie_limit ? '预算 vs 热量 vs 人数' : minPrice > budgetFen ? '预算 vs 人数' : constraints.calorie_limit !== null && minCal > constraints.calorie_limit ? '热量 vs 人数' : '预算 vs 热量';
      return fail(`在当前可信单品池内，${constraints.people} 份主食的最低价格为 ${minPrice / 100} 元，最低热量为 ${minCal} kcal（两项下界可能来自不同组合）；当前约束下没有可行组合`, conflict, hints.join('；'));
    }
    // v1.2: objective 决定「哪个策略的方案排第一」，其余策略按 PLAN_ORDER 补足，最多 3 个。
    // 同一套组合不会重复出现（按 items 签名去重），所以可能是 1～3 个方案。
    const normObjective = OBJECTIVE_ALIASES[objective] || objective;
    const picks = { balanced: best, cheapest, lowest_calorie: lightest, max_value: bestValue };
    const top = picks[normObjective] || best;
    const toPlanItem = i => ({ code: i.code, name: i.name, price: i.price, calorie: i.calorie, calorie_source: i.calorie_source, category: i.category, quantity: i.quantity, nutrition: i.nutrition, tags: i.tags, ...(i.coupon ? { coupon: i.coupon } : {}) });
    const describe = (key, s) => {
      const dPrice = round((top.plan.total_price - s.plan.total_price));
      const dCal = top.plan.total_calorie - s.plan.total_calorie;
      if (key === 'cheapest') return dPrice > 0.009 ? `比主方案省 ¥${dPrice.toFixed(1)}` : '已是当前约束下最低总价';
      if (key === 'max_value') return `预算用到 ${s.plan.budget_usage}，共 ${s.list.reduce((n, i) => n + i.quantity, 0)} 件`;
      if (key === 'lowest_calorie') return dCal > 0 ? `比主方案少 ${dCal} kcal` : `总热量 ${s.plan.total_calorie} kcal，当前最低`;
      return '预算 / 热量 / 营养 / 多样性 综合最优';
    };
    const toPlanEntry = key => {
      const s = picks[key];
      return { key, objective: key, label: OBJECTIVE_LABELS[key], strategy: OBJECTIVE_STRATEGY[key], highlight: describe(key, s),
        plan: s.plan, items: s.list.map(toPlanItem), nutrition: s.nutrition };
    };
    const usedPlans = new Set(), plans = [];
    for (const key of [normObjective, ...PLAN_ORDER.filter(k => k !== normObjective)]) {
      if (!picks[key]) continue;
      const k = signature(picks[key]);
      if (usedPlans.has(k)) continue;
      usedPlans.add(k);
      plans.push(toPlanEntry(key));
      if (plans.length >= 3) break;
    }
    // v1.1 兼容：顶层仍是主方案；alternatives 是除主方案外的其余方案（完整 PlanItem，可下单可校验）
    const alternatives = plans.slice(1).map(p => ({ objective: p.objective, label: p.label, strategy: p.strategy, highlight: p.highlight, total_price: p.plan.total_price, total_calorie: p.plan.total_calorie, items: p.items }));
    const items = top.list.map(toPlanItem);
    const couponBlock = couponInput.length ? {
      total: couponInput.length,
      applied: couponReport.applied.map(a => ({ title: a.title, code: a.appliedTo.code, name: a.appliedTo.name, before: a.appliedTo.beforeFen / 100, after: a.appliedTo.afterFen / 100, saved: a.appliedTo.savedFen / 100 })),
      skipped: couponReport.skipped.map(s => ({ title: s.title, status: s.status, reason: s.reason })),
      // 重要：券接口不返回 couponId/couponCode，核价与下单无法带券，实付以 MCP 为准
      disclaimer: '券后价仅用于组合筛选与预算判定；下单核价不带券（接口未提供券码），实际支付金额以核价结果为准',
    } : null;
    const wantNote = wantMatches.length ? `已严格按数量包含：${wantMatches.map(w => `${w.keyword}×${w.qty}`).join('、')}。` : '';
    const couponNote = couponBlock && couponBlock.applied.length ? `已应用 ${couponBlock.applied.length} 张券，券后省 ¥${round(couponBlock.applied.reduce((n, a) => n + a.saved, 0)).toFixed(2)}。` : '';
    return { success: true, message: '推荐完成', objective: normObjective, constraints, plan: top.plan, items, nutrition: top.nutrition,
      plans, alternatives, notes, ...(couponBlock ? { coupons: couponBlock } : {}),
      suggestion: `共 ${items.reduce((n, i) => n + i.quantity, 0)} 件；在 ${candidates} 个可行组合中按「${OBJECTIVE_LABELS[objective]}」选出。搜索范围为每人恰好一份主食及 0～3 件配餐，允许重复购买；饮品与甜品每人最多一件。${wantNote}${couponNote}价格和营养由单品乘数量汇总；未知热量商品未参与。金额为菜单快照估价，下单前需重新核价。`,
      source_note: '基于输入菜单快照及其标注的官方营养数据；未实时核价', meta };
  } catch (e) {
    return error('INTERNAL_ERROR', e.limit ? e.message : `数据或计算异常: ${e.message}`);
  }
}
module.exports = { solve, trustedPool, applyExclusions, summarize, toFen, OBJECTIVES, OBJECTIVE_LABELS, OBJECTIVE_STRATEGY, OBJECTIVE_ALIASES };
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i < 0 ? d : argv[i + 1]; };
  try {
    const menu = JSON.parse(fs.readFileSync(arg('menu', path.resolve(__dirname, '../web/mock/menu.json')), 'utf8'));
    const objectiveArg = arg('objective', 'balanced');
    const wants = arg('want', '') ? arg('want').split(/[,，]+/).filter(Boolean).map(s => {
      const m = s.match(/^(.+?)(?:[x×*]\s*(\d+))?$/);
      return { keyword: m[1].trim(), qty: Number(m[2] || 1) };
    }) : [];
    const result = solve(menu.items, { budget: Number(arg('budget', 60)), people: Number(arg('people', 1)), calorie_limit: arg('calorie', null) === null ? null : Number(arg('calorie')), excluded: arg('exclude', '').split(/[,，\s]+/).filter(Boolean), wants, objective: objectiveArg, storeCode: arg('store', menu.store?.code), storeName: menu.store?.name });
    const json = JSON.stringify(result, null, 2);
    if (arg('out', null)) fs.writeFileSync(path.resolve(arg('out')), json + '\n', 'utf8');
    console.log(json);
    if (result.error) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
