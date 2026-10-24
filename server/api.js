'use strict';
/**
 * 麦门智选助手 · HTTP 服务层（Schema v1.1）
 *
 * 职责边界：本文件只做「HTTP ↔ solver」的搬运，不做任何业务决策。
 *   - 不调用 MCP（菜单读本地快照，刷新由 server/fetch-menu.js 负责）
 *   - 不调用 Skill（Skill 是下一步的事，见 §Step 3）
 *   - 不修改 solver 返回的任何业务结论，三态原样透传
 *
 * 依赖：零第三方包（原生 node:http）。放到仓库时与本目录的 solver.js 同级，
 *   例如都放在 server/ 下，require('./solver') 即可。
 *
 * 启动：
 *   node server/api.js                  # 默认 3000，与 web/vite.config.js 的 /api 代理一致
 *   PORT=8787 node server/api.js        # 需要换端口时用环境变量
 *   MENU_FILE=path/to/menu.json node server/api.js
 *   MENU_DIR=path/to/data node server/api.js        # 目录内需有 menu-<storeCode>.json
 *
 * 端口分工：3000 = 本服务；8787 = server/bridge.js（Skill 方案文件桥）。
 * 两者不要占用同一端口，否则前端联调时会出现「连上了但拿不到方案」的怪现象。
 *
 * 环境变量：
 *   PORT          默认 3000
 *   MENU_FILE     直接指定菜单快照文件（优先级最高）
 *   MENU_DIR      菜单快照目录，默认依次尝试 ../data 与 ../web/mock
 *   DEFAULT_STORE 默认门店，默认 1450713
 *   MAX_NODES     求解搜索节点上限，默认 2000000
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// solve 由 buildPayload 内部调用，这里只需要它导出的目标枚举做入参校验
const { OBJECTIVES, OBJECTIVE_ALIASES, trustedPool } = require('./solver');
// 券：只做「读券 + 与菜单匹配」，生效判定全在 coupons.js，这里不自己判断省钱
const { applyCoupons, sanitizeCoupons, fetchMyCoupons } = require('./coupons');
// 复用 Skill 落盘那一份 payload 构造逻辑：/api/plan 的响应结构与
// data/skill-outbox/plan-*.json 逐字段一致，前端只写一套解析代码。
const { buildPayload } = require('./emit-plan');
// Skill 触发（WorkBuddy 本机 Gateway）：/api/skill-plan 用，网关不可用则前端回退 /api/plan
const { triggerAsync } = require('./trigger-skill');
const { readPlan } = require('./outbox');
// 下单链路（calculate-price → create-order，止于支付链接）：真实 MCP 调用都在 order.js 里
const { submitOrder } = require('./order');

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_STORE = process.env.DEFAULT_STORE || '1450713';
const MENU_FILE = process.env.MENU_FILE || null;
const MENU_DIRS = (process.env.MENU_DIR ? [process.env.MENU_DIR] : []).concat(
  [path.resolve(__dirname, '../data'), path.resolve(__dirname, '../web/mock')]
);
const MAX_BODY = 64 * 1024;
const MAX_NODES = Number(process.env.MAX_NODES || 2000000);
const SERVICE_VERSION = '0.2.0';

// ---------------------------------------------------------------- 菜单缓存

const cache = new Map(); // filePath -> { mtimeMs, payload }

function resolveMenuFile(storeCode) {
  if (MENU_FILE) return fs.existsSync(MENU_FILE) ? MENU_FILE : null;
  const candidates = [];
  for (const dir of MENU_DIRS) {
    candidates.push(path.join(dir, `menu-${storeCode}.json`));
    candidates.push(path.join(dir, 'menu.json')); // 需再校验 store.code 是否匹配
  }
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    if (file.endsWith('menu.json')) {
      try {
        const probe = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (probe?.store?.code !== storeCode) continue;
      } catch {
        continue; // 解析失败就跳过这个候选，继续找下一个
      }
    }
    return file;
  }
  return null;
}

/** 读菜单快照。文件 mtime 变化会自动重载，所以 fetch-menu.js 刷新后无需重启服务。 */
function loadMenu(storeCode) {
  const file = resolveMenuFile(storeCode);
  if (!file) return { error: `未找到门店 ${storeCode} 的菜单快照，请先运行 fetch-menu.js`, code: 'NOT_FOUND', retryable: false };
  let stat;
  try {
    stat = fs.statSync(file);
    const hit = cache.get(file);
    const payload = hit && hit.mtimeMs === stat.mtimeMs
      ? hit.payload
      : JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!payload || !Array.isArray(payload.items)) return { error: `菜单文件格式错误: ${file}`, code: 'INTERNAL_ERROR', retryable: false };
    // 门店校验必须每次都做，不能只在冷读时做：同一文件可能服务多个 storeCode 查询
    if (payload.store?.code && payload.store.code !== storeCode) return { error: `菜单快照属于门店 ${payload.store.code}，与请求的 ${storeCode} 不一致`, code: 'NOT_FOUND', retryable: false };
    cache.set(file, { mtimeMs: stat.mtimeMs, payload });
    return { menu: payload, cacheHit: Boolean(hit), file };
  } catch (e) {
    return { error: `读取菜单失败: ${e.message}`, code: 'INTERNAL_ERROR', retryable: true };
  }
}

