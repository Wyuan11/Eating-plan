'use strict';
/**
 * 下单链路回归：mock 路径 + 参数校验 + （有 Token 时）真实核价。
 *
 * 红线守卫：本测试**默认不创建真实订单**。
 * 需要真实 create-order 时必须显式 `ORDER_LIVE=1 npm run test:order`（此时才会产生一个未支付订单）。
 *
 * 用法：node test/test-order.js data/menu-1450713.json
 */
const assert = require('node:assert/strict');

const MENU = process.argv[2];
if (!MENU) throw new Error('用法: node test/test-order.js <menu.json路径>');
process.env.MENU_FILE = MENU;
process.env.PORT = '0';

const { start } = require('../server/api');
const { calculatePrice } = require('../server/order');
// 与服务端 order.js 行为对齐：env 没有 token 时兜底加载项目根 .env / ~/.workbuddy/mcp.json。
// 否则测试进程以为没 token（断言 503），服务端却已加载（实际 200），两者不一致。
const { ensureToken } = require('../server/token');
const TOKEN_SOURCE = ensureToken();

const post = async (base, route, payload) => {
  const res = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
};

(async () => {
  const server = await start(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const storeCode = '1450713';
  const out = { ok: true };

  // 1. mock 路径：不碰 MCP，且必须自曝 source:mock
  const mock = await post(base, '/api/order', { storeCode, mock: true, items: [{ code: '1406', quantity: 1 }] });
  assert.equal(mock.status, 200);
  assert.equal(mock.body.meta.source, 'mock');
  assert.ok(mock.body.order.payH5Url);
  out.mock = { orderId: mock.body.order.orderId, total: mock.body.order.total_price };

  // 2. 参数校验：空 items / 数量非法 / 未知 beType
  for (const bad of [{ items: [] }, { items: [{ code: '1406', quantity: 0 }] }, { items: [{ quantity: 1 }] }, { items: [{ code: '1406', quantity: 1 }], beType: 99 }]) {
    const r = await post(base, '/api/order', { storeCode, ...bad });
    assert.equal(r.status, 400, `应拒绝入参 ${JSON.stringify(bad)}`);
    assert.equal(r.body.error.code, 'BAD_REQUEST');
  }
  out.validation = 'ok';

  // 3. 真实链路：无 Token 必须 503 且不产生订单号
  if (!TOKEN_SOURCE) {
    const r = await post(base, '/api/order', { storeCode, items: [{ code: '1406', quantity: 1 }] });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'MCP_UNAVAILABLE');
    assert.equal(r.body.order, undefined);
    out.real = 'SKIP（未配置 MCD_MCP_TOKEN）';
  } else {
    // 有 Token：默认只做「核价」这一步，不创建订单（核价不产生任何订单）
    const price = await calculatePrice({ storeCode, beType: 1, orderType: 1, items: [{ code: '1406', quantity: 1 }] });
    assert.ok(Number.isFinite(price.totalFen) && price.totalFen > 0, '核价应返回正数金额（分）');
    out.real = { priceFen: price.totalFen, takeWayList: (price.takeWayList || []).length };

    if (process.env.ORDER_LIVE === '1') {
      const r = await post(base, '/api/order', { storeCode, items: [{ code: '1406', quantity: 1 }] });
      assert.equal(r.status, 200, `真实下单失败：${JSON.stringify(r.body).slice(0, 200)}`);
      assert.ok(r.body.order.orderId && r.body.order.payH5Url);
      assert.equal(r.body.meta.source, 'mcp');
      out.liveOrder = { orderId: r.body.order.orderId, total: r.body.order.total_price, status: r.body.order.orderStatus };
    } else {
      out.liveOrder = 'SKIP（ORDER_LIVE=1 才会真实创建未支付订单）';
    }
  }

  server.close();
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error('测试失败：', e.message);
  process.exit(1);
});
