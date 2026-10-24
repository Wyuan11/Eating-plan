'use strict';
/**
 * 探测：麦当劳 MCP 到底能不能拿到「温度属性」（冰 / 热 / 常温）。
 *
 * 背景：用户说「不要冰饮」，但菜单快照里没有温度字段。本脚本对可信池里的饮品逐个调用
 * query-meal-detail，扫描 modification（定制项）里是否出现 冰/热/常温/去冰 之类的选项。
 *
 * 只有真实数据能回答这个问题——探测结果决定下一步：
 *   - 若 MCP 有温度选项 → 把它写进菜单快照（temperature 字段），求解器即可执行「不要冰饮」
 *   - 若没有 → 走如实披露路径（request.notes 标注「无法参与求解」），绝不猜、绝不伪造
 *
 * 用法（需要 Token，全程只读：只调 query-meal-detail，不核价不下单）：
 *   MCD_MCP_TOKEN=你的token node scripts/probe-temperature.js [门店编码]
 */
const path = require('node:path');
const fs = require('node:fs');
const { callTool, extractJson } = require('../server/mcp-client');

const STORE = process.argv[2] || '1450713';
const TEMP_HINT = /(冰|热|常温|去冰|少冰|冷)/;
const MENU_CANDIDATES = [
  path.resolve(__dirname, '../data/menu-1450713.json'),
  path.resolve(__dirname, '../web/mock/menu.json'),
];

function loadMenu() {
  for (const f of MENU_CANDIDATES) {
    if (fs.existsSync(f)) return { file: f, menu: JSON.parse(fs.readFileSync(f, 'utf8')) };
  }
  throw new Error('找不到菜单快照，先跑 npm run menu:fetch 或 node server/fetch-menu.js');
}

function pickDrinks(menu) {
  const items = menu.items || [];
  return items.filter(
    (i) => i.kind === 'single' && i.calorie_source === 'official' && i.category === '饮品'
  );
}

async function inspect(item) {
  const raw = await callTool('query-meal-detail', {
    code: item.code,
    storeCode: STORE,
    orderType: 1,
    beType: 1,
  });
  const data = extractJson(String(raw));
  const detail = data?.data ?? data ?? {};
  const mods = [];
  for (const group of detail?.modification?.items || []) {
    for (const v of group.values || []) {
      if (TEMP_HINT.test(String(v?.name ?? ''))) mods.push(String(v.name));
    }
  }
  // 有些版本把定制项放在 specList / properties 里，一并扫一遍
  const extra = [];
  for (const s of detail?.specList || []) {
    const txt = `${s?.specMain ?? ''}${s?.specItem ?? ''}`;
    if (TEMP_HINT.test(txt)) extra.push(txt);
  }
  return { code: item.code, name: item.name, tempOptions: [...new Set([...mods, ...extra])], rawKeys: Object.keys(detail) };
}

(async () => {
  if (!process.env.MCD_MCP_TOKEN) {
    console.error('[FATAL] 未设置 MCD_MCP_TOKEN，无法探测。设置后重跑：');
    console.error('  MCD_MCP_TOKEN=你的token node scripts/probe-temperature.js');
    process.exit(1);
  }
  const { file, menu } = loadMenu();
  const drinks = pickDrinks(menu);
  console.log(`[INFO] 菜单快照：${path.basename(file)}｜可信饮品 ${drinks.length} 个｜门店 ${STORE}`);
  console.log('[INFO] 逐个调用 query-meal-detail（只读）…\n');

  const rows = [];
  for (const d of drinks) {
    try {
      rows.push(await inspect(d));
      process.stdout.write('.');
    } catch (e) {
      rows.push({ code: d.code, name: d.name, tempOptions: [], error: String(e.message).slice(0, 120) });
      process.stdout.write('x');
    }
  }
  console.log('\n');

  const withTemp = rows.filter((r) => r.tempOptions.length);
  const sampleKeys = rows.find((r) => r.rawKeys?.length)?.rawKeys || [];

  console.log('=== 探测结果 ===');
  console.log(`调通 ${rows.filter((r) => !r.error).length}/${rows.length} 个；带温度选项的：${withTemp.length} 个`);
  for (const r of rows) {
    console.log(
      `  ${r.tempOptions.length ? '✅' : '—'} ${r.name}${r.tempOptions.length ? ` → ${r.tempOptions.join(' / ')}` : ''}${r.error ? `  [错误] ${r.error}` : ''}`
    );
  }
  console.log(`\ndetail 顶层字段（判断是否还有别处可挖）：${sampleKeys.join(', ') || '—'}`);

  const outFile = path.resolve(__dirname, '../data/temperature-probe.json');
  fs.writeFileSync(outFile, JSON.stringify({ storeCode: STORE, generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`\n明细已写入 ${outFile}`);

  if (!withTemp.length) {
    console.log('\n结论：MCP 未提供温度属性 →「不要冰饮」无法执行，走 notes 如实披露路径（不猜冷热）。');
  } else {
    console.log('\n结论：MCP 提供了温度选项 → 可据此给菜单补 temperature 字段，再由求解器执行温度忌口。');
  }
})().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
