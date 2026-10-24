/**
 * 数据管道：麦当劳 MCP → 归一化菜单（Schema v1）
 *
 * 做了什么：
 *   1. 直连 MCP 拉门店菜单（query-meals）与官方营养表（list-nutrition-foods）
 *   2. 用**麦当劳官方分类**判定主食/小食/饮品/甜品（不再靠品名瞎猜）
 *   3. 用真实 currentPrice / originalPrice 算优惠（省了多少是真的）
 *   4. 品名 ↔ 营养表匹配，命中不到的一律标 unknown，绝不估算
 *
 * 跑法：
 *   export MCD_MCP_TOKEN=你的token
 *   node server/fetch-menu.js                       # 默认门店 1450713
 *   node server/fetch-menu.js --store 1450713 --mock # 同时刷新 web/mock/menu.json
 *
 * 产物：data/menu-<storeCode>.json
 */

const fs = require('fs');
const path = require('path');
const { callTool } = require('./mcp-client');

const ROOT = path.resolve(__dirname, '..');

// 麦当劳官方分类 → 我们的大类。顺序即优先级（一个菜品会同时属于多个分类）
const CAT_PRIORITY = [
  ['安格斯MAX\n厚牛堡', '主食'],
  ['巨无霸\n牛鱼肉堡', '主食'],
  ['鸡肉汉堡\n/卷', '主食'],
  ['大堡口福\n单人餐', '主食'],
  ['精选单人餐', '主食'],
  ['开心乐园', '主食'],
  ['随心配\n1+1', '主食'],
  ['500\n大卡套餐', '主食'],
  ['炸鸡', '小食'],
  ['蘸酱炸鸡', '小食'],
  ['小食拼盘\n/多人餐', '小食'],
  ['小食甜品\n/其他', '小食'], // 下面按品名再细分甜品
  ['麦咖啡™', '饮品'],
  ['饮品', '饮品'],
];
const IGNORED_CATS = ['人气热卖']; // 营销聚合位，不用于分类

const DESSERT_KEYWORDS = ['旋风', '圆筒', '新地', '派', '阿芙佳朵', '奶昔'];
const MERCH_KEYWORDS = ['帽', '丝巾', '贴', '挠', '捶'];

// ---------------------------------------------------------------- 工具函数

const clean = (s) => (s || '').replace(/\s+/g, '');

function norm(s) {
  return (s || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/[^\w\u4e00-\u9fff]/g, '')
    .toLowerCase();
}

/** MCP 把真实 JSON 包在 text 里，取出来 */
function extractJson(text) {
  const i = text.indexOf('{"success"');
  if (i < 0) throw new Error('未找到 JSON 响应体');
  const dec = new (require('util').TextDecoder)();
  void dec;
  // 手工括号配对，避免尾部有多余文本导致 JSON.parse 失败
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let p = i; p < text.length; p++) {
    const ch = text[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = p + 1; break; }
    }
  }
  if (end < 0) throw new Error('JSON 括号未配对');
  return JSON.parse(text.slice(i, end));
}

/** 官方营养表是 TOON 紧凑格式：[160]{字段...}:\n  值,值,值 */
function parseToon(text) {
  // 注意：MCP 的 "Original Response" 里 data 是 JSON 字符串，换行被二次转义成字面量 \n
  const t = text.replace(/\\n/g, '\n');
  // 先只匹配头部，正文整段切出来再按行切——用非贪婪会在第一行就停下来
  const head = t.match(/\[(\d+)\]\{([^}]+)\}:/);
  if (!head) throw new Error('TOON 解析失败：未找到表头');
  const fields = head[2].split(',').map((s) => s.trim());
  const body = t.slice(head.index + head[0].length);
  const rows = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.split(',').length >= fields.length);
  const parsed = rows.map((line) => {
    const vals = line.split(',');
    const o = {};
    fields.forEach((f, i) => (o[f] = vals[i]));
    return o;
  });
  if (!parsed.length) throw new Error('TOON 解析失败：正文为空');
  return parsed;
}

function nutritionToMap(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.productName) continue;
    const key = norm(r.productName);
    if (!map.has(key)) {
      map.set(key, {
        n: r.productName,
        kcal: Number(r.energyKcal) || 0,
        p: Number(r.protein) || 0,
        f: Number(r.fat) || 0,
        c: Number(r.carbohydrate) || 0,
        na: Number(r.sodium) || 0,
        ca: Number(r.calcium) || 0,
      });
    }
  }
  return map;
}

/** 归一化匹配：别名 → 精确 → 子串（长度比≥0.5）。blocklist 直接放弃，宁可 unknown */
function matchNutrition(name, nutMap, cfg) {
  if (cfg.blocklist.includes(name)) return null;
  const key = norm(name);
  if (cfg.map[name] && nutMap.has(norm(cfg.map[name]))) return nutMap.get(norm(cfg.map[name]));
  if (nutMap.has(key)) return nutMap.get(key);
  if (key.length < 2) return null;
  let best = null;
  for (const [k, v] of nutMap) {
    if (k.length < 2) continue;
    if (k.includes(key) || key.includes(k)) {
      const r = Math.min(key.length, k.length) / Math.max(key.length, k.length);
      if (r >= 0.5 && (!best || r > best.r)) best = { r, v };
    }
  }
  return best ? best.v : null;
}

