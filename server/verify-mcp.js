/**
 * Skill + MCP 最小连通性验证（只读）
 *
 * 只做三件事，不写任何文件、不下单、不支付：
 *   1. now-time-info          → 证明 HTTPS + Bearer + tools/call 链路通
 *   2. query-meals            → 证明固定门店菜单可读（到店自取）
 *   3. list-nutrition-foods   → 证明官方营养表可读
 *
 * 用法（先设环境变量 MCD_MCP_TOKEN）：
 *   node server/verify-mcp.js
 */

const { callTool, extractJson } = require('./mcp-client');

const STORE_CODE = process.env.MCD_STORE_CODE || '1450713';
const failures = [];

function cut(s, n = 300) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + ' …' : t;
}

async function step(title, fn) {
  process.stdout.write('\n' + '-'.repeat(58) + '\n');
  process.stdout.write(`[STEP] ${title}\n`);
  const t0 = Date.now();
  try {
    await fn();
    process.stdout.write(`[PASS] ${title}  (${Date.now() - t0}ms)\n`);
  } catch (e) {
    failures.push(title);
    process.stdout.write(`[FAIL] ${title}  (${Date.now() - t0}ms)\n       ${e.message}\n`);
  }
}

async function main() {
  process.stdout.write('麦门智选助手 · MCP 连通性验证（只读）\n');
  process.stdout.write(`端点: ${process.env.MCD_MCP_URL || 'https://mcp.mcd.cn'}\n`);
  process.stdout.write(`门店: ${STORE_CODE}\n`);

  await step('1/3 now-time-info', async () => {
    const text = await callTool('now-time-info');
    process.stdout.write(`       返回: ${cut(text, 260)}\n`);
  });

  await step('2/3 query-meals（到店自取 orderType=1 beType=1）', async () => {
    const text = await callTool('query-meals', {
      storeCode: STORE_CODE,
      orderType: 1,
      beType: 1,
    });
    const d = extractJson(text);
    const root = d.data || {};
    if (d.success !== true || d.code !== 200) {
      throw new Error(`业务码异常 success=${d.success} code=${d.code} msg=${d.message}`);
    }
    // 真实结构：data.categories[] 是分类（每项 meals 只有 code+tags），
    // data.meals 是 { code: 详情 } 的映射表。两者都要有，否则菜单不完整。
    const cats = Array.isArray(root.categories) ? root.categories : [];
    const mealMap = root.meals && typeof root.meals === 'object' ? root.meals : {};
    const mealKeys = Object.keys(mealMap);
    const catMealCount = cats.reduce((n, c) => n + (Array.isArray(c.meals) ? c.meals.length : 0), 0);
    if (!cats.length || !mealKeys.length) {
      throw new Error(`菜单为空 categories=${cats.length} meals=${mealKeys.length}`);
    }
    process.stdout.write(`       分类数: ${cats.length}  分类内条目: ${catMealCount}  详情映射: ${mealKeys.length}\n`);
    process.stdout.write(`       分类名: ${cats.map((c) => c.name).join(' / ')}\n`);
    const sample = mealKeys.slice(0, 3).map((k) => ({
      code: k,
      name: mealMap[k].name,
      currentPrice: mealMap[k].currentPrice,
    }));
    process.stdout.write(`       样例(原始字段): ${JSON.stringify(sample)}\n`);
    process.stdout.write(`       注意: 原始字段是 currentPrice/originalPrice，需映射成 Schema 的 price/original_price\n`);
  });

  await step('3/3 list-nutrition-foods', async () => {
    const text = await callTool('list-nutrition-foods');
    const t = String(text);
    const m = t.match(/\[(\d+)\]\{([^}]*)\}:/);
    if (m) {
      process.stdout.write(`       TOON 表头: 记录数=${m[1]} 字段=${m[2]}\n`);
    } else {
      const j = extractJson(t);
      process.stdout.write(`       非 TOON 格式，长度=${t.length}，JSON解析=${j ? 'OK' : 'NO'}\n`);
    }
    process.stdout.write(`       片段: ${cut(t, 240)}\n`);
  });

  process.stdout.write('\n' + '='.repeat(58) + '\n');
  if (failures.length === 0) {
    process.stdout.write('结论：MCP 直连链路可用（只读三项全部通过）\n');
    process.stdout.write('下一步：用 4 条自然语言样例验证 Skill 约束提取，再定桥接方式\n');
  } else {
    process.stdout.write(`结论：${failures.length} 项未通过 → ${failures.join(' | ')}\n`);
    process.stdout.write('下一步：按上面 FAIL 行定位（401=Token/429=限流/空返回=参数或工具名）\n');
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  process.stdout.write(`[FATAL] ${e.message}\n`);
  process.exit(1);
});
