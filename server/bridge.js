/**
 * 文件桥（Skill → Web 的保底通道，不依赖任何外部 HTTP 触发能力）
 *
 * 协议（与 docs/backend-plan.md 一致）：
 *   Skill 侧：把方案写成 data/skill-outbox/plan-<traceId>.json（原子写：tmp → rename）
 *   本服务：GET /api/plan/:traceId  轮询取方案
 *           GET /api/plans          列出最近方案（调试用）
 *           GET /api/health         健康检查
 *
 * 用法：
 *   node server/bridge.js                 # 启动桥接服务，默认 8787
 *   node server/bridge.js --port 9000
 *   node server/bridge.js --selftest      # 离线自检：写入→读回→校验→清理（不联网）
 *
 * 硬性约束：
 *   - 未知热量必须是 null，不能是 0
 *   - 不写 Token、不触发下单、不触发支付
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { writePlan, readPlan, listPlans, OUTBOX } = require('./outbox');

const DEFAULT_PORT = 8787;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function createServer() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (p === '/api/health') {
      return json(res, 200, { ok: true, outbox: OUTBOX, count: listPlans().length });
    }

    if (p === '/api/plans') {
      return json(res, 200, { ok: true, items: listPlans() });
    }

    const m = p.match(/^\/api\/plan\/([\w.-]+)$/);
    if (m) {
      const traceId = m[1];
      try {
        const plan = readPlan(traceId);
        return json(res, 200, { ok: true, traceId, plan });
      } catch (e) {
        // 404 表示“还没写入”，前端应继续轮询，而不是当成失败
        if (e.code === 'ENOENT') {
          return json(res, 404, { ok: false, traceId, status: 'pending', message: '方案尚未生成' });
        }
        if (e instanceof SyntaxError) {
          return json(res, 500, { ok: false, traceId, status: 'error', message: '方案文件 JSON 解析失败' });
        }
        return json(res, 500, { ok: false, traceId, status: 'error', message: e.message });
      }
    }

    return json(res, 404, { ok: false, message: 'not found' });
  });
}

/** 离线自检：不联网、不调 MCP，只验证读写与原子性 */
function selftest() {
  const traceId = `selftest-${Date.now()}`;
  const sample = {
    traceId,
    createdAt: new Date().toISOString(),
    request: {
      storeCode: '1450713',
      constraints: { budget: 60, calorie_limit: 1200, people: 2, excluded: ['辣'] },
    },
    status: 'success',
    plan: {
      total_price: 56.5,
      total_calorie: 962,
      // 故意放一条未知热量：必须是 null
      items: [{ code: '1100', name: '巨无霸', qty: 1, price: 25.5, calorie: 550, calorie_source: 'official' },
              { code: '9999', name: '未知新品', qty: 1, price: 12, calorie: null, calorie_source: 'unknown' }],
    },
  };

  const file = writePlan(traceId, sample);
  const ok1 = fs.existsSync(file);
  const back = readPlan(traceId);
  const ok2 = back.traceId === traceId;
  const ok3 = back.plan.items[1].calorie === null;
  const ok4 = listPlans().some((x) => x.traceId === traceId);
  fs.unlinkSync(file); // 自检不留垃圾

  const pass = ok1 && ok2 && ok3 && ok4;
  console.log(`写入文件: ${file}`);
  console.log(`  文件已生成: ${ok1}`);
  console.log(`  读回 traceId 一致: ${ok2}`);
  console.log(`  未知热量保持 null: ${ok3}`);
  console.log(`  可被列表发现: ${ok4}`);
  console.log(pass ? '[PASS] 文件桥自检通过' : '[FAIL] 文件桥自检未通过');
  process.exit(pass ? 0 : 1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) return selftest();

  const i = args.indexOf('--port');
  const port = Number(i >= 0 ? args[i + 1] : process.env.BRIDGE_PORT || DEFAULT_PORT);
  createServer().listen(port, () => {
    console.log(`文件桥服务已启动: http://localhost:${port}`);
    console.log(`监听目录: ${OUTBOX}`);
    console.log(`  GET /api/health`);
    console.log(`  GET /api/plan/<traceId>`);
    console.log(`  GET /api/plans`);
  });
}

if (require.main === module) main();

module.exports = { createServer, selftest, writePlan, readPlan, listPlans, OUTBOX };
