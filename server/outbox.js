/**
 * outbox 读写：Skill 落盘方案，Web 侧轮询读取
 *
 * 目录：data/skill-outbox/plan-<traceId>.json
 * 写入：先写 .tmp → fsync 关闭 → rename（原子替换，前端不会读到半截 JSON）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUTBOX = process.env.MCD_OUTBOX || path.join(ROOT, 'data', 'skill-outbox');

function ensureDir() {
  fs.mkdirSync(OUTBOX, { recursive: true });
}

function fileOf(traceId) {
  if (!/^[\w.-]+$/.test(String(traceId))) {
    throw new Error(`非法 traceId: ${traceId}（只允许字母数字 _ - .）`);
  }
  return path.join(OUTBOX, `plan-${traceId}.json`);
}

/** 原子写入，返回最终文件路径 */
function writePlan(traceId, planObj) {
  ensureDir();
  const target = fileOf(traceId);
  const tmp = `${target}.tmp`;
  const body = JSON.stringify(planObj, null, 2);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
  return target;
}

function readPlan(traceId) {
  const text = fs.readFileSync(fileOf(traceId), 'utf8');
  return JSON.parse(text); // JSON 损坏时抛 SyntaxError，由调用方转成可识别错误
}

/** 最近方案列表（新的在前），只回传摘要，避免把整份菜单塞给前端 */
function listPlans(limit = 20) {
  ensureDir();
  return fs.readdirSync(OUTBOX)
    .filter((f) => /^plan-.*\.json$/.test(f))
    .map((f) => {
      const full = path.join(OUTBOX, f);
      let status = 'unknown';
      try {
        status = JSON.parse(fs.readFileSync(full, 'utf8')).status || 'unknown';
      } catch {
        status = 'broken';
      }
      return { traceId: f.replace(/^plan-/, '').replace(/\.json$/, ''), file: f, status, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}

module.exports = { OUTBOX, writePlan, readPlan, listPlans };
