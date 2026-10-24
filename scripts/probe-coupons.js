'use strict';
/**
 * 只读探测：优惠券相关 MCP 工具的真实返回结构。
 *
 * 目的：券的适用条件（限定商品 code / 门店 / 门槛 / 能否叠加）必须来自真实字段，
 *      猜一个「满 30 减 5」就等于编造，违反项目「绝不编造数据」的红线。
 *      所以先探，再决定怎么进求解器。本脚本不下单、不领券、不写任何业务状态。
 *
 * 用法：node scripts/probe-coupons.js [storeCode]
 * 输出：data/coupon-probe.json（原始返回 + 结构摘要）
 */

const fs = require('node:fs');
const path = require('node:path');
const { ensureToken } = require('../server/token');

// 1) 先补 token：mcp-client 在模块加载时读 MCD_MCP_TOKEN，所以必须在 require 之前塞进 env
const tokenSrc = ensureToken();
if (!process.env.MCD_MCP_TOKEN) {
  console.error('缺少 Token：请设置 MCD_MCP_TOKEN 或在 ~/.workbuddy/mcp.json 配置 mcd-mcp');
  process.exit(2);
}
console.log(`Token 来源: ${tokenSrc}（不回显）`);

const { rpc, callTool } = require('../server/mcp-client');

const STORE = process.argv[2] || '1450713';
const COUPON_TOOLS = ['query-my-coupons', 'available-coupons', 'query-store-coupons', 'query-promotions', 'auto-bind-coupons'];

/** 按 schema 猜一份只读参数：只填常见字段，绝不填会改变状态的必填项以外的东西 */
function guessArgs(schema) {
  const props = schema?.properties || {};
  const out = {};
  for (const [k, v] of Object.entries(props)) {
    const n = k.toLowerCase();
    if (n.includes('store') && n.includes('code')) out[k] = STORE;
    else if (n === 'storecode') out[k] = STORE;
    else if (n.includes('ordertype')) out[k] = 1;
    else if (n.includes('betype')) out[k] = 1;
    // 注意顺序：先判 pagesize，否则 page 会先命中 pagesize 字段把它填成 1
    else if (n.includes('pagesize') || n.includes('size')) out[k] = 200;
    else if (n.includes('pagenum') || n === 'page') out[k] = 1;
    else if (n.includes('city')) out[k] = '北京市';
    else if (v?.default !== undefined) out[k] = v.default;
  }
  return out;
}

/** 递归摘出顶层键与样例值（值截断，避免刷屏） */
function shapeOf(v, depth = 0) {
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = shapeOf(val, depth + 1);
    return o;
  }
  const s = String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : (v === null || v === undefined ? null : v);
}

function firstList(obj) {
  // 券列表通常藏在 data 下某个数组里，挑最长的那个数组当正主
  let best = null;
  const walk = (o, p) => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object')) {
        if (!best || v.length > best.list.length) best = { path: `${p}.${k}`, list: v };
      } else if (v && typeof v === 'object') walk(v, `${p}.${k}`);
    }
  };
  walk(obj, '');
  return best;
}

(async () => {
  const report = { probedAt: new Date().toISOString(), storeCode: STORE, tools: {} };

  let schemas = {};
  try {
    const list = await rpc('tools/list', {});
    const all = list?.tools || [];
    schemas = Object.fromEntries(all.filter((t) => COUPON_TOOLS.includes(t.name)).map((t) => [t.name, t.inputSchema || {}]));
    report.availableToolNames = all.map((t) => t.name).filter((n) => n.includes('coupon') || n.includes('promotion'));
  } catch (e) {
    console.error('tools/list 失败：', e.message);
  }

  for (const name of COUPON_TOOLS) {
    const schema = schemas[name];
    const entry = { schema: schema || null, args: null, ok: null, error: null, raw: null, shape: null, listPath: null, count: 0, sample: null };
    report.tools[name] = entry;
    if (!schema) { entry.error = 'tools/list 中不存在该工具'; console.log(`\n[${name}] 不存在`); continue; }

    const args = guessArgs(schema);
    entry.args = args;
    console.log(`\n=== ${name} ===`);
    console.log('  参数 schema:', JSON.stringify(schema.properties || {}, null, 1).slice(0, 800));
    console.log('  实传参数:', JSON.stringify(args));

    try {
      const text = await callTool(name, args);
      entry.ok = true;
      entry.raw = String(text).slice(0, 20000);
      let parsed = null;
      try { parsed = JSON.parse(String(text).slice(String(text).indexOf('{'), String(text).lastIndexOf('}') + 1)); } catch { /* 可能是 TOON 文本 */ }
      if (parsed) {
        entry.shape = shapeOf(parsed);
        const f = firstList(parsed);
        if (f) { entry.listPath = f.path; entry.count = f.list.length; entry.sample = f.list.slice(0, 3); }
        console.log('  结构:', JSON.stringify(entry.shape, null, 1).slice(0, 1200));
        console.log(`  列表: ${entry.listPath || '(未识别)'} 共 ${entry.count} 条`);
        if (entry.sample) console.log('  样例:', JSON.stringify(entry.sample, null, 1).slice(0, 1500));
      } else {
        console.log('  原始文本前 600 字:', String(text).slice(0, 600));
      }
    } catch (e) {
      entry.ok = false;
      entry.error = e.message;
      console.log('  调用失败:', e.message.slice(0, 300));
    }
  }

  // 合并旧结果：本次调用失败的工具沿用上一次成功的原始数据。
  // 否则一次网络抖动就会把好数据覆盖成空，下游测试与解析全部失真。
  const out = path.join(__dirname, '..', 'data', 'coupon-probe.json');
  let merged = report;
  if (fs.existsSync(out)) {
    try {
      const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
      merged = { ...report, tools: { ...(prev.tools || {}), ...report.tools } };
      for (const [name, cur] of Object.entries(report.tools)) {
        const old = prev.tools?.[name];
        if (cur.ok !== true && old && old.ok === true) merged.tools[name] = old;
      }
    } catch { /* 旧文件损坏就用本次结果 */ }
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(merged, null, 2), 'utf8');
  const failedCount = Object.values(merged.tools).filter((t) => t.ok !== true).length;
  console.log(`\n已写入 ${out}${failedCount ? `（${failedCount} 个工具本次调用失败，沿用上次成功数据）` : ''}`);
})();