// ---------------------------------------------------------------- 输出工具

const now = () => new Date().toISOString();
const baseMeta = (storeCode, extra) => ({ storeCode, generatedAt: now(), source: 'local-menu-snapshot', ...(extra || {}) });

function fail(code, detail, retryable, meta) {
  return { success: false, message: '请求失败', error: { code, detail, retryable }, meta: meta || baseMeta() };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let aborted = false;
    req.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) {
        aborted = true;
        resolve({ error: '请求体过大' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return resolve({ error: '请求体必须是 JSON 对象' });
        resolve(parsed);
      } catch {
        resolve({ error: '请求体不是合法 JSON' });
      }
    });
    req.on('error', () => resolve({ error: '读取请求体失败' }));
  });
}

// ---------------------------------------------------------------- 入参校验

/** 兼容两种写法：{ constraints: {...} } 与 { budget, ... } 扁平写法 */
function pickConstraints(body) {
  const box = body && typeof body.constraints === 'object' && body.constraints !== null ? body.constraints : body || {};
  return {
    budget: box.budget,
    calorie_limit: box.calorie_limit ?? box.calorieLimit ?? null,
    people: box.people ?? 1,
    excluded: box.excluded ?? [],
    wants: box.wants ?? [],
  };
}

/** 正向诉求归一：字符串 → {keyword, qty:1}；{keyword, qty} 原样 */
function normalizeWants(wants) {
  if (!Array.isArray(wants)) return { error: 'constraints.wants 必须为数组' };
  const out = [];
  for (const w of wants) {
    if (typeof w === 'string') {
      if (!w.trim()) return { error: 'constraints.wants 不能有空字符串' };
      out.push({ keyword: w.trim(), qty: 1 });
      continue;
    }
    const kw = typeof w?.keyword === 'string' ? w.keyword.trim() : '';
    const qty = Math.floor(Number(w?.qty ?? 1));
    if (!kw) return { error: 'constraints.wants[].keyword 必须为非空字符串' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 12) return { error: `constraints.wants[].qty 必须为 1~12 的整数：${kw}` };
    out.push({ keyword: kw, qty });
  }
  return { value: out };
}

