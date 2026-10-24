# 麦门智选助手

WayToAGI 1024 AI 切磋大会 · 用餐赛道 / 麦当劳程序员创意开发大赛。

以 **Skill 为核心**、Web 仅做渲染层的智能点单助手：自然语言 → 约束提取 → 确定性求解 → 方案落盘 → 前端展示。
主打「控卡 + 省钱」双目标（预算 × 热量 × 忌口 × 人数 四维求解）。

## 快速开始

```bash
# 1. 首次 clone 后必须执行一次：启用提交前密钥检查钩子
git config core.hooksPath githooks

# 2. 配置麦当劳 MCP Token（从 ~/.workbuddy/mcp.json 里 Bearer 后那串复制）
cp .env.example .env        # 填入真实 Token，.env 已被 .gitignore 忽略
export MCD_MCP_TOKEN=xxx    # Windows: set MCD_MCP_TOKEN=xxx

# 3. 验证 MCP 链路（只读，不下单）
node server/verify-mcp.js

# 4. 生成一份方案并落盘
node server/emit-plan.js --traceId demo-001 --budget 60 --calorie 1200 --people 2 --exclude 辣

# 5. 启动文件桥，供前端轮询
node server/bridge.js --port 8787
```

## 目录

| 路径 | 说明 |
|---|---|
| `server/mcp-client.js` | MCP 直连客户端（检查 `isError`、15s 超时、`extractJson`） |
| `server/fetch-menu.js` | 菜单与营养数据管道，产出 `data/menu-<storeCode>.json` |
| `server/solver.js` | 确定性求解器 v1.1（`solver.v1.bak.js` 为旧版备份） |
| `server/emit-plan.js` | 约束 → 求解 → 原子落盘，Skill 侧唯一入口 |
| `server/outbox.js` / `bridge.js` | 文件桥：tmp→fsync→rename 原子写 + `GET /api/plan/<traceId>` |
| `server/trigger-skill.js` | 经本机 Gateway HTTP 触发 Skill 并轮询结果 |
| `.workbuddy/skills/mcd-smart-order/` | Skill 包（约束提取规则 + 测试用例） |
| `docs/` | `api-schema.md`(契约) / `gateway-api.md`(HTTP 触发协议) / `team-sync.md`(协作同步) |

方案落盘位置：`data/skill-outbox/plan-<traceId>.json`（运行时产物，已忽略）。
方案未生成时桥接返回 **404 + `status:"pending"`**，前端应继续轮询，不要当失败。

## 提交规范

- 提交前钩子会拦截 `Bearer <密钥>`、`MCD_MCP_TOKEN=<值>`、`CODEBUDDY_GATEWAY_PASSWORD=<值>` 明文。
- 确需绕过：`git commit --no-verify`（仅在确认安全时使用）。

## 红线

- 不调用 `create-order`，不执行真实支付；演示固定门店 `1450713` + 到店自取（`orderType=1, beType=1`）。
- 未知热量一律 `null`（`calorie_source: "unknown"`），**不得估算、不得当 0**。
- 两枚密钥（MCP Token、Gateway 密钥）不进代码、不进 git。
- MCP 限流 600 次/分钟；Skill 必须在链路核心，Web 不直连 MCP。
