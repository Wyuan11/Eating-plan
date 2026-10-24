# 项目进度与缺口清单

> 盘点时间：2026-10-24 15:20（Day 1 下午）
> 盘点方式：逐文件核对 + 实跑脚本，非凭记忆。当前 `main` 提交 `0842c1c`，工作区干净。

---

## 一、已经能跑的（均有实测证据）

| 能力 | 证据 |
|---|---|
| MCP 直连（时间/菜单/营养） | `node server/verify-mcp.js` 三项 PASS |
| 菜单与营养缓存、真离线 | `data/menu-1450713.json` 125 品 / 可信池 34；`--offline` 实测不联网 |
| 确定性求解器 v1.1 | 三态 + `objective` 目标切换，主方案 ¥56.9 / 962kcal |
| 文件桥（原子落盘 + HTTP） | `outbox.js` tmp→fsync→rename；`bridge.js` health 200 / 未生成 404+pending / 已生成 200 |
| HTTP 触发 Skill | 本机 Gateway `POST /api/v1/runs` → 202 + runId，会话内执行并落盘 |
| 网关失效降级 | 端口自动发现；不可达时用结构化约束本地直算 |
| 前端渲染壳 | `npm run build` 39 modules 通过，`vite preview` 访问 200 |
| 契约一致性 | Mock 与真实落盘字段零差异（同一段代码生成） |
| 演示前一键自检 | `node scripts/demo-check.js` 6/6 |
| Git 与协作 | 3 分支、密钥拦截钩子（实测拦住）、bundle 离线协作（往返实测） |

**一句话**：从「用户说话」到「Web 拿到方案」的链路已闭合，Skill 在链路核心位置。

---

## 二、还缺什么（按归属）

### 后端 A（阻塞最严重）

| # | 缺口 | 具体位置 | 影响 |
|---|---|---|---|
| 1 | **`server/api.js` 未开工** | 5 个接口：`GET /api/stores`、`GET /api/menu`、`POST /api/plan`、`POST /api/order`、`GET /api/health` | 前端 Vite 已把 `/api` 代理到 3000，后端不起就一直走 mock |
| 2 | **`create-order` 未接** | 到生成支付链接为止，**不真实支付** | 演示最后一环「去下单」缺失 |
| 3 | **`nutritionToMap` 归零缺陷** | `server/fetch-menu.js:116-121`，`Number(r.energyKcal) \|\| 0` | 官方营养缺字段时会变成「0 大卡/0 钠」的假数据进可信池。当前数据未触发（缺失 0 项），属**潜伏**缺陷；solver v1.1 严格化后会放大 |
| 4 | **菜单缺详情条目** | 分类条目 140 vs 详情映射 125/129 | 必须跳过无详情的 code，否则产出 `undefined` 单品污染可信池 |
| 5 | **返回结构必须复用 `emit-plan` 的 PlanEnvelope** | 见 `docs/api-schema.md` v1.1 段 | 否则前端要写两套解析，等于契约白收敛 |
| 6 | **异步语义待定** | 若 `/api/plan` 走异步，需约定 `pending` | 前端我已加 pending 占位分支，等后端定 |

### 前端

| # | 缺口 | 具体位置 | 影响 |
|---|---|---|---|
| 7 | **轮询未实现** | `web/src/lib/api.js` 只有一次性 POST | 接文件桥/异步链路时拿不到结果（我已加 pending 展示分支，但还没轮询逻辑） |
| 8 | **组件仍读顶层 `constraints`** | `ResultView.vue:20` | 归一化后能用，建议改 `request.constraints`（权威位置） |
| 9 | **`objective` 三目标切换未做** | 响应已有 `objective` + 三个备选 | 少一个可直接讲的亮点 |
| 10 | **备选文案需同步** | label 已从「更省钱的/更低卡的」改为「最省钱/最低卡/均衡推荐」 | UI 若写死旧文案会不一致 |
| 11 | **移动端 375px 验收** | — | `docs/api-schema.md` §8 列的验收项 |

### 我（Skill / MCP / 契约）

| # | 缺口 | 状态 |
|---|---|---|
| 12 | Skill 包仍是骨架 | `SKILL.md` + `cases.md` 已写规则；约束提取目前靠 `emit-plan` CLI 参数，未做端到端自然语言回归 |
| 13 | 演示前重拉真实菜单 | 明天开场前跑 `node server/fetch-menu.js --store 1450713`（菜单是动态的，实测过 125→129 变化） |
| 14 | ~~契约文档落后~~ | **本轮已同步到 v1.1**（status 三态 / request.constraints / objective / pending） |

### 产品文档

| # | 缺口 | 状态 |
|---|---|---|
| 15 | 答辩材料（PPT、演示话术） | 未开工。可讲的三点已有实物：AI 出方案 + 确定性校验、可信度底线（未知热量如实标 null）、Skill 在链路核心 |

---

## 三、本轮我顺手修的（已提交）

1. **热量上限被凭空强加**（红线）：`ConstraintForm.vue` 默认 `useCalorie: true` + 1200。
   用户只说「两个人预算60」也会被加一个 1200 大卡硬约束，答辩会被问「1200 哪来的」。
   → 改为默认 `false`，只有用户勾选或话语里出现减脂/低卡等词才带上限。
2. **error 态被当成无解展示**：`App.vue` 用 `success === false` 分支同时吃无解和错误，
   参数错误时会显示「暂时凑不出可行方案」+ 空原因。→ 按 `status` 拆成独立分支，并新增 pending 占位。
3. **`docs/api-schema.md` 同步到 v1.1**：新增 v1.1 变更段、三态判别改为 `status`、状态机补 `pending`、
   响应示例换成真实值（¥56.9/962kcal）、备选 label 更新。

---

## 四、优先级建议（今晚之前）

```text
P0  server/api.js（后端 A）         —— 不起后端，前端永远在 mock，演示讲不出真实链路
P0  前端轮询 + 接真实数据源（前端）  —— 与上一项联动
P0  演示前重跑自检（我）            —— node scripts/demo-check.js --online
P1  create-order 到支付链接（后端 A）
P1  nutritionToMap 归零 + 缺详情跳过（后端 A）—— 潜伏缺陷，数据一变就炸
P1  答辩材料（产品文档）
P2  objective 三目标切换、移动端验收（前端）
```

## 五、三条红线（不变）

- 不调 `create-order` 真实支付；门店固定 `1450713` + 到店自取。
- 未知热量保 `null`，不估算、不当 0。
- 两枚密钥（MCP Token、Gateway 密钥）不进代码、不进 git；MCP 限流 600 次/分钟。
