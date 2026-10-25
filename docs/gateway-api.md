# WorkBuddy 本机 Gateway API（HTTP 触发 Skill 的真实入口，已实测）

> 2026-10-24 实测。此前 `docs/backend-plan.md` 里的 `api.workbuddy.com/trigger/xxx` 是占位符，  
> **真实入口在本机**：WorkBuddy 桌面端内置 CodeBuddy Gateway，监听 `127.0.0.1`，可通过 HTTP  
> 向当前 Agent 会话注入消息，从而触发 Skill。官方公开文档未记载此能力，本文档由本机  
> 探测 + 安装包内嵌 OpenAPI 还原，并以实际请求验证。

## 一、端点

基址：`http://127.0.0.1:63698`（端口随会话分配，可在 `~/.workbuddy/sessions/<pid>.json` 的  
`endpoint` 字段读取，不要写死）

| 方法       | 路径                            | 说明                                        |
| -------- | ----------------------------- | ----------------------------------------- |
| GET      | `/api/v1/health`              | 健康检查 `{status:"ok", platforms:[...]}`     |
| GET      | `/api/v1/status`              | 运行状态 `{busy, activeSessionId, runStatus}` |
| POST     | `/api/v1/runs`                | **发起 Agent 执行（核心）**，202 返回 runId          |
| GET      | `/api/v1/runs/{runId}`        | 查询状态 `{runId, active}`                    |
| GET      | `/api/v1/runs/{runId}/stream` | SSE 实时结果流                                 |
| POST     | `/api/v1/runs/{runId}/cancel` | 取消执行                                      |
| GET/POST | `/api/v1/webhooks/{platform}` | 平台回调（generic / wecom / wechat-kf）         |
| GET/POST | `/api/v1/acp`                 | ACP 协议端点（高级客户端）                           |

## 二、鉴权

```text
Authorization: Bearer <CODEBUDDY_GATEWAY_PASSWORD>
```

- 密钥由 WorkBuddy 主进程生成（32 字节 base64url），注入会话进程环境变量  
  `CODEBUDDY_GATEWAY_PASSWORD`，**WorkBuddy 重启后轮换**。
- 未带密钥：`401 {"error":{"code":"AUTH_REQUIRED"}}`。
- 在 WorkBuddy 会话派生的终端里，该环境变量已存在，直接用；独立终端需手动设置。
- **红线：密钥不写进代码、不提交 git、不打印到日志。**

## 三、发起执行（POST /api/v1/runs）

请求体（缺 `id` 或 `type` 会 400）：

```json
{
  "id": "web-001",
  "type": "message",
  "text": "两个人午餐，预算60元，1200大卡以内，不要辣\n【系统约定】traceId=web-001，请用麦门智选助手处理",
  "sender": { "id": "mcd-web", "name": "麦门Web前端" }
}
```

实测响应：

```text
HTTP 202
{"data":{"runId":"fad7a6f6-5df9-4673-b097-d26afaaaf68b","status":"accepted"}}
```

随后 `GET /api/v1/runs/{runId}` 由 `{"data":{"active":true}}` 变为 `active:false` 表示执行结束。

消息会被注入到 WorkBuddy **当前会话**，由会话内 Agent 处理并触发 Skill —— 是异步链路，  
HTTP 只保证"受理"，结果要通过 outbox 轮询或 SSE 拿。

## 四、完整演示链路（Skill 严格为核心）

```text
Web 前端
  → node server/trigger-skill.js --text "..." --traceId web-001
  → POST /api/v1/runs（Bearer 网关密钥）
  → WorkBuddy 会话触发 mcd-smart-order Skill
  → Skill 执行 node server/emit-plan.js（原子写 outbox）
  → 脚本轮询 data/skill-outbox/plan-web-001.json 拿到结果
  → Web 渲染（也可直接轮询 server/bridge.js 的 /api/plan/<traceId>）
```

两条通道的关系：

| 场景                          | 用哪条                               |
| --------------------------- | --------------------------------- |
| 演示"自然语言→Skill"完整能力          | Gateway HTTP 触发（本文件）              |
| Gateway 未运行 / 密钥失效 / 评委环境受限 | 文件桥直写：Skill 仍可由对话触发，Web 轮询 outbox |
| Web 独立联调（不经 Skill）          | 后端 A 的 `/api/plan`（solver 直连）     |

## 五、实测记录（2026-10-24）

```text
GET  /api/v1/health          → 200 {"data":{"status":"ok","platforms":["generic","wecom","wechat-kf"]}}
GET  /api/v1/status          → 200 {"data":{"busy":true,"runStatus":"tool_executing",...}}
POST /api/v1/runs 空 body    → 400 missing required fields (id, type)
POST /api/v1/runs 正式请求   → 202 {"data":{"runId":"fad7a6f6-...","status":"accepted"}}
GET  /api/v1/runs/{runId}    → 200 {"data":{"runId":"...","active":true}}（执行中）
```

## 六、错误速查

| 现象                 | 原因                 | 处理                                      |
| ------------------ | ------------------ | --------------------------------------- |
| 401 AUTH_REQUIRED  | 密钥缺失/已轮换           | 重新读会话进程环境的 `CODEBUDDY_GATEWAY_PASSWORD` |
| 400 missing fields | body 缺 `id`/`type` | 补齐必填字段                                  |
| 429                | 触发频率限制             | 退避重试；网关单会话 busy 时会排队                    |
| 一直 active:true     | 会话正在执行长任务          | 等待或 `POST /runs/{runId}/cancel`         |
| 端口连接拒绝             | WorkBuddy 未运行      | 启动 WorkBuddy 后从 sessions 文件重读端口         |
