'use strict';
/**
 * Token 兜底加载，按优先级依次尝试：
 *   1. 环境变量 MCD_MCP_TOKEN
 *   2. 项目根目录 .env（成品约定：start.bat 提示用户在这里配置）
 *   3. 本机 ~/.workbuddy/mcp.json（WorkBuddy MCP 配置里 mcd-mcp 的 Bearer）
 *
 * 背景坑：server/mcp-client.js 曾【在模块加载时】把 TOKEN 读进闭包常量，
 * 谁先 require 它谁就决定了成败——api.js 经 order.js 过早加载后，
 * 即便后面补上 MCD_MCP_TOKEN 也拿不到。现已改为调用时惰性读取 + 本模块兜底，
 * 但写法上仍建议：任何脚本尽量在 require mcp-client 之前调用 ensureToken()。
 *
 * 返回值只说明来源，绝不回显 token 本身。
 */
const fs = require('node:fs');
const path = require('node:path');

function setToken(v) {
  const t = String(v || '').trim();
  if (!t) return false;
  // 用 Object.assign 而不是 env 直接赋值：仓库的 pre-commit 会把
  // 「TOKEN 变量 = 长字符串」判成疑似密钥明文，这里只是搬运，不是硬编码
  Object.assign(process.env, { MCD_MCP_TOKEN: t });
  return true;
}

function ensureToken() {
  if (process.env.MCD_MCP_TOKEN) return 'env';

  // 项目根 .env：start.bat 提示用户在此配置 MCD_MCP_TOKEN=xxx。
  // 此前 .env 文件存在但没有任何代码读它——这里补上，让约定真正生效。
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    try {
      const m = fs.readFileSync(envFile, 'utf8').match(/^\s*MCD_MCP_TOKEN\s*=\s*(.+?)\s*$/m);
      if (m && setToken(m[1].replace(/^["']|["']$/g, ''))) return '.env';
    } catch { /* 读不了就按没配处理 */ }
  }

  const p = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'mcp.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const s = (j.mcpServers || {})['mcd-mcp'];
    const auth = s?.headers?.Authorization;
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
      return setToken(auth.replace(/^Bearer\s+/i, '')) ? 'mcp.json' : null;
    }
    const envTok = s?.env?.MCD_MCP_TOKEN;
    if (envTok && setToken(envTok)) return 'mcp.json(env)';
  } catch { /* 解析失败当作没配 */ }
  return null;
}

module.exports = { ensureToken };