function validate(body) {
  const storeCode = typeof body?.storeCode === 'string' && body.storeCode.trim() ? body.storeCode.trim() : DEFAULT_STORE;
  const c = pickConstraints(body);
  const objective = OBJECTIVE_ALIASES[body?.objective ?? c.objective] || body?.objective || c.objective || 'balanced';
  if (!OBJECTIVES.includes(objective)) return { error: `objective 必须是 ${OBJECTIVES.join(' / ')}` };
  if (typeof c.budget !== 'number' || !Number.isFinite(c.budget) || c.budget <= 0) return { error: 'constraints.budget 必须为大于 0 的数字' };
  if (!Number.isInteger(c.people) || c.people < 1 || c.people > 6) return { error: 'constraints.people 必须为 1～6 的整数' };
  if (c.calorie_limit !== null && (typeof c.calorie_limit !== 'number' || !Number.isFinite(c.calorie_limit) || c.calorie_limit <= 0)) return { error: 'constraints.calorie_limit 必须为正数或 null' };
  if (!Array.isArray(c.excluded) || c.excluded.some((k) => typeof k !== 'string')) return { error: 'constraints.excluded 必须为字符串数组' };
  const w = normalizeWants(c.wants);
  if (w.error) return { error: w.error };
  return { value: { storeCode, objective, constraints: { budget: c.budget, calorie_limit: c.calorie_limit, people: c.people, excluded: c.excluded, wants: w.value } } };
}

// ---------------------------------------------------------------- 路由

async function handlePlan(req, res) {
  const body = await readJsonBody(req);
  if (body.error) return send(res, 400, fail('BAD_REQUEST', body.error, false));

  const parsed = validate(body);
  if (parsed.error) return send(res, 400, fail('BAD_REQUEST', parsed.error, false, baseMeta(body?.storeCode || DEFAULT_STORE)));

  const { storeCode, objective, constraints } = parsed.value;
  const traceId = `plan-${crypto.randomUUID()}`;
  const meta = baseMeta(storeCode, { traceId });

  // 优惠券：两种用法
  //   1) body.coupons 显式传入（前端已拿到 /api/coupons 的结果，避免重复拉 MCP）
  //   2) body.useCoupons === true 且未显式传 → 后端拉一次真实券；拉不到只是不参与求解，绝不让请求失败
  let coupons = null;
  if (Object.prototype.hasOwnProperty.call(body || {}, 'coupons')) {
    const s = sanitizeCoupons(body.coupons);
    if (s.error) return send(res, 400, fail('BAD_REQUEST', s.error, false, meta));
    coupons = s.value;
  } else if (body?.useCoupons === true) {
    try {
      const r = await fetchMyCoupons();
      if (r.ok) coupons = r.coupons;
      else meta.couponWarning = r.error; // 拉不到券：照常求解，如实标注
    } catch (e) {
      meta.couponWarning = String(e?.message || e);
    }
  }

  const loaded = loadMenu(storeCode);
  if (loaded.error) return send(res, loaded.code === 'NOT_FOUND' ? 404 : 503, fail(loaded.code, loaded.error, loaded.retryable, meta));

  // 走 emit-plan 的 buildPayload 而不是直接 solve：
  // 1) 三态判定（success/nosolution/error）只有那一处实现，避免这里再写一遍判断逻辑而走偏
  // 2) 响应结构与 Skill 落盘的 plan-*.json 完全一致，前端一套解析吃两个来源
  let payload;
  try {
    payload = buildPayload({
      traceId,
      storeCode,
      intent: typeof body?.intent === 'string' ? body.intent : '',
      objective,
      constraints,
      ...(Array.isArray(coupons) ? { coupons } : {}),
      menu: loaded.menu, // 已读过就传进来，避免每次请求重复读文件
      options: { maxNodes: MAX_NODES }, // 搜索节点上限保护，防止病态输入把服务拖死
    });
  } catch (e) {
    return send(res, 500, fail('INTERNAL_ERROR', `求解异常: ${e.message}`, false, meta));
  }

  // 三态原样透传：success / nosolution / error 均返回 HTTP 200，前端按 status 分支
  payload.meta = { ...(payload.meta || {}), ...meta, menuFile: loaded.file, cacheHit: loaded.cacheHit };
  return send(res, 200, payload);
}

function handleMenu(req, res, url) {
  const storeCode = url.searchParams.get('storeCode') || DEFAULT_STORE;
  const loaded = loadMenu(storeCode);
  const meta = baseMeta(storeCode);
  if (loaded.error) return send(res, loaded.code === 'NOT_FOUND' ? 404 : 503, fail(loaded.code, loaded.error, loaded.retryable, meta));

  const menu = loaded.menu;
  send(res, 200, {
    success: true,
    store: { code: menu.store?.code || storeCode, name: menu.store?.name || '', address: menu.store?.address || '' },
    count: Array.isArray(menu.items) ? menu.items.length : 0,
    items: menu.items,
    meta: { ...meta, menuFile: loaded.file, cacheHit: loaded.cacheHit },
  });
}

