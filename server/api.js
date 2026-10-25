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
const { solve, OBJECTIVES } = require('./solver');

const PORT = Number(process.env.PORT || 3000); // 前端 vite 代理指向 3000，默认值必须一致
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
  };
}

function validate(body) {
  const storeCode = typeof body?.storeCode === 'string' && body.storeCode.trim() ? body.storeCode.trim() : DEFAULT_STORE;
  const c = pickConstraints(body);
  const objective = body?.objective ?? c.objective ?? 'balanced';
  if (!OBJECTIVES.includes(objective)) return { error: `objective 必须是 ${OBJECTIVES.join(' / ')}` };
  if (typeof c.budget !== 'number' || !Number.isFinite(c.budget) || c.budget <= 0) return { error: 'constraints.budget 必须为大于 0 的数字' };
  if (!Number.isInteger(c.people) || c.people < 1 || c.people > 6) return { error: 'constraints.people 必须为 1～6 的整数' };
  if (c.calorie_limit !== null && (typeof c.calorie_limit !== 'number' || !Number.isFinite(c.calorie_limit) || c.calorie_limit <= 0)) return { error: 'constraints.calorie_limit 必须为正数或 null' };
  if (!Array.isArray(c.excluded) || c.excluded.some((k) => typeof k !== 'string')) return { error: 'constraints.excluded 必须为字符串数组' };
  return { value: { storeCode, objective, constraints: { budget: c.budget, calorie_limit: c.calorie_limit, people: c.people, excluded: c.excluded } } };
}

// ---------------------------------------------------------------- 路由

async function handlePlan(req, res) {
  const body = await readJsonBody(req);
  if (body.error) return send(res, 400, fail('BAD_REQUEST', body.error, false));

  const parsed = validate(body);
  if (parsed.error) return send(res, 400, fail('BAD_REQUEST', parsed.error, false, baseMeta(body?.storeCode || DEFAULT_STORE)));

  const { storeCode, objective, constraints } = parsed.value;
  const meta = baseMeta(storeCode, { traceId: `plan-${crypto.randomUUID()}` });

  const loaded = loadMenu(storeCode);
  if (loaded.error) return send(res, loaded.code === 'NOT_FOUND' ? 404 : 503, fail(loaded.code, loaded.error, loaded.retryable, meta));

  let result;
  try {
    result = solve(loaded.menu.items, {
      storeCode,
      storeName: loaded.menu.store?.name,
      objective,
      budget: constraints.budget,
      calorie_limit: constraints.calorie_limit,
      people: constraints.people,
      excluded: constraints.excluded,
    }, { maxNodes: MAX_NODES });
  } catch (e) {
    return send(res, 500, fail('INTERNAL_ERROR', `求解异常: ${e.message}`, false, meta));
  }

  // 三态原样透传：success PlanSuccess / conflict 无解 / error 异常，均返回 HTTP 200
  result.meta = { ...result.meta, ...meta, ...(result.meta || {}), menuFile: loaded.file, cacheHit: loaded.cacheHit };
  return send(res, 200, result);
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
  if (route === '/api/stores' && req.method === 'GET') { log(200); return handleStores(req, res); }
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

module.exports = { start, loadMenu, validate, pickConstraints };

if (require.main === module) {
  start().then((server) => {
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
