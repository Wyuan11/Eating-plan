/**
 * 生成前端联调用的全部 Mock（唯一入口，替代已废弃的 build_mock.py）
 *
 *   node scripts/build_mock.js
 *
 * 产出 web/mock/：
 *   menu.json            门店菜单 —— 直接取真实门店缓存 data/menu-1450713.json（同源）
 *   stores.json          门店列表
 *   plan.success.json    推荐成功
 *   plan.nosolution.json 约束无解
 *   plan.error.json      参数错误
 *   order.success.json   下单成功（支付链接）
 *
 * 两条原则：
 *   1. plan 三态复用 server/emit-plan.js 的 buildPayload —— 与真实落盘同一段代码，
 *      结构永不漂移，数值由 solver 真实求解（不手写）。
 *   2. menu 直接取真实门店缓存，与 emit-plan 求解所用的数据源完全一致，
 *      前端「独立重算校验」才不会遇到菜单里查不到的品。
 */

const fs = require('fs');
const path = require('path');
const { buildPayload } = require('../server/emit-plan');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const MOCK = path.join(ROOT, 'web', 'mock');

const STORE_CODE = '1450713';
const STORE_NAME = '麦当劳上海黄浦华旭国际大厦餐厅';
const STORE_ADDRESS = '南京东路街道西藏中路336号';
// 固定时间戳，保证 mock 可重现、diff 稳定
const FIXED_AT = '2026-10-24T12:50:00.000Z';

const PLAN_SCENARIOS = [
  {
    file: 'plan.success.json',
    traceId: 'mock-success',
    opts: {
      intent: '两个人午餐，预算60元，热量不超过1200大卡，不要辣',
      constraints: { budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'] },
      objective: 'balanced',
    },
    expect: 'success',
  },
  {
    file: 'plan.nosolution.json',
    traceId: 'mock-nosolution',
    opts: {
      intent: '三个人吃午饭，预算只有15元',
      constraints: { budget: 15, calorie_limit: null, people: 3, excluded: [] },
      objective: 'balanced',
    },
    expect: 'nosolution',
  },
  {
    file: 'plan.error.json',
    traceId: 'mock-error',
    opts: {
      intent: '预算0元',
      constraints: { budget: 0, calorie_limit: null, people: 1, excluded: [] },
      objective: 'balanced',
    },
    expect: 'error',
  },
];

function write(file, obj) {
  const target = path.join(MOCK, file);
  fs.writeFileSync(target, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  return target;
}

function buildMenu() {
  const real = path.join(DATA, `menu-${STORE_CODE}.json`);
  if (!fs.existsSync(real)) {
    throw new Error(`缺少真实门店缓存 ${real}，先跑 node server/fetch-menu.js --store ${STORE_CODE}`);
  }
  const src = JSON.parse(fs.readFileSync(real, 'utf8'));
  const items = src.items || [];
  write('menu.json', {
    success: true,
    store: { code: STORE_CODE, name: STORE_NAME, address: STORE_ADDRESS },
    count: items.length,
    items,
    meta: { generatedAt: FIXED_AT, source: `真实门店缓存 menu-${STORE_CODE}.json` },
  });
  return items.length;
}

function buildStores() {
  write('stores.json', {
    success: true,
    items: [
      { code: STORE_CODE, name: STORE_NAME, address: STORE_ADDRESS, distance: '0.3km', beType: 1 },
      { code: '1450801', name: '麦当劳上海黄浦南京东路餐厅', address: '南京东路720号', distance: '0.8km', beType: 1 },
      { code: '1450912', name: '麦当劳上海黄浦人民广场餐厅', address: '西藏中路268号', distance: '1.2km', beType: 1 },
    ],
    meta: { generatedAt: FIXED_AT, source: 'mcd-mcp query-nearby-stores' },
  });
}

function buildPlans() {
  let failed = 0;
  let successPlan = null;
  for (const s of PLAN_SCENARIOS) {
    const payload = buildPayload({ traceId: s.traceId, ...s.opts });
    payload.createdAt = FIXED_AT;
    if (payload.meta) payload.meta.generatedAt = FIXED_AT;

    const ok = payload.status === s.expect;
    if (!ok) failed++;

    write(s.file, payload);
    if (s.expect === 'success') successPlan = payload;

    const summary =
      payload.status === 'success'
        ? `${payload.items.map((i) => `${i.name}×${i.quantity}`).join(' + ')} = ¥${payload.plan.total_price} / ${payload.plan.total_calorie}kcal`
        : payload.status === 'nosolution'
          ? `conflict=${payload.conflict} | hint=${payload.hint}`
          : `code=${payload.error?.code} | ${payload.error?.detail}`;

    console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${s.file.padEnd(22)} status=${String(payload.status).padEnd(10)} ${summary}`);
    if (!ok) console.log(`        预期 status=${s.expect}，实际=${payload.status}`);
  }
  return { failed, successPlan };
}

function buildOrder(successPlan) {
  // 支付链接是占位域名，绝不指向真实支付；只用于演示二维码渲染
  write('order.success.json', {
    success: true,
    message: '订单已创建，请在 15 分钟内完成支付',
    order: {
      orderId: 'MOCK202610240001',
      total_price: successPlan ? successPlan.plan.total_price : 0,
      payH5Url: 'https://example.com/pay/MOCK202610240001',
      expireAt: '2026-10-24T13:05:00+08:00',
    },
    meta: { storeName: STORE_NAME, storeCode: STORE_CODE, generatedAt: FIXED_AT },
  });
}

function main() {
  if (!fs.existsSync(MOCK)) fs.mkdirSync(MOCK, { recursive: true });

  const n = buildMenu();
  console.log(`[OK]   ${'menu.json'.padEnd(22)} ${n} 品（源：data/menu-${STORE_CODE}.json）`);
  buildStores();
  console.log(`[OK]   ${'stores.json'.padEnd(22)} 3 家门店`);
  const { failed, successPlan } = buildPlans();
  buildOrder(successPlan);
  console.log(`[OK]   ${'order.success.json'.padEnd(22)} 支付链接占位`);

  console.log(`\nmock -> ${MOCK}`);
  if (failed) {
    console.error(`[FAIL] ${failed} 个场景状态不符合预期`);
    process.exit(1);
  }
}

if (require.main === module) main();