/**
 * GET /api/coupons?storeCode=xxx
 * 读真实券并给出「能不能用在当前菜单」的判定。只读，不领券、不消耗券。
 * MCP 不可用 → 503 MCP_UNAVAILABLE（前端退回「不带券求解」，不假装没券）。
 */
async function handleCoupons(req, res, url) {
  const storeCode = url.searchParams.get('storeCode') || DEFAULT_STORE;
  const meta = baseMeta(storeCode);
  const r = await fetchMyCoupons();
  if (!r.ok) {
    const status = r.code === 'MCP_UNAVAILABLE' ? 503 : 502;
    return send(res, status, fail(r.code, r.error, r.code === 'MCP_UNAVAILABLE', meta));
  }
  const loaded = loadMenu(storeCode);
  const pool = loaded.error ? [] : trustedPool(loaded.menu.items);
  const report = applyCoupons(pool, r.coupons, { now: new Date(), channel: '到店' });
  send(res, 200, {
    success: true,
    store: { code: storeCode, name: loaded.menu?.store?.name || null },
    total: r.coupons.length,
    applied: report.applied.map((a) => ({ title: a.title, code: a.appliedTo.code, name: a.appliedTo.name, before: a.appliedTo.beforeFen / 100, after: a.appliedTo.afterFen / 100, saved: a.appliedTo.savedFen / 100 })),
    skipped: report.skipped.map((s) => ({ title: s.title, status: s.status, reason: s.reason })),
    disclaimer: '券接口不返回券码（couponId/couponCode），下单核价无法带券；券后价只参与组合筛选与预算判定，实付以核价为准',
    meta: { ...meta, menuLoaded: !loaded.error, poolSize: pool.length },
  });
}

function handleStores(req, res) {
  // P1：有快照文件就用，没有就从菜单快照里推导演示门店 ofType=到店自取
  for (const dir of MENU_DIRS) {
    const file = path.join(dir, 'stores.json');
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      // 兼容：同时给出 stores 别名，配合前端 data.stores 的读取方式
      const aliased = { ...data, ...(Array.isArray(data?.stores) ? { items: data.stores } : { stores: data?.items }) };
      return send(res, 200, { ...aliased, meta: { ...data.meta, ...baseMeta(DEFAULT_STORE, { storesFile: file }) } });
    } catch (e) {
      return send(res, 500, fail('INTERNAL_ERROR', `门店文件解析失败: ${e.message}`, false, baseMeta(DEFAULT_STORE)));
    }
  }
  const loaded = loadMenu(DEFAULT_STORE);
  if (loaded.error) return send(res, 404, fail('NOT_FOUND', loaded.error, false, baseMeta(DEFAULT_STORE)));
  const payload = {
    success: true,
    items: [{ code: loaded.menu.store?.code || DEFAULT_STORE, name: loaded.menu.store?.name || '', address: loaded.menu.store?.address || '', beType: 1 }],
    meta: baseMeta(DEFAULT_STORE, { source: 'derived-from-menu-snapshot' }),
  };
  // 兼容：Widget 前端早期实现读的是 data.stores，这里同时给一份别名，避免门店下拉为空
  send(res, 200, { ...payload, stores: payload.items });
}

function handleHealth(req, res) {
  const loaded = loadMenu(DEFAULT_STORE);
  send(res, 200, {
    ok: true,
    service: 'mcd-smart-order-backend',
    version: SERVICE_VERSION,
    mode: MENU_FILE || process.env.MENU_DIR ? 'local-menu-snapshot' : 'local-menu-snapshot',
    mcp: { reachable: false, note: '本服务不直连 MCP；菜单快照由 fetch-menu.js 负责刷新' },
    menu: loaded.error
      ? { available: false, reason: loaded.error }
      : { available: true, storeCode: loaded.menu.store?.code || DEFAULT_STORE, count: loaded.menu.items.length, file: loaded.file, cacheHit: loaded.cacheHit },
    time: now(),
  });
}

