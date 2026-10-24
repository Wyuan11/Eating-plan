# 团队同步清单（2026-10-24 14:20 · Skill+MCP 侧进展）

> 本文件由 Skill+MCP 负责人维护。前端与后端 A 只需看各自那一节。  
> 契约基线仍是 `docs/api-schema.md` + `web/src/types.ts`，**字段名未改**，下面列出的是新增与差异。

---

## 一、给前端（Web）

### 1. 新增一个可用的数据源：文件桥服务

```bash
node server/bridge.js --port 8787
```

| 接口                        | 返回                         | 说明          |
| ------------------------- | -------------------------- | ----------- |
| `GET /api/health`         | `{ok, outbox, count}`      | 健康检查        |
| `GET /api/plan/<traceId>` | `{ok:true, traceId, plan}` | 取方案         |
| `GET /api/plans`          | `{ok:true, items:[...]}`   | 最近方案列表（调试用） |

**关键约定**：方案还没生成时返回 **HTTP 404 + `{"ok":false,"status":"pending"}`**。  
这不是错误，前端应**继续轮询**（建议 1.5s 间隔），不要弹错误提示，也不要停止。  
已带 CORS 和 `no-store`，浏览器可直接取。

### 2. 落盘结构与现有 Mock 的差异（需适配，3 处）

现有 Mock：`web/mock/plan.success.json` 顶层是 `{success, constraints, plan, items, ...}`。  
真实落盘（`data/skill-outbox/plan-<traceId>.json`）多了一层包装：

```json
{
  "traceId": "web-001",
  "createdAt": "2026-10-24T06:12:00.000Z",
  "status": "success",
  "request": { "storeCode": "1450713", "constraints": { "budget": 60, "calorie_limit": 1200, "people": 2, "excluded": ["辣"] }, "intent": "用户原话" },
  "success": true,
  "message": "推荐完成",
  "plan": { "total_price": 56.9, "total_calorie": 962, "original_price": 70, "saved": 13.1, "budget_usage": "95%", "calorie_usage": "80%" },
  "items": [ { "code":"1106", "name":"双层吉士汉堡", "price":23, "calorie":429, "calorie_source":"official", "category":"主食", "quantity":1, "nutrition":{...}, "tags":[] } ],
  "nutrition": { "protein":45, "fat":44, "carbohydrate":94, "sodium":1835, "calcium":593 },
  "alternatives": [ { "label":"更省钱的", "total_price":39.5, "total_calorie":694, "items":[...] } ],
  "suggestion": "共 4 件，实付 56.9 元…",
  "reason": null, "conflict": null, "hint": null,
  "meta": { "traceId":"web-001", "candidates":615, "elapsedMs":12 }
}
```

适配点：

1. **三态判断用 `status`**：`success` / `nosolution` / `error`。（`success` 布尔字段仍保留，兼容旧 Mock。）
2. **约束位置变了**：原来读顶层 `constraints`，现在读 **`request.constraints`**。
3. **无解时新增 `conflict`**：值是冲突维度，如 `"预算 vs 人数"`、`"热量 vs 人数"`，配合 `reason` + `hint` 展示。已补齐，前端 Mock 里也原本就有此字段。

`plan`/`items`/`nutrition`/`alternatives` 的字段名与 Mock **完全一致**，无需改动。

### 3. 三条必须遵守的数据口径

1. **未知热量是 `null`，不是 0。** 官方营养表没覆盖的新品（龙焰系列等）不参与求解，`items` 里不会出现未知热量项；但前端重算时不要把 `null` 当 0 参与累加。
2. **菜单是动态的**：门店菜单每次拉取，`data.categories` 里的条目数（140）可能大于 `data.meals` 详情数（125/129）。**存在"分类里有 code 但没有详情"的条目**，前端渲染遇到缺详情的条目要跳过，不能渲染成 `undefined`。
3. **前端独立重算**：价格与热量必须在前端用 `items` 重算一遍，与后端 `total_price`/`total_calorie` 不一致就标红拦截——这是我们的答辩亮点，别省掉。

