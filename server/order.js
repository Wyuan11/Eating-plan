'use strict';
/**
 * 下单链路：calculate-price 重新核价 → create-order 生成支付链接。
 *
 * 红线（不可越过）：
 *   1. 只到「拿到 payH5Url」为止，绝不调用任何支付/扣款工具，不自动跳转支付。
 *   2. 核价与本地快照不一致时如实报 PRICE_CHANGED，绝不静默按旧价下单。
 *   3. MCP 不可用/未配 Token 时如实报 MCP_UNAVAILABLE，绝不伪造订单号。
 *
 * 金额单位：MCP 一律返回「分」（2200 = ¥22），本模块对外统一换成「元」。
 */

const { callTool, extractJson } = require('./mcp-client');
const { ensureToken } = require('./token');

const DEFAULT_BE_TYPE = 1;   // 1: 到店取餐
const DEFAULT_ORDER_TYPE = 1; // 1: 到店

/** items 入参归一：接受 {code|productCode, quantity}，数量必须为正整数 */
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) return { error: 'items 必须为非空数组' };
  const out = [];
  for (const it of items) {
    const code = String(it?.code ?? it?.productCode ?? '').trim();
    const qty = Number(it?.quantity ?? it?.qty ?? 1);
    if (!code) return { error: 'items[].code 不能为空' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) return { error: `items[].quantity 必须为 1~20 的整数：${code}` };
    out.push({ code, quantity: qty });
  }
  return { value: out };
}

async function callJson(tool, args) {
  const text = await callTool(tool, args);
  const j = extractJson(text);
  // MCP 业务失败藏在 JSON 里（success:false + message），HTTP 仍是 200
  if (j && j.success === false) {
    const e = new Error(`${tool} 业务失败：${j.message || j.code || '未知原因'}`);
    e.code = 'MCP_TOOL_ERROR';
    e.raw = j;
    throw e;
  }
  return j?.data ?? {};
}

/** 第一步：算价。返回 MCP 的金额（元）与取餐方式列表 */
async function calculatePrice({ storeCode, beType, orderType, items }) {
  const data = await callJson('calculate-price', {
    storeCode,
    orderType,
    beType,
    items: items.map((i) => ({ productCode: i.code, quantity: i.quantity })),
  });
  return {
    totalFen: Number(data.price ?? data.originalPrice ?? 0),
    productFen: Number(data.productPrice ?? 0),
    deliveryFen: Number(data.deliveryPrice ?? 0),
    discountFen: Number(data.discount ?? 0),
    takeWayList: data.takeWayList || [],
    raw: data,
  };
}

/**
 * 取餐方式：到店场景 create-order 必填 takeWayCode，只能从算价结果里拿。
 * 找不到就如实报错，不猜一个默认值去下单。
 */
function pickTakeWay(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const code = (t) => t?.takeWayCode ?? t?.code ?? null;
  const named = (kw) => list.find((t) => JSON.stringify(t).includes(kw));
  const t = named('取餐') || named('locker') || named('self') || list[0];
  return code(t);
}

/** 第二步：创建订单。只取 orderId / payH5Url / 门店与金额，不做任何支付动作 */
async function createOrder({ storeCode, beType, orderType, items, takeWayCode }) {
  const data = await callJson('create-order', {
    storeCode,
    beType,
    orderType,
    ...(takeWayCode ? { takeWayCode } : {}),
    items: items.map((i) => ({ productCode: i.code, quantity: i.quantity })),
  });
  const d = data.orderDetail || {};
  return {
    orderId: data.orderId ?? null,
    payId: data.payId ?? null,
    payH5Url: data.payH5Url ?? null,
    orderStatus: d.orderStatus ?? null,
    storeName: d.storeName ?? null,
    totalFen: Number(d.realTotalAmount ?? d.totalAmount ?? 0) * 100,
    // MCP 未返回支付截止时间：这里不编造，留 null，由前端展示下单时间即可
    expireAt: null,
    raw: data,
  };
}

/**
 * 完整下单链路（核价 → 比对 → 下单）。
 *
 * @param {object} opts
 * @param {string} opts.storeCode
 * @param {Array}  opts.items         [{code, quantity}]
 * @param {number} [opts.beType]      默认 1（到店取餐）
 * @param {number} [opts.expectedFen] 本地快照算出的期望总价（分），用于核对是否变价
 * @returns {Promise<{ok:true, order, price, meta}|{ok:false, code, detail, meta}>}
 */
async function submitOrder(opts = {}) {
  const storeCode = String(opts.storeCode || '').trim();
  if (!storeCode) return { ok: false, code: 'BAD_REQUEST', detail: 'storeCode 必填' };

  const n = normalizeItems(opts.items);
  if (n.error) return { ok: false, code: 'BAD_REQUEST', detail: n.error };

  // 兜底加载 Token：env 没有时依次尝试项目根 .env、~/.workbuddy/mcp.json。
  // 必须在检查之前调用——成品的 .env 此前没有任何代码读取，不兜底则永远 503。
  ensureToken();
  if (!process.env.MCD_MCP_TOKEN) {
    return {
      ok: false,
      code: 'MCP_UNAVAILABLE',
      detail: '未配置 MCD_MCP_TOKEN，无法真实核价与下单。演示可用 {"mock":true} 走 mock 链路（响应会标注 source:mock）。',
    };
  }

  const beType = Number(opts.beType ?? DEFAULT_BE_TYPE);
  const orderType = DEFAULT_ORDER_TYPE;
  const meta = { storeCode, beType, orderType, items: n.value };

  try {
    const price = await calculatePrice({ storeCode, beType, orderType, items: n.value });
    meta.priceFen = price.totalFen;

    // 核价：菜单快照会过期，价格以 MCP 为准；不一致就让用户确认，不擅自下单
    if (Number.isFinite(opts.expectedFen) && opts.expectedFen > 0 && price.totalFen !== opts.expectedFen) {
      return {
        ok: false,
        code: 'PRICE_CHANGED',
        detail: `价格已变动：快照 ¥${(opts.expectedFen / 100).toFixed(2)}，实时 ¥${(price.totalFen / 100).toFixed(2)}，请确认后重试`,
        meta: { ...meta, expectedFen: opts.expectedFen, actualFen: price.totalFen },
      };
    }

    const takeWayCode = pickTakeWay(price.takeWayList);
    if (!takeWayCode) {
      return {
        ok: false,
        code: 'NO_TAKEWAY',
        detail: '算价结果未返回可取餐方式（takeWayList 为空），无法构造到店订单',
        meta: { ...meta, takeWayList: price.takeWayList },
      };
    }

    const order = await createOrder({ storeCode, beType, orderType, items: n.value, takeWayCode });
    return {
      ok: true,
      order,
      price,
      meta: { ...meta, takeWayCode, source: 'mcp' },
    };
  } catch (e) {
    return {
      ok: false,
      code: e?.code === 'MCP_TOOL_ERROR' ? 'MCP_TOOL_ERROR' : 'MCP_UNAVAILABLE',
      detail: e?.message || String(e),
      meta: { ...meta, raw: e?.raw ?? null },
    };
  }
}

module.exports = { submitOrder, normalizeItems, calculatePrice, createOrder, pickTakeWay };