/**
 * POST /api/order —— 核价 + 下单，止于支付链接。
 *
 * 链路：本地快照核价 → calculate-price 重新核价（变价则 409 拦截）→ create-order → payH5Url。
 * 红线：不调用任何支付工具、不自动跳转；演示到此为止，不产生真实扣款。
 * mock：显式传 {"mock":true} 才走 mock，且响应 meta.source="mock"，绝不静默伪造。
 */
async function handleOrder(req, res) {
  const body = await readJsonBody(req);
  if (body.error) return send(res, 400, fail('BAD_REQUEST', body.error, false, baseMeta(DEFAULT_STORE)));

  const storeCode = typeof body?.storeCode === 'string' && body.storeCode.trim() ? body.storeCode.trim() : DEFAULT_STORE;
  const meta = baseMeta(storeCode, { traceId: `order-${crypto.randomUUID()}` });

  if (body?.mock === true) {
    try {
      const mock = JSON.parse(fs.readFileSync(path.join(__dirname, '../web/mock/order.success.json'), 'utf8'));
      return send(res, 200, {
        ...mock,
        meta: { ...meta, ...(mock.meta || {}), source: 'mock', note: 'mock 订单：未调用 MCP，不产生真实订单' },
      });
    } catch (e) {
      return send(res, 500, fail('INTERNAL_ERROR', `mock 订单读取失败: ${e.message}`, false, meta));
    }
  }

  const beType = Number(body?.beType ?? 1); // 1: 到店取餐
  if (![1, 2, 5, 6].includes(beType)) return send(res, 400, fail('BAD_REQUEST', 'beType 必须是 1/2/5/6', false, meta));

  // 用本地快照算一个期望总价，交给 MCP 核价比对；菜单缺失时不阻断，只放弃比对
  let expectedFen = null;
  const loaded = loadMenu(storeCode);
  if (!loaded.error) {
    const byCode = new Map(loaded.menu.items.map((i) => [String(i.code), i]));
    let fen = 0, ok = true;
    for (const it of Array.isArray(body?.items) ? body.items : []) {
      const m = byCode.get(String(it?.code ?? it?.productCode ?? ''));
      const qty = Number(it?.quantity ?? 1);
      if (!m || !Number.isFinite(m.price)) { ok = false; break; }
      fen += Math.round(m.price * 100) * qty;
    }
    if (ok && fen > 0) expectedFen = fen;
  }

  const r = await submitOrder({ storeCode, items: body?.items, beType, expectedFen });
  if (!r.ok) {
    const status = { BAD_REQUEST: 400, PRICE_CHANGED: 409, MCP_TOOL_ERROR: 502, NO_TAKEWAY: 502, MCP_UNAVAILABLE: 503 }[r.code] || 502;
    return send(res, status, fail(r.code, r.detail, r.code === 'MCP_UNAVAILABLE', { ...meta, ...(r.meta || {}) }));
  }

  const yuan = (fen) => Math.round(fen) / 100;
  return send(res, 200, {
    success: true,
    // 不编造支付截止时间：MCP 没给就说「以支付页为准」
    message: '订单已创建，请在支付页提示的时间内完成支付（演示到此为止，不会自动付款）',
    order: {
      orderId: r.order.orderId,
      total_price: yuan(r.order.totalFen || r.price.totalFen),
      payH5Url: r.order.payH5Url,
      expireAt: r.order.expireAt, // MCP 未返回 → null
      storeName: r.order.storeName,
      orderStatus: r.order.orderStatus,
    },
    price_check: {
      expected_price: expectedFen === null ? null : yuan(expectedFen),
      actual_price: yuan(r.price.totalFen),
      product_price: yuan(r.price.productFen),
      delivery_price: yuan(r.price.deliveryFen),
      discount: yuan(r.price.discountFen),
      matched: expectedFen === null ? null : expectedFen === r.price.totalFen,
    },
    meta: { ...meta, ...(r.meta || {}) },
  });
}

