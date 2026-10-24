'use strict';
/**
 * 券模块测试：解析 / 时效 / 匹配 / 券后价。
 * 用真实探测数据（data/coupon-probe.json）+ 真实菜单快照做输入，不造假数据。
 *
 * 用法：node test/test-coupons.js [menuPath]
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
const C = require('../server/coupons');

const menuPath = process.argv[2] || path.resolve(__dirname, '../data/menu-1450713.json');
const probePath = path.resolve(__dirname, '../data/coupon-probe.json');
const fixturePath = path.resolve(__dirname, './fixtures/my-coupons.md');

let pass = 0, fail = 0;
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

const { raw, source } = loadRaw();
const coupons = C.parseMyCoupons(raw);

console.log(`== 券解析（真实 MCP 返回，来源：${source}）==`);
/**
 * 输入优先级：先用 data/coupon-probe.json（真实 MCP 最新返回），
 * 探测文件缺失或为空时回退 test/fixtures/my-coupons.md（同一份真实数据的固化快照）。
 * 这样网络抖动时测试也不会假失败——券解析逻辑本身是纯函数，不依赖网络。
 */
function loadRaw() {
  if (fs.existsSync(probePath)) {
    try {
      const probe = JSON.parse(fs.readFileSync(probePath, 'utf8'));
      const raw = probe.tools?.['query-my-coupons']?.raw;
      if (raw && String(raw).includes('用券价格')) return { raw, source: 'data/coupon-probe.json（MCP 实时探测）' };
    } catch { /* 落到 fixture */ }
  }
  return { raw: fs.readFileSync(fixturePath, 'utf8'), source: 'test/fixtures/my-coupons.md（固化快照）' };
}

ok('解析出券且数量 > 0', () => assert.ok(coupons.length > 0, `解析到 ${coupons.length} 张`));
ok('每张券都有用券价格（分）', () => {
  for (const c of coupons) assert.ok(Number.isInteger(c.priceAfterFen) && c.priceAfterFen > 0, `${c.title} 用券价格异常: ${c.priceAfterFen}`);
});
ok('有效期区间解析正确（三件套：2026-10-23 00:00 起）', () => {
  const c = coupons.find((x) => x.title.includes('麦辣鸡腿堡三件套'));
  assert.ok(c, '应 parsed 到三件套券');
  assert.strictEqual(c.validFrom, '2026-10-23T00:00');
  assert.strictEqual(c.validTo, '2026-11-23T23:59');
});
ok('星期限制解析正确（周一、二、三、四、五 缩写写法）', () => {
  const c = coupons.find((x) => x.title.includes('11.9元麦辣鸡腿堡'));
  assert.deepStrictEqual(c.weekdays, [1, 2, 3, 4, 5], JSON.stringify(c?.weekdays));
});
ok('每日时段解析正确（三件套 10:30-23:59）', () => {
  const c = coupons.find((x) => x.title.includes('麦辣鸡腿堡三件套'));
  assert.deepStrictEqual(c.dailyWindow, [10 * 60 + 30, 23 * 60 + 59]);
});
ok('渠道标签解析', () => {
  const c = coupons.find((x) => x.title.includes('11.9元麦辣鸡腿堡'));
  assert.ok(c.channels.some((t) => t.includes('到店')), JSON.stringify(c.channels));
});

console.log('\n== 时效判定 ==');
const at = (s) => new Date(`2026-10-26T${s}`); // 周一
const burger = coupons.find((x) => x.title.includes('11.9元麦辣鸡腿堡'));
ok('生效前不可用', () => {
  const r = C.usableNow(burger, new Date('2026-10-24T12:00'));
  assert.strictEqual(r.ok, false);
  assert.ok(/生效|可用/.test(r.reason), r.reason);
});
ok('生效日 + 时段内可用', () => assert.strictEqual(C.usableNow(burger, at('12:00')).ok, true));
// 选券生效期内的工作日（10-27 周二）测时段，避免撞上「券尚未生效」这条更早的判定
ok('不在每日时段内不可用', () => {
  const r = C.usableNow(burger, new Date('2026-10-27T08:00'));
  assert.strictEqual(r.ok, false);
  assert.ok(/时段/.test(r.reason), r.reason);
});
// 真实券的有效期恰好全是工作日，测星期过滤用合成券（只测判定逻辑，不测数据源）
ok('非券适用星期不可用（周六）', () => {
  const synth = { title: '合成券', priceAfterFen: 1000, channels: [], validFrom: '2026-10-01T00:00', validTo: '2026-11-30T23:59', weekdays: [1, 2, 3, 4, 5], dailyWindow: null };
  const r = C.usableNow(synth, new Date('2026-10-31T12:00')); // 周六
  assert.strictEqual(r.ok, false);
  assert.ok(/周/.test(r.reason), r.reason);
  assert.strictEqual(C.usableNow(synth, new Date('2026-10-30T12:00')).ok, true); // 周五可用
});
ok('渠道不符不可用', () => {
  const onlyStore = coupons.find((x) => x.title.includes('新人专享-中杯美式7折'));
  const r = C.usableNow(onlyStore, new Date('2026-10-26T12:00'), '外送');
  assert.strictEqual(r.ok, false);
  assert.ok(/外送|到店/.test(r.reason), r.reason);
});

console.log('\n== 与真实菜单匹配 ==');
const menu = JSON.parse(fs.readFileSync(menuPath, 'utf8'));
const pool = menu.items.filter((i) => i.kind === 'single');
const atNoon = at('12:00');
const report = C.applyCoupons(pool, coupons, { now: atNoon, channel: '到店' });

for (const a of report.applied) console.log(`  [生效] ${a.title} → ${a.appliedTo.name} ¥${a.appliedTo.beforeFen / 100} → ¥${a.appliedTo.afterFen / 100}`);
for (const s of report.skipped) console.log(`  [跳过] ${s.title} :: ${s.status} :: ${s.reason}`);

ok('匹配结果覆盖全部券（生效 + 跳过 = 券总数）', () => {
  assert.strictEqual(report.applied.length + report.skipped.length, coupons.length);
});
ok('未生效的券都给了真实原因', () => {
  for (const s of report.skipped) assert.ok(s.reason && s.reason.length > 5, `${s.title} 缺原因`);
});
ok('绝不把券后价高于促销价的商品算成省钱', () => {
  for (const a of report.applied) assert.ok(a.appliedTo.afterFen < a.appliedTo.beforeFen);
});
ok('券后价替换进了商品池且带 coupon 字段', () => {
  for (const a of report.applied) {
    const it = report.pool.find((i) => i.code === a.appliedTo.code);
    assert.ok(it, '池里找不到该商品');
    assert.ok(it.coupon, '缺 coupon 字段');
    assert.strictEqual(Math.round(it.price * 100), a.appliedTo.afterFen);
  }
});
ok('未生效的券不改变任何商品价格', () => {
  const changed = report.pool.filter((i) => i.coupon).map((i) => i.code).sort();
  const expect = report.applied.map((a) => a.appliedTo.code).sort();
  assert.deepStrictEqual(changed, expect);
});
ok('幂等：重复调用结果一致', () => {
  const again = C.applyCoupons(pool, coupons, { now: atNoon, channel: '到店' });
  assert.strictEqual(JSON.stringify(again.applied), JSON.stringify(report.applied));
});
ok('无券时池不变', () => {
  const r = C.applyCoupons(pool, [], { now: atNoon });
  assert.strictEqual(r.pool.length, pool.length);
  assert.deepStrictEqual(r.applied, []);
  assert.deepStrictEqual(r.skipped, []);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
