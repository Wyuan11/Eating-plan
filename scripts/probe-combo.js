'use strict';
/**
 * 只读探测：套餐（990 开头）能否被拆成子项、子项能否在营养库里查到热量。
 *
 * 为什么探这个：优惠券大多只对「套餐/组合」生效（三件套、任选2），
 * 而当前求解器只用 kind==='single' 的可信池，套餐被排除在外。
 * 如果套餐拆不出子项热量，券再便宜也进不了预算——这就是决定性事实。
 *
 * 用法：node scripts/probe-combo.js [code ...]
 */
const fs = require('node:fs');
const path = require('node:path');
const { ensureToken } = require('../server/token');

const src = ensureToken();
if (!process.env.MCD_MCP_TOKEN) {
  console.error('缺少 Token：请设置 MCD_MCP_TOKEN 或在 ~/.workbuddy/mcp.json 配置 mcd-mcp');
  process.exit(2);
}
console.log(`Token 来源: ${src}（不回显）`);

const { callTool, extractJson } = require('../server/mcp-client');

const CODES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['9900005456', '9900016077', '9900016566']; // 麦辣鸡腿汉堡三件套 / 蘸酱炸鸡 / 心形薯饼8块
const STORE = process.env.STORE_CODE || '1450713';

(async () => {
  const out = { probedAt: new Date().toISOString(), storeCode: STORE, combos: {} };
  for (const code of CODES) {
    console.log(`\n=== ${code} ===`);
    try {
      const text = await callTool('query-meal-detail', { storeCode: STORE, code, orderType: 1, beType: 1 });
      let data = null;
      try { data = extractJson(text); } catch { /* 非 JSON，落原文 */ }
      // 业务失败藏在 JSON 里（success:false + message），HTTP 仍是 200，必须显式拦
      if (!data || data.success === false) {
        const msg = data?.message || '未知原因';
        console.log('  业务失败:', msg);
        out.combos[code] = { ok: false, reason: msg, raw: data ?? String(text).slice(0, 2000) };
        continue;
      }
      const d = data.data ?? data;
      out.combos[code] = { ok: true, raw: d };
      const name = d.name || d.productName || d.title || '(无名)';
      console.log('  套餐名:', name);
      const groups = d.groups || d.detailList || d.items || d.mealItems || [];
      console.log('  子项分组字段:', Object.keys(d).join(','));
      const kids = [];
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        if (o.productCode || o.code) kids.push({ code: String(o.productCode ?? o.code), name: o.productName ?? o.name ?? '', price: o.price ?? o.currentPrice ?? null });
        else Object.values(o).forEach(walk);
      };
      walk(groups);
      console.log('  子项:', JSON.stringify(kids.slice(0, 12)));
      out.combos[code].children = kids;
    } catch (e) {
      console.log('  失败:', e.message.slice(0, 300));
      out.combos[code] = { ok: false, reason: e.message };
    }
  }
  const p = path.join(__dirname, '..', 'data', 'combo-probe.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n已写入 ${p}`);
})();