// ------------------------------------------------------- Skill 链路（自然语言 → Skill → solver）

/**
 * GET /api/plan/:traceId —— 读 Skill 落盘结果。
 * 未生成时 404 + status:"pending"（与 bridge.js 同语义），前端据此继续轮询。
 */
function handlePlanById(req, res, traceId) {
  try {
    const plan = readPlan(traceId);
    return send(res, 200, plan);
  } catch {
    return send(res, 404, { ok: false, traceId, status: 'pending', message: '方案尚未生成' });
  }
}

/**
 * POST /api/skill-plan { intent } —— 自然语言交给 Skill（WorkBuddy 本机 Gateway）。
 * 受理后立即 202 + traceId；Skill 调 emit-plan 落盘，前端轮询 GET /api/plan/:traceId。
 * 网关不可用 → 503 GATEWAY_UNAVAILABLE，前端回退 POST /api/plan（确定性求解）。
 */
async function handleSkillPlan(req, res) {
  const body = await readJsonBody(req);
  if (body.error) return send(res, 400, fail('BAD_REQUEST', body.error, false));
  const intent = typeof body?.intent === 'string' ? body.intent.trim() : '';
  if (!intent) return send(res, 400, fail('BAD_REQUEST', 'intent 必须为非空字符串（用户点单原文）', false));
  const traceId = `skill-${crypto.randomUUID()}`;
  const meta = baseMeta(DEFAULT_STORE, { traceId });
  try {
    const info = await triggerAsync({ text: intent, traceId });
    return send(res, 202, { ok: true, status: 'pending', traceId, poll: `/api/plan/${traceId}`, runId: info.runId, meta: { ...meta, gateway: info.gateway, gatewayFrom: info.gatewayFrom } });
  } catch (e) {
    return send(res, 503, fail('GATEWAY_UNAVAILABLE', `Skill 网关不可用：${e.message}`, true, meta));
  }
}

// ---------------------------------------------------------------- 服务器

function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  const started = Date.now();
  const log = (status) => console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);

  if (route === '/api/health' && req.method === 'GET') { log(200); return handleHealth(req, res); }
  if (route === '/api/menu' && req.method === 'GET') { log(200); return handleMenu(req, res, url); }
  if (route === '/api/stores' && req.method === 'GET') { log(200); return handleStores(req, res); }
  if (route === '/api/coupons' && req.method === 'GET') {
    return handleCoupons(req, res, url).then(() => log(res.statusCode), (e) => { console.error(e); log(500); return send(res, 500, fail('INTERNAL_ERROR', String(e?.message || e), false)); });
  }
  if (route === '/api/plan' && req.method === 'POST') {
    return handlePlan(req, res).then(() => log(res.statusCode), () => log(500));
  }
  if (route.startsWith('/api/plan/') && req.method === 'GET') {
    log(200);
    return handlePlanById(req, res, route.slice('/api/plan/'.length));
  }
  if (route === '/api/skill-plan' && req.method === 'POST') {
    return handleSkillPlan(req, res).then(() => log(res.statusCode), (e) => { console.error(e); log(500); return send(res, 500, fail('INTERNAL_ERROR', String(e?.message || e), false)); });
  }
  if (route === '/api/order' && req.method === 'POST') {
    return handleOrder(req, res).then(() => log(res.statusCode), () => log(500));
  }

  log(404);
  return send(res, 404, fail('NOT_FOUND', `未知路由 ${req.method} ${route}`, false, baseMeta(DEFAULT_STORE)));
}

function start(port = PORT) {
  return new Promise((resolve) => {
    const server = http.createServer(requestHandler);
    server.listen(port, '127.0.0.1', () => {
      if (require.main === module) console.log(`listening http://127.0.0.1:${server.address().port}`);
      resolve(server);
    });
  });
}

module.exports = { start, loadMenu, validate, pickConstraints };

if (require.main === module) {
  start().then((server) => {
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
