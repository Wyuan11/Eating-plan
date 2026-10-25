/**
 * 演示前一键自检：把「能不能上台演示」变成一条命令
 *
 *   node scripts/demo-check.js            # 离线自检（不需要 Token）
 *   node scripts/demo-check.js --online   # 额外实测 MCP 连通性（需要 MCD_MCP_TOKEN）
 *
 * 检查项：Node 版本 / 关键文件 / 菜单健康 / solver 三态 / Mock 与真实结构一致 /
 *         文件桥 HTTP 接口 / （可选）MCP 连通性
 * 退出码 0 = 可演示，1 = 有阻塞项。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const ONLINE = argv.includes('--online');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ ok: true, name, detail: detail || '' });
    console.log(`[PASS] ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ ok: false, name, detail: e.message });
    console.log(`[FAIL] ${name}  ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: true, name, detail: detail || '' });
    console.log(`[PASS] ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ ok: false, name, detail: e.message });
    console.log(`[FAIL] ${name}  ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => reject(new Error('请求超时')));
  });
}

async function main() {
  console.log('=== 麦门智选助手 · 演示前自检 ===\n');

  // 1. 运行环境
  check('Node 版本', () => {
    const v = process.versions.node.split('.').map(Number);
    assert(v[0] >= 18, `Node 版本过低：${process.versions.node}`);
    return `v${process.versions.node}`;
  });

  // 2. 关键文件
  check('关键文件齐全', () => {
    const need = [
      'server/mcp-client.js', 'server/fetch-menu.js', 'server/solver.js',
      'server/emit-plan.js', 'server/outbox.js', 'server/bridge.js',
      'server/trigger-skill.js', 'server/verify-mcp.js',
      'web/mock/menu.json', 'web/mock/plan.success.json',
      'web/mock/plan.nosolution.json', 'web/mock/plan.error.json',
      'web/src/types.ts',
      '.workbuddy/skills/mcd-smart-order/SKILL.md',
    ];
    const miss = need.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    assert(miss.length === 0, `缺失：${miss.join(', ')}`);
    return `${need.length} 个文件`;
  });

  // 3. 菜单数据健康（v1.1 solver 遇缺失营养会整体报错，必须提前发现）
  let menu = null;
  check('菜单数据健康', () => {
    menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/mock/menu.json'), 'utf8'));
    const items = menu.items || [];
    const trusted = items.filter((i) => i.kind === 'single' && i.calorie_source === 'official');
    const bad = trusted.filter(
      (i) => !i.nutrition || ['protein', 'fat', 'carbohydrate', 'sodium', 'calcium']
        .some((k) => typeof i.nutrition[k] !== 'number' || !Number.isFinite(i.nutrition[k])),
    );
    assert(trusted.length > 0, '可信池为空，无法求解');
    assert(bad.length === 0, `${bad.length} 品营养缺失会导致 solver 报错：${bad.slice(0, 3).map((i) => i.name).join(',')}`);
    return `${items.length} 品 / 可信池 ${trusted.length}`;
  });

  // 4. solver 三态
  check('solver 三态可用', () => {
    const { solve } = require(path.join(ROOT, 'server/solver'));
    const ok = solve(menu.items, { budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'], storeCode: '1450713' });
    assert(ok.success && ok.plan, '有解场景失败（演示主场景！）');
    const no = solve(menu.items, { budget: 15, people: 3, storeCode: '1450713' });
    assert(!no.success && (no.reason || no.error), '无解场景未给出原因');
    const err = solve(menu.items, { budget: 0, people: 1, storeCode: '1450713' });
    assert(!err.success && err.error, '参数错误场景未返回 error');
    return `有解 ¥${ok.plan.total_price}/${ok.plan.total_calorie}kcal`;
  });

  // 5. Mock 与真实落盘结构一致（漂移会让前端接上就崩）
  check('Mock 与落盘结构一致', () => {
    const { buildPayload } = require(path.join(ROOT, 'server/emit-plan'));
    const real = buildPayload({ traceId: 'check-struct', constraints: { budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'] } });
    for (const [f, expect] of [['plan.success.json', 'success'], ['plan.nosolution.json', 'nosolution'], ['plan.error.json', 'error']]) {
      const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'web/mock', f), 'utf8'));
      assert(m.status === expect, `${f} 的 status=${m.status}，应为 ${expect}`);
      const dk = Object.keys(real).filter((k) => !(k in m));
      assert(dk.length === 0, `${f} 缺少字段：${dk.join(',')}`);
    }
    return '三态字段零差异';
  });

  // 6. 文件桥 HTTP 接口（同进程起服务，测完即关，不留后台进程）
  await checkAsync('文件桥接口可用', async () => {
    const { createServer, writePlan } = require(path.join(ROOT, 'server/bridge'));
    const server = createServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const health = await get(`${base}/api/health`);
      assert(health.status === 200, `/api/health 返回 ${health.status}`);
      // 未生成时应是 404 + pending，前端据此继续轮询
      const pending = await get(`${base}/api/plan/check-demo-404`);
      assert(pending.status === 404, `未生成的方案应返回 404，实际 ${pending.status}`);
      const p = JSON.parse(pending.body);
      assert(p.status === 'pending', `未生成时 status 应为 pending，实际 ${p.status}`);
      writePlan('check-demo-001', { traceId: 'check-demo-001', status: 'success', plan: { total_price: 1, total_calorie: 2 } });
      const got = await get(`${base}/api/plan/check-demo-001`);
      assert(got.status === 200, `已生成方案应返回 200，实际 ${got.status}`);
      return 'health 200 / 未生成 404+pending / 已生成 200';
    } finally {
      await new Promise((r) => server.close(r));
      const f = path.join(ROOT, 'data/skill-outbox/plan-check-demo-001.json');
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  // 7. MCP 连通性（可选，需要 Token）
  if (ONLINE) {
    await checkAsync('MCP 连通性', async () => {
      assert(process.env.MCD_MCP_TOKEN, '未设置 MCD_MCP_TOKEN');
      const { callTool, extractJson } = require(path.join(ROOT, 'server/mcp-client'));
      const t = await callTool('now-time-info');
      const d = extractJson(t);
      assert(d, '返回无法解析为 JSON');
      return `now-time-info 正常`;
    });
  } else {
    console.log('[SKIP] MCP 连通性（加 --online 实测，需要 MCD_MCP_TOKEN）');
  }

  // 汇总
  const fail = results.filter((r) => !r.ok);
  console.log(`\n=== ${results.length - fail.length}/${results.length} 通过 ===`);
  if (fail.length) {
    console.log('阻塞项：');
    fail.forEach((f) => console.log(`  - ${f.name}：${f.detail}`));
    console.log('\n结论：暂不具备演示条件，先修上面几项。');
    process.exit(1);
  }
  console.log('结论：可以演示。启动 `node server/bridge.js --port 8787` 供前端取数据。');
}

main().catch((e) => {
  console.error('自检脚本异常：', e);
  process.exit(1);
});
