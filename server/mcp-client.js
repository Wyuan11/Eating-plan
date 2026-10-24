/**
 * 麦当劳 MCP 直连客户端（streamable HTTP / JSON-RPC）
 *
 * 关键结论（已实测）：https://mcp.mcd.cn 是 standard streamable HTTP MCP Server，
 * 无需 session 握手，直接 POST tools/call 即可。所以后端脚本能自己拉数据，
 * 不必依赖 WorkBuddy 的 MCP 挂载，也不必经过 Skill。
 *
 * 用法：
 *   const { callTool } = require('./mcp-client');
 *   const menu = await callTool('query-meals', { storeCode: '1450713', orderType: 1, beType: 1 });
 *
 * 环境变量：MCD_MCP_TOKEN（从 ~/.workbuddy/mcp.json 取，不要提交到 git）
 */

const ENDPOINT = process.env.MCD_MCP_URL || 'https://mcp.mcd.cn';
const TOKEN = process.env.MCD_MCP_TOKEN;

let seq = 0;

async function rpc(method, params) {
  if (!TOKEN) throw new Error('缺少环境变量 MCD_MCP_TOKEN');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 401) throw new Error('MCP Token 无效或已过期');
  if (res.status === 429) throw new Error('触发限流（600 次/分钟）');
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
  return body.result;
}

/**
 * 调用 MCP 工具。返回 content[0].text（MCP 统一把结果塞在 text 里，
 * 内容可能是 JSON 也可能是 TOON 文本，调用方自行解析）。
 */
async function callTool(name, args = {}) {
  const r = await rpc('tools/call', { name, arguments: args });
  const c = r?.content?.[0];
  if (!c) throw new Error(`${name} 返回为空`);
  const text = c.text ?? c;
  // MCP 工具级错误：HTTP 仍是 200，但 result.isError=true，text 里是错误说明。
  // 不检查的话，下游会把错误提示当成菜单/营养数据解析，排查成本极高。
  if (r.isError) {
    throw new Error(`${name} 工具返回错误：${String(text).slice(0, 300)}`);
  }
  return text;
}

/**
 * 从 MCP 文本里安全切出 JSON。
 *
 * 坑：MCP 返回的是「自然语言字段说明 + ## Original Response + 真 JSON」，
 * 说明段里含 `data.meals.{code}.xxx` 之类的花括号，直接用 indexOf('{') 会切错。
 * 所以：先定位 `{"success"` 起点，再做字符串感知的括号配对，防止尾部多余文本。
 */
function extractJson(text) {
  const s = String(text);
  const i = s.indexOf('{"success"');
  if (i < 0) throw new Error('未找到 JSON 响应体（缺少 {"success" 起点）');
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let p = i; p < s.length; p++) {
    const ch = s[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = p + 1; break; }
    }
  }
  if (end < 0) throw new Error('JSON 括号未配对');
  return JSON.parse(s.slice(i, end));
}

/** 部分工具直接返回 JSON，这里做一次容错解析 */
function parseMaybeJson(text) {
  if (typeof text !== 'string') return text;
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try {
      return JSON.parse(text.slice(i, j + 1));
    } catch {
      /* 落到下面返回原文 */
    }
  }
  return text;
}

module.exports = { callTool, extractJson, parseMaybeJson, rpc };
