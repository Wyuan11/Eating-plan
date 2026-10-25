'use strict';
/** 接口冒烟测试：起服务 → 打真实请求 → 校验三态与关键字段。 */
const assert = require('node:assert/strict');
const { toFen } = require('../server/solver');

const MENU = process.argv[2];
if (!MENU) throw new Error('用法: node test-api.js <menu.json路径>');
// 菜品数量从传入的菜单快照读，不写死：门店菜单是动态的（实测过 125→129），
// 写死数字会在刷新菜单后误报失败。
const MENU_COUNT = JSON.parse(require('node:fs').readFileSync(MENU, 'utf8')).items.length;
process.env.MENU_FILE = MENU;
process.env.PORT = '0';
const { start } = require('../server/api');

const call = async (base, route, options) => {
  const res = await fetch(base + route, options);
  return { status: res.status, headers: res.headers, body: await res.json() };
};
const post = (base, route, payload) => call(base, route, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

(async () => {
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const baseBody = { storeCode: '1450713', objective: 'balanced', constraints: { budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'] } };

  const health = await call(base, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.menu.available, true);
  assert.equal(health.body.menu.count, MENU_COUNT);

  const menuRes = await call(base, '/api/menu?storeCode=1450713');
  assert.equal(menuRes.status, 200);
  assert.equal(menuRes.body.success, true);
  assert.equal(menuRes.body.items.length, MENU_COUNT);
  assert.equal(menuRes.headers.get('access-control-allow-origin'), '*');

  // 三态之一：成功。所有汇总值必须由 items 重算复现。
  const plan = await post(base, '/api/plan', baseBody);
  assert.equal(plan.status, 200);
  assert.equal(plan.body.success, true);
  assert.equal(plan.body.objective, 'balanced');
  assert.equal(toFen(plan.body.items.reduce((s, i) => s + i.price * i.quantity, 0)), toFen(plan.body.plan.total_price));
  assert.equal(plan.body.items.reduce((s, i) => s + i.calorie * i.quantity, 0), plan.body.plan.total_calorie);

  // v1.1：三种 objective 的主方案互不相同，且备选携带 code/quantity
  const seen = new Set();
  const prices = {};
  for (const objective of ['balanced', 'cheapest', 'lowest_calorie']) {
    const r = await post(base, '/api/plan', { ...baseBody, objective });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.objective, objective);
    const key = r.body.items.map((i) => `${i.code}x${i.quantity}`).sort().join('|');
    seen.add(key);
    prices[objective] = r.body.plan.total_price;
    for (const alt of r.body.alternatives) {
      assert.ok(alt.objective && alt.label);
      assert.ok(alt.items.every((i) => i.code && Number.isInteger(i.quantity)));
      assert.equal(toFen(alt.items.reduce((s, i) => s + i.price * i.quantity, 0)), toFen(alt.total_price));
    }
  }
  assert.equal(seen.size, 3);
  assert.ok(prices.cheapest <= prices.balanced);

  // ---- v2 融合新增能力：以下任一失败都意味着「换了解法但没接通」 ----

  // 1) 正向诉求 wants：数量是硬约束，绝不能静默忽略（静默忽略会返回「成功但没有用户点名的商品」）
  const wantPlan = await post(base, '/api/plan', {
    ...baseBody,
    constraints: { ...baseBody.constraints, wants: [{ keyword: '麦香鸡', qty: 2 }] },
  });
  assert.equal(wantPlan.status, 200);
  assert.equal(wantPlan.body.success, true);
  const wantQty = wantPlan.body.items
    .filter((i) => i.name.includes('麦香鸡'))
    .reduce((n, i) => n + i.quantity, 0);
  assert.equal(wantQty, 2, '正向诉求数量必须是硬约束：方案里没有恰好 2 件麦香鸡');
  assert.match(wantPlan.body.suggestion, /已严格按数量包含/, '未回传「已严格按数量包含」说明');

  // 2) 多方案 plans（1~3 个），plans[0] 必须与顶层主方案一致
  const plans = wantPlan.body.plans;
  assert.ok(Array.isArray(plans) && plans.length >= 1 && plans.length <= 3, `plans 应为 1~3 个，实际 ${plans && plans.length}`);
  assert.equal(
    plans[0].items.map((i) => `${i.code}x${i.quantity}`).join('|'),
    wantPlan.body.items.map((i) => `${i.code}x${i.quantity}`).join('|'),
    'plans[0] 必须与顶层主方案一致'
  );
  for (const p of plans) assert.ok(p.label && p.strategy, '方案缺 label / strategy');

  // 3) objective 别名归一：文档历史写法 lowest_price 不应被 400 拒绝
  const alias = await post(base, '/api/plan', { ...baseBody, objective: 'lowest_price' });
  assert.equal(alias.status, 200);
  assert.equal(alias.body.objective, 'cheapest');

  // 4) 第四种 objective：预算吃满
  const maxValue = await post(base, '/api/plan', { ...baseBody, objective: 'max_value' });
  assert.equal(maxValue.status, 200);
  assert.equal(maxValue.body.objective, 'max_value');

  // 5) 品类级忌口：饮料 → 饮品整类过滤（v1 只能按原料词子串匹配，整类过滤不掉）
  const noDrink = await post(base, '/api/plan', {
    ...baseBody,
    constraints: { ...baseBody.constraints, excluded: ['饮料'] },
  });
  assert.equal(noDrink.status, 200);
  assert.ok(noDrink.body.items.every((i) => i.category !== '饮品'), '品类忌口「饮料」未生效，方案里仍有饮品');

  // 6) 非法 wants 必须 400：静默丢弃会让前端以为诉求已生效
  const badWant = await post(base, '/api/plan', {
    ...baseBody,
    constraints: { ...baseBody.constraints, wants: [{ keyword: '麦香鸡', qty: 99 }] },
  });
  assert.equal(badWant.status, 400);
  assert.equal(badWant.body.error.code, 'BAD_REQUEST');

  // 7) 不设预算：budget 显式 null → 跳过预算筛选，budget_usage 为「—」而非编造百分比
  const noBudget = await post(base, '/api/plan', {
    ...baseBody,
    constraints: { ...baseBody.constraints, budget: null, calorie_limit: 1200 },
  });
  assert.equal(noBudget.status, 200);
  // 约束只在 request.constraints 下，顶层没有 constraints（契约文档已按实现修正）
  assert.equal(noBudget.body.request.constraints.budget, null);
  assert.equal(noBudget.body.plan.budget_usage, '—');
  assert.ok(noBudget.body.plan.total_calorie <= 1200);
  // 对照：压一个极低预算应无解，证明 null 确实放宽了预算而不是被当成 0
  const tinyBudget = await post(base, '/api/plan', {
    ...baseBody,
    constraints: { ...baseBody.constraints, budget: 1, calorie_limit: 1200 },
  });
  assert.equal(tinyBudget.body.success, false);
  // budget 不传 / 传 0 仍是 400，null 是唯一的「不设」信号
  const zeroBudget = await post(base, '/api/plan', { ...baseBody, constraints: { ...baseBody.constraints, budget: 0 } });
  assert.equal(zeroBudget.status, 400);

  // 三态之二：无解。必须带 conflict/hint，且仍是 HTTP 200（前端不能只看状态码）
  const noSolution = await post(base, '/api/plan', { storeCode: '1450713', constraints: { budget: 15, people: 3, excluded: [] } });
  assert.equal(noSolution.status, 200);
  assert.equal(noSolution.body.success, false);
  assert.ok(noSolution.body.conflict && noSolution.body.hint);
  // /api/plan 走 buildPayload 后与落盘同构，无解态的 error 恒为 null（不再像直接返回 solver 结果时那样是 undefined）
  assert.ok(!noSolution.body.error, '无解态不应携带 error 对象（error 是参数/数据异常专属）');

  // 三态之三：异常/参数错误。
  const bad = await post(base, '/api/plan', { storeCode: '1450713', constraints: { budget: -1, people: 2 } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BAD_REQUEST');
  assert.equal(bad.body.error.retryable, false);

  const badObjective = await post(base, '/api/plan', { ...baseBody, objective: '未知' });
  assert.equal(badObjective.status, 400);
  assert.equal(badObjective.body.error.code, 'BAD_REQUEST');

  const badJson = await call(base, '/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(badJson.status, 400);

  const badStore = await post(base, '/api/plan', { storeCode: '0000000', constraints: { budget: 60, people: 1 } });
  assert.equal(badStore.status, 404);
  assert.equal(badStore.body.error.code, 'NOT_FOUND');

  const unknown = await call(base, '/api/nope');
  assert.equal(unknown.status, 404);

  // 下单已启用（到支付链接为止）：空购物车是参数错误 400，不再是 501 未实现
  const order = await post(base, '/api/order', { storeCode: '1450713', items: [] });
  assert.equal(order.status, 400);
  assert.equal(order.body.error.code, 'BAD_REQUEST');
  // 演示订单：不碰 MCP、不调 create-order，只返回演示支付链接
  const mockOrder = await post(base, '/api/order', { storeCode: '1450713', mock: true, items: [{ code: '1406', quantity: 1 }] });
  assert.equal(mockOrder.status, 200);
  assert.equal(mockOrder.body.status ?? 'success', 'success');
  assert.ok(mockOrder.body.order?.payUrl || mockOrder.body.order?.payH5Url, '演示订单应给出支付链接');

  const stores = await call(base, '/api/stores');
  assert.equal(stores.status, 200);
  assert.ok(stores.body.items.length >= 1);

  server.close();
  console.log(JSON.stringify({
    ok: true,
    plan: { items: plan.body.items.map((i) => `${i.name}x${i.quantity}`), plan: plan.body.plan },
    prices,
    fusion: {
      wantQty,
      plans: plans.length,
      planLabels: plans.map((p) => p.label),
      aliasLowestPrice: alias.body.objective,
      maxValue: maxValue.body.objective,
      noDrinkCategories: [...new Set(noDrink.body.items.map((i) => i.category))],
      noBudget: { usage: noBudget.body.plan.budget_usage, price: noBudget.body.plan.total_price },
    },
    noSolution: { conflict: noSolution.body.conflict, hint: noSolution.body.hint },
  }, null, 2));
})().catch((e) => {
  console.error('测试失败：', e.message);
  process.exit(1);
});