// ---------------------------------------------------------------- 拉取

async function fetchMenu(storeCode) {
  const text = await callTool('query-meals', { storeCode, orderType: 1, beType: 1 });
  const d = extractJson(text).data;

  const catOf = new Map(); // code → [官方分类名]
  for (const c of d.categories) {
    if (IGNORED_CATS.includes(c.name)) continue;
    for (const m of c.meals) {
      if (!catOf.has(m.code)) catOf.set(m.code, []);
      catOf.get(m.code).push({ name: c.name, tags: m.tags || [] });
    }
  }

  const items = [];
  for (const [code, meal] of Object.entries(d.meals)) {
    const cats = catOf.get(code) || [];
    let category = '其他';
    for (const [pat, big] of CAT_PRIORITY) {
      if (cats.some((c) => clean(c.name) === clean(pat))) { category = big; break; }
    }
    if (category === '小食' && DESSERT_KEYWORDS.some((k) => meal.name.includes(k))) category = '甜品';
    if (MERCH_KEYWORDS.some((k) => meal.name.includes(k))) category = '其他';

    const kind = code.startsWith('990') ? 'combo'
      : MERCH_KEYWORDS.some((k) => meal.name.includes(k)) ? 'merch' : 'single';

    items.push({
      code,
      name: meal.name,
      price: Number(meal.currentPrice),
      original_price: Number(meal.originalPrice ?? meal.currentPrice),
      image: meal.image || null,
      kind,
      category,
      official_category: cats.map((c) => c.name.replace(/\n/g, '')),
      tags: [...new Set(cats.flatMap((c) => c.tags))],
      available: true,
    });
  }
  return { items, storeCode };
}

async function fetchNutrition() {
  const text = await callTool('list-nutrition-foods', {});
  return nutritionToMap(parseToon(text));
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const at = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const storeCode = at('store', '1450713');
  const writeMock = argv.includes('--mock');
  const offline = argv.includes('--offline'); // 只重跑匹配，不联网

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/alias-map.json'), 'utf8'));

  let items;
  if (offline) {
    const cached = JSON.parse(fs.readFileSync(path.join(ROOT, `data/menu-${storeCode}.json`), 'utf8'));
    items = cached.items;
  } else {
    console.log(`拉取门店 ${storeCode} 菜单…`);
    items = (await fetchMenu(storeCode)).items;
  }

  let nutMap;
  if (offline) {
    // 之前的 --offline 只跳过菜单、仍然联网拉营养表，名不副实。
    // 离线就该完全离线：营养表读本地缓存，断网也能重跑匹配。
    const cacheFile = path.join(ROOT, 'data/nutrition-cache.json');
    if (!fs.existsSync(cacheFile)) {
      throw new Error(`离线模式需要营养缓存 ${cacheFile}，请先联网跑一次本脚本`);
    }
    const rows = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).items.map((r) => ({
      productName: r.n,
      energyKcal: r.kcal,
      protein: r.p,
      fat: r.f,
      carbohydrate: r.c,
      sodium: r.na,
      calcium: r.ca,
    }));
    nutMap = nutritionToMap(rows);
    console.log(`营养表 ${nutMap.size} 条（本地缓存，未联网）`);
  } else {
    console.log('拉取官方营养表…');
    nutMap = await fetchNutrition();
    console.log(`营养表 ${nutMap.size} 条`);
  }

  let hit = 0, single = 0;
  for (const it of items) {
    if (it.kind !== 'single') {
      it.calorie = null;
      it.calorie_source = 'not_applicable';
      it.nutrition = null;
      continue;
    }
    single++;
    const n = matchNutrition(it.name, nutMap, cfg);
    if (n) {
      hit++;
      it.calorie = n.kcal;
      it.calorie_source = 'official';
      it.nutrition = { protein: n.p, fat: n.f, carbohydrate: n.c, sodium: n.na, calcium: n.ca };
    } else {
      it.calorie = null;
      it.calorie_source = 'unknown';
      it.nutrition = null;
    }
  }

  const out = {
    success: true,
    store: { code: storeCode },
    count: items.length,
    items,
    stats: {
      total: items.length,
      single,
      nutritionHit: hit,
      hitRate: single ? `${Math.round((hit / single) * 1000) / 10}%` : '—',
    },
    meta: { generatedAt: new Date().toISOString(), source: 'mcd-mcp query-meals + list-nutrition-foods' },
  };

  const outFile = path.join(ROOT, `data/menu-${storeCode}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`单品 ${single}，营养命中 ${hit}（${out.stats.hitRate}）-> ${outFile}`);

  if (writeMock) {
    const mockPath = path.join(ROOT, 'web/mock/menu.json');
    fs.writeFileSync(mockPath, JSON.stringify(out, null, 2), 'utf8');
    console.log(`已刷新 ${mockPath}`);
  }
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
