# 麦门智选助手

WayToAGI 1024 AI 切磋大会 · 用餐赛道 / 麦当劳程序员创意开发大赛。

以 **Skill 为核心**、Web 仅做渲染层的智能点单助手：自然语言 → 约束提取 → 确定性求解 → 方案落盘 → 前端展示。
主打「控卡 + 省钱」双目标（预算 × 热量 × 忌口 × 人数 四维求解）。

## 快速开始

最简单的方式——双击 **`start.bat`**（后端 3000 + 前端 5173）。使用方式详见 `docs/使用说明.md`。

命令行方式（Skill / 调试链路）：

```bash
# 1. 首次 clone 后必须执行一次：启用提交前密钥检查钩子
git config core.hooksPath githooks

# 2. 配置麦当劳 MCP Token（后端会自动读取 .env，无需手动 set）
cp .env.example .env        # 填入真实 Token，.env 已被 .gitignore 忽略

# 3. 验证 MCP 链路（只读，不下单）
node server/verify-mcp.js

# 4. 生成一份方案并落盘
node server/emit-plan.js --traceId demo-001 --budget 60 --calorie 1200 --people 2 --exclude 辣 --want "麦香鸡x2"

# 5. 启动文件桥，供前端轮询
node server/bridge.js --port 8787
```

## 常用维护命令

```bash
node scripts/build_mock.js          # 重生成全部 Mock（plan 三态由 solver 真实求解）
node scripts/demo-check.js          # 演示前自检（8 项）
node scripts/demo-check.js --online # 额外实测 MCP 连通性（需 Token）
node scripts/clean-outbox.js        # 清理历史方案文件（默认预演，加 --yes 才删）
node server/fetch-menu.js --offline # 完全离线重跑营养匹配（菜单与营养都读本地缓存）
```

## 目录

| 路径 | 说明 |
|---|---|
| `server/mcp-client.js` | MCP 直连客户端（检查 `isError`、15s 超时、`extractJson`） |
| `server/fetch-menu.js` | 菜单与营养数据管道，产出 `data/menu-<storeCode>.json` |
| `server/solver.js` | 确定性求解器 v2（正向诉求 wants / 品类级忌口 / 温度披露 / 简称匹配 / max_value，`solver.v1.bak.js` 为旧版备份） |
| `server/emit-plan.js` | 约束 → 求解 → 原子落盘，Skill 侧唯一入口 |
| `server/outbox.js` / `bridge.js` | 文件桥：tmp→fsync→rename 原子写 + `GET /api/plan/<traceId>` |
| `server/trigger-skill.js` | 经本机 Gateway HTTP 触发 Skill 并轮询结果 |
| `.workbuddy/skills/mcd-smart-order/` | Skill 包（约束提取规则 + 测试用例） |
| `web/` | Vue3 + Vite 前端渲染壳（只渲染与算术校验，不直连 MCP） |
| `web/src/lib/normalize.js` | 契约归一化：任意响应 → canonical v1.1（三态 + request.constraints） |
| `docs/` | `使用说明.md`(面向使用者/评委) / `api-schema.md`(契约) / `gateway-api.md`(HTTP 触发协议) / `team-sync.md`(协作同步) / `git-collab.md`(协作流程) |

### 前端启动

```bash
cd web
npm install
npm run dev        # http://localhost:5173，/api 已代理到 3000
```

### 与队友同步代码（无远端时用 git bundle）

```bash
bash scripts/bundle-out.sh              # 打包成 bundles/*.bundle，发给队友
bash scripts/bundle-in.sh <收到的文件>   # 校验并拉取队友的分支（不自动合并）
```

细节见 `docs/git-collab.md`。**手敲命令时必须用 `--branches HEAD`**：用 `--all` 队友看不到协作分支，漏了 `HEAD` 队友 clone 完工作区是空的。

方案落盘位置：`data/skill-outbox/plan-<traceId>.json`（运行时产物，已忽略）。
方案未生成时桥接返回 **404 + `status:"pending"`**，前端应继续轮询，不要当失败。

## 提交规范

- 提交前钩子会拦截 `Bearer <密钥>`、`MCD_MCP_TOKEN=<值>`、`CODEBUDDY_GATEWAY_PASSWORD=<值>` 明文。
- 确需绕过：`git commit --no-verify`（仅在确认安全时使用）。

## 红线

- 下单止于支付链接：`create-order` 仅用于获取订单号与 `payH5Url`，**不支付、不自动跳转**；演示固定门店 `1450713` + 到店自取（`orderType=1, beType=1`）。
- 未知热量一律 `null`（`calorie_source: "unknown"`），**不得估算、不得当 0**。
- 两枚密钥（MCP Token、Gateway 密钥）不进代码、不进 git。
- MCP 限流 600 次/分钟；Skill 必须在链路核心，Web 不直连 MCP。
