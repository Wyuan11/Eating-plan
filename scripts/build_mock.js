/**
 * 生成前端联调用的 plan mock（success / nosolution / error 三态）
 *
 * 关键：复用 server/emit-plan.js 的 buildPayload —— 和真实落盘走同一段代码，
 * 因此 Mock 与线上结构永远一致，不会出现「Mock 旧、真实新」的漂移。
 * 数值全部由 solver 真实求解得出，不手写，前端「独立重算校验」可直接验证。
 *
 * 用法：node scripts/build_mock.js
 * 产出：web/mock/plan.success.json / plan.nosolution.json / plan.error.json
 * 注：menu.json 与 stores.json 仍由 scripts/build_mock.py 从实测快照生成。
 */

const fs = require('fs');
const path = require('path');
const { buildPayload } = require('../server/emit-plan');

const ROOT = path.join(__dirname, '..');
const MOCK = path.join(ROOT, 'web', 'mock');
// 固定时间戳，保证 mock 可重现、diff 稳定
const FIXED_AT = '2026-10-24T12:50:00.000Z';

const SCENARIOS = [
  {
    file: 'plan.success.json',
    traceId: 'mock-success',
    label: '成功：两人午餐 60 元 / 1200 大卡 / 忌辣',
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
    label: '无解：三人 15 元',
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
    label: '错误：预算为 0（参数非法）',
    opts: {
      intent: '预算0元',
      constraints: { budget: 0, calorie_limit: null, people: 1, excluded: [] },
      objective: 'balanced',
    },
    expect: 'error',
  },
];

function main() {
  if (!fs.existsSync(MOCK)) fs.mkdirSync(MOCK, { recursive: true });

  let failed = 0;
  for (const s of SCENARIOS) {
    const payload = buildPayload({ traceId: s.traceId, ...s.opts });
    // 固定动态字段，避免每次生成都产生 diff
    payload.createdAt = FIXED_AT;
    if (payload.meta) payload.meta.generatedAt = FIXED_AT;

    const ok = payload.status === s.expect;
    if (!ok) failed++;

    const target = path.join(MOCK, s.file);
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const summary =
      payload.status === 'success'
        ? `${payload.items.map((i) => `${i.name}×${i.quantity}`).join(' + ')} = ¥${payload.plan.total_price} / ${payload.plan.total_calorie}kcal`
        : payload.status === 'nosolution'
          ? `conflict=${payload.conflict} | hint=${payload.hint}`
          : `code=${payload.error?.code} | ${payload.error?.detail}`;

    console.log(
      `${ok ? '[OK]  ' : '[FAIL]'} ${s.file.padEnd(22)} status=${String(payload.status).padEnd(10)} ${summary}`,
    );
    if (!ok) console.log(`        预期 status=${s.expect}，实际=${payload.status}`);
  }

  console.log(`\nmock -> ${MOCK}`);
  if (failed) {
    console.error(`[FAIL] ${failed} 个场景状态不符合预期`);
    process.exit(1);
  }
}

if (require.main === module) main();
