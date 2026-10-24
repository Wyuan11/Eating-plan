/**
 * 清理 outbox 里堆积的历史方案文件
 *
 *   node scripts/clean-outbox.js                 # 预演：只列出会删哪些，不真删
 *   node scripts/clean-outbox.js --keep 20 --yes # 保留最近 20 个，其余删除
 *   node scripts/clean-outbox.js --all --yes     # 全部清空
 *
 * 默认预演（不删），必须显式 --yes 才执行删除——避免误删正在演示的方案。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTBOX = path.join(ROOT, 'data', 'skill-outbox');
const argv = process.argv.slice(2);
const YES = argv.includes('--yes');
const ALL = argv.includes('--all');
const keepIdx = argv.indexOf('--keep');
const KEEP = keepIdx >= 0 ? Number(argv[keepIdx + 1]) : 20;

function main() {
  if (!fs.existsSync(OUTBOX)) {
    console.log('outbox 不存在，无需清理');
    return;
  }
  const files = fs
    .readdirSync(OUTBOX)
    .filter((f) => /^plan-.*\.json$/.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(OUTBOX, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m); // 新的在前

  const victims = ALL ? files : files.slice(KEEP);

  console.log(`当前 ${files.length} 个方案文件${ALL ? '' : `，保留最近 ${KEEP} 个`}`);
  if (!victims.length) {
    console.log('无需删除');
    return;
  }
  console.log(`${YES ? '将删除' : '预演会删除'} ${victims.length} 个：`);
  victims.slice(0, 10).forEach((v) => console.log(`  - ${v.f}`));
  if (victims.length > 10) console.log(`  … 其余 ${victims.length - 10} 个`);

  if (!YES) {
    console.log('\n这是预演。确认无误后加 --yes 执行。');
    return;
  }
  for (const v of victims) fs.unlinkSync(path.join(OUTBOX, v.f));
  console.log(`\n已删除 ${victims.length} 个，剩余 ${files.length - victims.length} 个`);
}

main();
