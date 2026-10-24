'use strict';
/**
 * 把 temperature-probe.json 的探测结果写进菜单快照的 temperature 字段。
 *
 * 语义（严格按 MCP 真实数据推导，不猜）：
 *   - modification 里有 去冰/多冰/少冰 选项 ⇒ 该商品默认就是冰饮 → temperature: 'cold'
 *   - 没有冰量选项 ⇒ 无法判断是热饮还是常温 → 不写字段（宁缺毋假）
 *
 * 用法（不需要 Token，只消费本地探测结果）：
 *   node scripts/enrich-temperature.js [菜单文件]
 * 不传菜单文件时默认改 data/menu-<store>.json 真实缓存。
 */
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const PROBE_FILE = path.join(ROOT, 'data/temperature-probe.json');

const probe = JSON.parse(fs.readFileSync(PROBE_FILE, 'utf8'));
// 有去冰/多冰/少冰选项 ⇒ 默认冰饮
const coldCodes = new Set(
  probe.rows
    .filter((r) => (r.tempOptions || []).some((t) => /去冰|多冰|少冰|冰/.test(t)))
    .map((r) => String(r.code))
);
console.log(`[INFO] 探测结果：${coldCodes.size} 个商品带冰量选项 → temperature:'cold'`);

const menuFile = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, `data/menu-${probe.storeCode || '1450713'}.json`);
if (!fs.existsSync(menuFile)) {
  console.error(`[FATAL] 菜单文件不存在：${menuFile}`);
  process.exit(1);
}
const menu = JSON.parse(fs.readFileSync(menuFile, 'utf8'));

let cold = 0, kept = 0;
for (const item of menu.items || []) {
  if (coldCodes.has(String(item.code))) {
    item.temperature = 'cold';
    cold++;
  } else if (item.temperature) {
    delete item.temperature; // 探测没覆盖到的旧标注一律清掉，菜单里不留无依据的字段
    kept++;
  }
}

// 写回：临时文件 + rename，保持与 outbox 相同的原子写
const tmp = `${menuFile}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(menu, null, 2));
fs.renameSync(tmp, menuFile);

console.log(`[OK] ${path.basename(menuFile)}：标注冰饮 ${cold} 个${kept ? `；清除无依据旧标注 ${kept} 个` : ''}`);
console.log(`     其余饮品未标注温度（无冰量选项 ≠ 已知冷热），求解器对未标注者不做温度过滤`);
