'use strict';
/**
 * 麦门智选助手 · HTTP 服务层（Schema v1.1）
 *
 * 职责边界：本文件只做「HTTP ↔ solver」的搬运，不做任何业务决策。
 *   - 菜单优先读本地快照；快照缺失且设了 MCD_MCP_TOKEN 时按需实时拉取 query-meals 并落盘
 *   - 门店在设置 MCD_MCP_TOKEN 时可实时查 MCP（query-nearby-stores），否则回退本地快照
 *   - 不调用 Skill（Skill 是下一步的事，见 §Step 3）
 *   - 不修改 solver 返回的任何业务结论，三态原样透传
 *
 * 依赖：零第三方包（原生 node:http）。放到仓库时与本目录的 solver.js 同级，
 *   例如都放在 server/ 下，require('./solver') 即可。
 *
 * 启动：
 *   PORT=8787 MENU_FILE=path/to/menu.json node server/api.js
 *   MENU_DIR=path/to/data node server/api.js        # 目录内需有 menu-<storeCode>.json
 *
 * 环境变量：
 *   PORT          默认 8787
 *   MENU_FILE     直接指定菜单快照文件（优先级最高）
 *   MENU_DIR      菜单快照目录，默认依次尝试 ../data 与 ../web/mock
 *   DEFAULT_STORE 默认门店，默认 1450713
 *   MAX_NODES     求解搜索节点上限，默认 2000000
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { solve, OBJECTIVES, OBJECTIVE_ALIASES } = require('./solver');
const { buildPayload } = require('./emit-plan');

const PORT = Number(process.env.PORT || 8787);
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

/** 菜单快照缺失时，若有 token 则实时拉一次 query-meals 并落盘，再重读；仍失败则原样报错。 */
async function ensureMenu(storeCode) {
  const loaded = loadMenu(storeCode);
  if (!loaded.error) return loaded;
  // 无 token 无法实时拉取，直接把「快照缺失」的诚实错误抛给前端
  if (!process.env.MCD_MCP_TOKEN) return loaded;
  try {
    const { buildAndWriteMenu } = require('./fetch-menu');
    console.warn(`[menu] 门店 ${storeCode} 菜单快照缺失，实时拉取 query-meals…`);
    await buildAndWriteMenu(storeCode);
    return loadMenu(storeCode);
  } catch (e) {
    return { error: `门店 ${storeCode} 菜单快照缺失且实时拉取失败: ${e.message}`, code: 'MCP_UPSTREAM_ERROR', retryable: true };
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
    // v2：正向诉求「想吃 X × N」，数量是硬约束。不传即空数组，行为与加之前完全一致。
    wants: box.wants ?? [],
  };
}

