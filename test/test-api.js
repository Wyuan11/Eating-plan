'use strict';
/** 接口冒烟测试：起服务 → 打真实请求 → 校验三态与关键字段。 */
const assert = require('node:assert/strict');
const { toFen } = require('../server/solver');

const MENU = process.argv[2];
if (!MENU) throw new Error('用法: node test-api.js <menu.json路径>');
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
  // 不写死 124：菜单快照会随 fetch-menu.js 刷新，写死必然在某次刷新后假报错。
  // 这里只断言「菜单可用且非空」，数量一致性交给下面 /api/menu 与 health 的交叉比对。
  assert.ok(health.body.menu.count > 0);

  const menuRes = await call(base, '/api/menu?storeCode=1450713');
  assert.equal(menuRes.status, 200);
  assert.equal(menuRes.body.success, true);
  assert.equal(menuRes.body.items.length, health.body.menu.count);
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

  // 三态之二：无解。必须带 conflict/hint，且仍是 HTTP 200（前端不能只看状态码）
  const noSolution = await post(base, '/api/plan', { storeCode: '1450713', constraints: { budget: 15, people: 3, excluded: [] } });
  assert.equal(noSolution.status, 200);
  assert.equal(noSolution.body.success, false);
  assert.ok(noSolution.body.conflict && noSolution.body.hint);
  // 契约里落盘/响应统一把缺失字段写成 null（字段齐全、可预测），所以这里判「没有 error」而不是判 undefined
  assert.ok(!noSolution.body.error);

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

  // /api/order 已实现：空 items 必须 400（未实现时曾返回 501）
  const emptyOrder = await post(base, '/api/order', { storeCode: '1450713', items: [] });
  assert.equal(emptyOrder.status, 400);
  assert.equal(emptyOrder.body.error.code, 'BAD_REQUEST');

  // 显式 mock 逃生门：未调用 MCP，响应必须自己声明 source:mock，防止演示时把假订单当真
  const mockOrder = await post(base, '/api/order', { storeCode: '1450713', mock: true, items: [{ code: '1406', quantity: 1 }] });
  assert.equal(mockOrder.status, 200);
  assert.equal(mockOrder.body.success, true);
  assert.equal(mockOrder.body.meta.source, 'mock');
  assert.ok(mockOrder.body.order.payH5Url && mockOrder.body.order.orderId);

  // 未配 Token 时真实下单必须如实报不可用，绝不伪造订单
  if (!process.env.MCD_MCP_TOKEN) {
    const realOrder = await post(base, '/api/order', { storeCode: '1450713', items: [{ code: '1406', quantity: 1 }] });
    assert.equal(realOrder.status, 503);
    assert.equal(realOrder.body.error.code, 'MCP_UNAVAILABLE');
  }

  const stores = await call(base, '/api/stores');
  assert.equal(stores.status, 200);
  assert.ok(stores.body.items.length >= 1);

  server.close();
  console.log(JSON.stringify({ ok: true, plan: { items: plan.body.items.map((i) => `${i.name}x${i.quantity}`), plan: plan.body.plan }, prices, noSolution: { conflict: noSolution.body.conflict, hint: noSolution.body.hint } }, null, 2));
})().catch((e) => {
  console.error('测试失败：', e.message);
  process.exit(1);
});
