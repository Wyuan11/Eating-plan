/**
 * 数据管道：麦当劳 MCP → 门店快照（Schema v1 门店结构）
 *
 * 做了什么：
 *   1. 直连 MCP 拉附近门店（query-nearby-stores，searchType=2 城市+关键词）
 *   2. 用 server/api.js 的 normalizeStores 归一化成 canonical 门店列表（单一映射源）
 *   3. 落盘 data/stores-<city>.json，可提交 git，供后端 /api/stores 快照回退使用
 *
 * 跑法（需在有 MCD_MCP_TOKEN 的机器上）：
 *   export MCD_MCP_TOKEN=你的token
 *   node server/fetch-stores.js --city 上海 --keyword 人民广场          # 拉取并落盘
 *   node server/fetch-stores.js --city 上海 --inspect                  # 只打印原始返回，确认字段名
 *
 * 产物：data/stores-<city>.json
 *
 * 字段名已实测确认（2026-10-24）：data[] 内为 storeCode / storeName / address /
 * distance(整数·米) / beCode / businessStatus / reservation。normalizeStores 已按此映射。
 */

const fs = require('fs');
const path = require('path');
const { callTool, extractJson, parseMaybeJson } = require('./mcp-client');
const { normalizeStores } = require('./api');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const argv = process.argv.slice(2);
  const at = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const city = (at('city', '') || '').trim();
  const keyword = (at('keyword', '') || '').trim();
  const inspect = argv.includes('--inspect');
  const out = at('out', `data/stores-${city}.json`);

  if (!city) {
    console.error('用法：node server/fetch-stores.js --city <城市> [--keyword <关键词>] [--out <文件>] [--inspect]');
    process.exit(1);
  }

  console.log(`拉取门店：city=${city}${keyword ? ` keyword=${keyword}` : ''}…`);
  const text = await callTool('query-nearby-stores', { searchType: 2, city, keyword, beType: 1 });

  if (inspect) {
    console.log('========== 原始 MCP 返回（text）==========');
    console.log(text);
    console.log('========== 解析尝试 ==========');
    try { console.log('extractJson:', JSON.stringify(extractJson(text), null, 2)); }
    catch (e) { console.log('extractJson 失败:', e.message); }
    try { console.log('parseMaybeJson:', JSON.stringify(parseMaybeJson(text), null, 2)); }
    catch (e) { console.log('parseMaybeJson 失败:', e.message); }
    console.log('========== normalizeStores 结果 ==========');
    let parsed;
    try { parsed = extractJson(text); } catch { parsed = parseMaybeJson(text); }
    console.log(JSON.stringify(normalizeStores(parsed), null, 2));
    return;
  }

  let parsed;
  try { parsed = extractJson(text); } catch { parsed = parseMaybeJson(text); }
  const items = normalizeStores(parsed);
  if (!items.length) {
    console.error('归一化后门店列表为空。请用 --inspect 查看原始返回，修正 normalizeStores 的字段映射。');
    process.exit(1);
  }

  const payload = {
    success: true,
    items,
    meta: {
      generatedAt: new Date().toISOString(),
      source: 'mcd-mcp query-nearby-stores',
      city,
      keyword,
    },
  };

  const outFile = path.resolve(ROOT, out);
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`门店 ${items.length} 家 -> ${outFile}`);
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