function validate(body) {
  const storeCode = typeof body?.storeCode === 'string' && body.storeCode.trim() ? body.storeCode.trim() : DEFAULT_STORE;
  const c = pickConstraints(body);
  // objective 走 solver 的别名表归一：文档/前端历史写法 lowest_price、save、lowcal、value
  // 都能落到规范值，不再因为命名口径不一致被 400 拒绝。
  const rawObjective = body?.objective ?? c.objective ?? 'balanced';
  const objective = OBJECTIVE_ALIASES[rawObjective] || rawObjective;
  if (!OBJECTIVES.includes(objective)) return { error: `objective 必须是 ${OBJECTIVES.join(' / ')}` };
  if (typeof c.budget !== 'number' || !Number.isFinite(c.budget) || c.budget <= 0) return { error: 'constraints.budget 必须为大于 0 的数字' };
  if (!Number.isInteger(c.people) || c.people < 1 || c.people > 6) return { error: 'constraints.people 必须为 1～6 的整数' };
  if (c.calorie_limit !== null && (typeof c.calorie_limit !== 'number' || !Number.isFinite(c.calorie_limit) || c.calorie_limit <= 0)) return { error: 'constraints.calorie_limit 必须为正数或 null' };
  if (!Array.isArray(c.excluded) || c.excluded.some((k) => typeof k !== 'string')) return { error: 'constraints.excluded 必须为字符串数组' };
  // 正向诉求：{ keyword, qty } 列表，qty 1~12。格式错误要报 400，不能静默丢弃——
  // 静默丢弃会让前端以为诉求已生效，拿到一个「成功但不含用户点名商品」的方案。
  if (!Array.isArray(c.wants)) return { error: 'constraints.wants 必须为数组' };
  for (const w of c.wants) {
    const kw = typeof w === 'string' ? w : w?.keyword;
    const qty = typeof w === 'string' ? 1 : Math.floor(Number(w?.qty ?? 1));
    if (typeof kw !== 'string' || !kw.trim()) return { error: 'constraints.wants[].keyword 必须为非空字符串' };
    if (!Number.isInteger(qty) || qty < 1 || qty > 12) return { error: `constraints.wants[].qty 必须为 1~12 的整数：${kw}` };
  }
  return { value: { storeCode, objective, constraints: { budget: c.budget, calorie_limit: c.calorie_limit, people: c.people, excluded: c.excluded, wants: c.wants } } };
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

  const loaded = await ensureMenu(storeCode);
  if (loaded.error) return send(res, loaded.code === 'NOT_FOUND' ? 404 : 503, fail(loaded.code, loaded.error, loaded.retryable, meta));

  // 走 emit-plan 的 buildPayload 而不是直接 solve：
  // 1) 三态判定（success / nosolution / error）只有那一处实现，避免这里再写一遍判断逻辑而走偏；
  //    直接返回 solve 的原始结果时，响应里是 success:true 而没有 status，
  //    与 Skill 落盘的 plan-*.json（status 三态）不是一套结构，前端被迫吃两种形状。
  // 2) 响应结构与 Skill 落盘完全一致，前端一套解析吃两个来源（HTTP 与文件桥）。
  // 3) payload 仍带 success 字段，旧调用方不受影响。
  let payload;
  try {
    payload = buildPayload({
      traceId,
      storeCode,
      intent: typeof body?.intent === 'string' ? body.intent : '',
      objective,
      constraints,
      // 调用方（如 Skill 侧）传入的未生效偏好披露；求解器自己产生的 notes 会在内部合并
      notes: Array.isArray(body?.notes) ? body.notes : [],
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

// ---------------------------------------------------------------- 门店

const storesCache = new Map(); // `${city}|${keyword}` -> { at, items }
const STORES_CACHE_TTL = 10 * 60 * 1000;

/**
 * 把 MCP query-nearby-stores 原始返回归一化成 canonical 门店列表。
 * 字段名已对真实 MCP 实测确认（2026-10-24）：data[] 内为
 * storeCode / storeName / address / distance(整数·米) / beCode / businessStatus / reservation。
 * distance 是整数米，这里统一转成展示串（<1km 用 m，≥1km 用 km）。
 */
function formatDistance(d) {
  if (d == null || d === '') return null;
  const n = Number(d);
  if (!Number.isFinite(n)) return String(d); // 已是字符串（如 "0.3km"）原样返回
  if (n < 1000) return `${Math.round(n)}m`;
  return `${(n / 1000).toFixed(1)}km`;
}

function normalizeStores(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const data = raw.data ?? raw;
  const list = Array.isArray(data)
    ? data
    : data?.stores ?? data?.items ?? data?.list ?? data?.storeList ?? data?.data ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((s) => {
      if (!s || typeof s !== 'object') return null;
      const code = String(s.storeCode ?? s.code ?? s.store_id ?? s.id ?? '').trim();
      const name = s.storeName ?? s.name ?? s.store_name ?? s.title ?? '';
      const address = s.address ?? s.storeAddress ?? s.detailAddress ?? '';
      if (!code) return null;
      const out = { code, name, address, beType: Number(s.beType ?? s.businessType ?? s.bizType ?? 1) || 1 };
      const dist = formatDistance(s.distance ?? s.distanceText ?? s.distance_text ?? s.dist);
      if (dist != null) out.distance = dist;
      if (s.beCode) out.beCode = String(s.beCode);
      return out;
    })
    .filter(Boolean);
}

/** 找门店快照文件：优先城市专属 stores-<city>.json，其次通用 stores.json */
function resolveStoresFile(city) {
  const names = [];
  if (city) names.push(`stores-${city}.json`);
  names.push('stores.json');
  for (const dir of MENU_DIRS) {
    for (const n of names) {
      const file = path.join(dir, n);
      if (!fs.existsSync(file)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const items = Array.isArray(data) ? data : data?.items ?? data?.stores ?? null;
        if (Array.isArray(items)) return { file, data };
      } catch { /* 解析失败跳过，继续找下一个候选 */ }
    }
  }
  return null;
}

function handleStoresSnapshot(res, source, city) {
  const found = resolveStoresFile(city);
  if (found) {
    const { file, data } = found;
    // 兼容：同时给出 stores 别名，配合前端 data.stores 的读取方式
    const aliased = { ...data, ...(Array.isArray(data?.stores) ? { items: data.stores } : { stores: data?.items }) };
    return send(res, 200, { ...aliased, meta: { ...(data.meta || {}), ...baseMeta(DEFAULT_STORE, { source, storesFile: file }) } });
  }
  const loaded = loadMenu(DEFAULT_STORE);
  if (loaded.error) return send(res, 404, fail('NOT_FOUND', loaded.error, false, baseMeta(DEFAULT_STORE)));
  const payload = {
    success: true,
    items: [{ code: loaded.menu.store?.code || DEFAULT_STORE, name: loaded.menu.store?.name || '', address: loaded.menu.store?.address || '', beType: 1 }],
    meta: baseMeta(DEFAULT_STORE, { source }),
  };
  // 兼容：Widget 前端早期实现读的是 data.stores，这里同时给一份别名，避免门店下拉为空
  send(res, 200, { ...payload, stores: payload.items });
}

async function handleStores(req, res, url) {
  const city = (url?.searchParams.get('city') || '').trim();
  const keyword = (url?.searchParams.get('keyword') || '').trim();

  // 有城市 + 有 token → 实时查 MCP；任何失败都回退快照，绝不让门店查询失败导致白屏
  if (city && process.env.MCD_MCP_TOKEN) {
    const cacheKey = `${city}|${keyword}`;
    const hit = storesCache.get(cacheKey);
    if (hit && Date.now() - hit.at < STORES_CACHE_TTL) {
      return send(res, 200, { success: true, items: hit.items, meta: baseMeta(DEFAULT_STORE, { source: 'mcd-mcp query-nearby-stores (live, cached)', city, keyword }) });
    }
    try {
      const { callTool, extractJson, parseMaybeJson } = require('./mcp-client');
      // query-nearby-stores 要求 city 与 keyword 都非空（缺关键词会 600058）；关键词缺省时退化为按城市名搜
      const text = await callTool('query-nearby-stores', { searchType: 2, city, keyword: keyword || city, beType: 1 });
      let parsed;
      try { parsed = extractJson(text); } catch { parsed = parseMaybeJson(text); }
      const items = normalizeStores(parsed);
      if (!items.length) throw new Error('MCP 门店查询返回空列表');
      storesCache.set(cacheKey, { at: Date.now(), items });
      return send(res, 200, { success: true, items, meta: baseMeta(DEFAULT_STORE, { source: 'mcd-mcp query-nearby-stores (live)', city, keyword }) });
    } catch (e) {
      console.warn(`[stores] MCP 实时查询失败，回退快照: ${e.message}`);
      return handleStoresSnapshot(res, `mcd-mcp query-nearby-stores (fallback: ${e.message})`, city);
    }
  }

  return handleStoresSnapshot(res, 'local-snapshot', city);
}

function handleHealth(req, res) {
  const loaded = loadMenu(DEFAULT_STORE);
  send(res, 200, {
    ok: true,
    service: 'mcd-smart-order-backend',
    version: SERVICE_VERSION,
    mode: MENU_FILE || process.env.MENU_DIR ? 'local-menu-snapshot' : 'local-menu-snapshot',
    mcp: { reachable: false, note: '菜单读本地快照；门店在设置 MCD_MCP_TOKEN 时可实时查 MCP' },
    stores: {
      live: Boolean(process.env.MCD_MCP_TOKEN),
      note: process.env.MCD_MCP_TOKEN ? '门店可实时查 MCP' : '未设置 MCD_MCP_TOKEN，门店走本地快照',
    },
    menu: loaded.error
      ? { available: false, reason: loaded.error }
      : { available: true, storeCode: loaded.menu.store?.code || DEFAULT_STORE, count: loaded.menu.items.length, file: loaded.file, cacheHit: loaded.cacheHit },
    time: now(),
  });
}

function handleOrder(req, res) {
  return send(res, 501, fail('NOT_FOUND', '/api/order 尚未实现：Day2 先 calculate-price 重新核价，用户确认后再 create-order', false, baseMeta(DEFAULT_STORE)));
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
  if (route === '/api/stores' && req.method === 'GET') {
    return handleStores(req, res, url).then(() => log(res.statusCode), () => log(500));
  }
  if (route === '/api/plan' && req.method === 'POST') {
    return handlePlan(req, res).then(() => log(res.statusCode), () => log(500));
  }
  if (route === '/api/order') { log(501); return handleOrder(req, res); }

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

module.exports = { start, loadMenu, validate, pickConstraints, normalizeStores, resolveStoresFile };

if (require.main === module) {
  start().then((server) => {
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