### 4. 演示时怎么触发

两种都实测可用，前端任选：

```bash
# A. 完整链路（推荐，体现 Skill 核心地位）
node server/trigger-skill.js --text "两个人午餐，预算60元，1200大卡以内，不要辣" --traceId web-001
# 脚本会自动等方案落盘并打印结果

# B. 直连文件桥
node server/bridge.js --port 8787
curl http://localhost:8787/api/plan/web-001
```

现成可用的 traceId（已落盘，可直接联调）：`demo-001`（有解）、`demo-002`（无解）、`case2`（无热量上限）、`case4`（多忌口）、`trigger-test-001`（HTTP 触发产出）。

---

## 二、给后端 A（Solver / API 服务）

### 1. `server/mcp-client.js` 已改，请同步认知

- 新增导出 **`extractJson(text)`**：MCP 返回是「自然语言字段说明 + `## Original Response` + 真 JSON」，说明段里有 `data.meals.{code}.xxx` 这种花括号，用 `indexOf('{')` 切会切错。公共实现从 `{"success"` 定位 + 括号配对。**`fetch-menu.js` 里那份可以换成这个**（功能等价，换不换都行，但别再写第三份）。
- `callTool` 现在会检查 MCP 工具级 **`isError`**（HTTP 200 但 `result.isError=true` 的情况），错误会显式抛出，不再被当成数据返回。
- `fetch` 加了 15 秒超时。

### 2. 菜单构建有一个数据坑

`query-meals` 返回的 `data.categories[].meals` 是只有 `code`+`tags` 的列表，详情在 `data.meals` 映射表里。  
**实测存在分类里出现、但映射表里没详情的 code（140 vs 125/129，差值每次不同）**。  
建菜单时必须跳过这些 code，否则会产出 `name`/`price` 为 `undefined` 的单品，污染可信池。

### 3. 营养数值归零问题（待你确认修复）

`fetch-menu.js` 的 `nutritionToMap` 用的是：

```js
kcal: Number(r.energyKcal) || 0,
```

原始字段缺失时会落成 `0`，而 `0` 会被当成"0 大卡的真实数据"进入可信池——这是危险的假数据。  
建议改成显式的空值判断（缺失时不要进入可信池，标记 `unknown`）。这属于你的模块，我没动。

### 4. 新文件，你写 `/api/*` 时直接复用，别搞第二套结构

| 文件                        | 用途                                                            |
| ------------------------- | ------------------------------------------------------------- |
| `server/emit-plan.js`     | 约束 → solver → 原子落盘。**你的 `/api/plan` 直接复用它的输出结构**，前端就能用同一套解析逻辑 |
| `server/outbox.js`        | outbox 原子读写（tmp→fsync→rename）                                 |
| `server/bridge.js`        | 文件桥 HTTP 服务（Web 轮询）                                           |
| `server/trigger-skill.js` | HTTP 触发 Skill（本机 Gateway）                                     |

重点：**`/api/plan` 的返回体建议与 `emit-plan` 落盘结构保持一致**（`status` 三态 + `request.constraints` + `plan` + `items`）。这样前端一份代码吃两个来源。

### 5. 不要用 solver CLI 直接写 outbox

`node server/solver.js --out <file>` 是 `fs.writeFileSync` 直写，**非原子**，前端轮询会读到半截 JSON。统一走 `emit-plan.js`。

### 6. 旧问题提醒

`fetch-menu.js --offline` 目前只跳过菜单拉取，**仍会联网拉营养数据**，别在断网演示时依赖它。

### 7. 好消息：HTTP 触发 Skill 已打通（你要的话可以直接用）

WorkBuddy 桌面端内置本机 Gateway（`http://127.0.0.1:63698`，端口从 `~/.workbuddy/sessions/<pid>.json` 读），  
`POST /api/v1/runs` 可向会话注入消息触发 Skill，已实测 202 accepted。完整协议见 **`docs/gateway-api.md`**。

---

---

## 四、v1.1 Solver 变更同步（10-24 14:35，后端 A 新版已集成）

新版 `server/solver.js` 已替换（旧版备份在 `server/solver.v1.bak.js`）。主方案数值与旧版一致
（60元/1200kcal/2人/忌辣 → ¥56.9/962kcal），**`plan`/`items`/`nutrition` 字段名完全不变**。

### 给前端：3 处需要适配

1. **`alternatives` 结构升级**

```json
{ "objective": "cheapest", "label": "最省钱", "total_price": 34, "total_calorie": 738,
  "items": [ { "code":"1450", "name":"麦香鸡", "price":17, "calorie":369,
               "calorie_source":"official", "category":"主食", "quantity":2 } ] }
```

- 新增 **`objective`**（`cheapest` / `lowest_calorie` / `balanced`）
- **label 改名**：旧「更省钱的 / 更低卡的」→ 新「**最省钱 / 最低卡 / 均衡推荐**」
- `items` 新增 `code` / `category` / `calorie_source` / `quantity` → **备选方案现在也可直接下单、可独立校验**

2. **顶层新增 `objective`**：主方案是按哪个目标选出来的（默认 `balanced`）。前端可做成三个 tab 让用户切换目标。

3. **`meta` 变了，别依赖 `meta.candidates`**：新版 meta 是 `{storeCode?, storeName?, generatedAt, traceId}`，候选数只在 `suggestion` 文案里。
   另外 `items` 顺序改为按 `code` 排序（展示顺序可能与旧版不同，无功能影响）。

> 顺带：`web/mock/plan.success.json` 里的 alternatives 还是旧结构，建议用 `scripts/build_mock.py` 重新生成，否则 Mock 与真实响应不一致。

### 给后端 A：新版的 3 个注意点

1. **严格校验会整体失败，不是跳过**：`summarize` 遇到 `calorie` 非 official、缺失任一营养字段、金额非两位小数，会直接抛错 → `solve` 返回 `INTERNAL_ERROR`。
   **这意味着菜单构建必须保证可信池里每一品都有完整 `nutrition`**，否则整条链路挂掉。旧版是静默当 0，新版是拒绝——数据侧要把关。
2. **参数边界收紧**：`people` 必须 1～6 整数；`excluded` 会 trim + 去重；`budget` 必须 > 0 且最多两位小数。
3. **金额改用「分」整数运算**（消除浮点误差），`toFen` 已导出可复用。另有 `maxNodes`（默认 200 万）上限，超了返回「未证明无解」。

### 已同步修复（Skill 侧）

- `emit-plan.js` 现在能区分三态：`nosolution`（约束过严，有 reason/conflict/hint）与 **`error`**（参数错误/数据异常，只有 `error.code`/`detail`）。旧逻辑会把参数错误误标成"无解"。
- 落盘新增 `objective` 字段；CLI 新增 `--objective cheapest|lowest_calorie`。
- `SKILL.md` 已更新备选 label 与 `--objective` 用法。

---

## 三（原）、三人共同红线

1. **不调 `create-order`，不触发真实支付**。最远走到生成支付链接。
2. **未知热量保持 `null`**，绝不补 0、绝不估算。
3. **不提交密钥到 git**：MCP Token（`MCD_MCP_TOKEN`）、Gateway 密钥（`CODEBUDDY_GATEWAY_PASSWORD`）都只在环境变量里。
4. **门店固定 `1450713`，到店自取 `orderType=1 / beType=1`**（账号是空号，无配送地址）。
5. **MCP 限流 600 次/分钟**，不要循环拉菜单。
6. **Skill 必须在链路核心位置**（参赛合规），Web 只做渲染，不直连 MCP。
