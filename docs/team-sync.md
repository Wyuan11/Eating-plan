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

> 已修复：`web/mock/plan.success.json` 的 alternatives 旧结构问题已解决。现在统一用 `node scripts/build_mock.js` 生成（旧的 `build_mock.py` 已删除，它会产出旧结构并覆盖 JS 的结果）。

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

---

## 五、契约已收敛（10-24 14:45）——前端 Mock 与真实落盘零差异

之前 Mock 是 Python 脚本手工拼装，和 solver v1.1 的真实输出已经漂移了 9 个字段。现在改成同源生成：

- `server/emit-plan.js` 抽出 `buildPayload(opts)` 纯函数并导出（CLI 行为不变，照旧可用）。
- 新增 `scripts/build_mock.js`：调 `buildPayload` 生成三态 Mock，写 `web/mock/plan.{success,nosolution,error}.json`。
- **Mock 与真实落盘走同一段代码**，字段差异实测为「无 / 无」，从此不会漂移。
- `web/src/types.ts` 已更新到 v1.1：`status` 三态判别、`request.constraints`、`objective`、`Alternative.items` 为完整 `PlanItem[]`（含 code/quantity，可直接下单）。
  - 旧代码若用了 `success` 布尔或顶层 `constraints`，需改；已保留 `isNoSolution/isError/isSuccess` 三个守卫，内部优先读 `status`。
- **全部 Mock 由 `node scripts/build_mock.js` 生成**（menu/stores/plan 三态/order）。
  menu.json 直接取真实门店缓存 `data/menu-1450713.json`（125 品、可信池 34、营养缺失 0），
  与 emit-plan 求解用的是同一份数据 —— 这样前端「独立重算校验」不会遇到菜单里查不到的品。
  旧的 `build_mock.py` 已删除（它基于 12:31 旧快照，会漏掉脆脆薯条等品，且会覆盖 JS 产出的新结构）。

**前端现在可以直接按 `web/mock/plan.*.json` 的结构写渲染，接上 bridge 后不用改解析。**

## 六、当前缺口清单（10-24 14:45）

| # | 缺口 | 归属 | 状态 |
|---|---|---|---|
| 1 | **Web 模板还没进仓库**（仓库里只有 `mock/` + `types.ts`，无页面/构建配置） | 前端 | 待接入 |
| 2 | ~~`server/api.js` 五接口~~ | 后端 A | **已交付并接入（15:55）**，见第七节；`/api/order` 仍返回 501（依赖第 3 项） |
| 3 | 下单链路 `create-order` → 支付链接（演示终点，不支付） | 后端 A | 未开工 |
| 4 | 前端独立重算价格/热量 + 超标标红（Schema 第 6 节，P0） | 前端 | 待实现 |
| 5 | 前端 5 态状态机 + `pending` 轮询（404+`status=pending` 要继续轮询） | 前端 | 待实现 |
| 6 | `nutritionToMap` 的 `Number() \|\| 0` 归零缺陷 | 后端 A | 待修 |
| 7 | 菜单构建跳过「有 code 无详情」的条目（140 vs 125/129） | 后端 A | 待修 |
| 8 | 一键演示/彩排脚本 | Skill 侧 | 待补 |
| 9 | 答辩材料（PPT、demo 话术） | 产品文档 | 未开工 |

### 前端接入时按这个顺序做

1. 把模板放进 `web/`，构建配置指向 `web/mock/*.json` 作为本地数据源。
2. 数据源切换：`/api/plan/<traceId>` 走 `node server/bridge.js --port 8787`（已实测可用，带 CORS）。
   `api.js` 出来后返回**同一套 `PlanEnvelope` 结构**，前端不用改解析。
3. 三态渲染：`status` = `success` / `nosolution`（展示 conflict + hint）/ `error`（展示 error.detail）。
4. 未生成时是 **404 + `status:"pending"`** ——继续轮询（1.5s），不要弹报错。
5. 接真实触发：`node server/trigger-skill.js --text "..." --traceId web-001`，脚本会等方案落盘。

---

## 七、前端模板已入库（2026-10-24 15:10）

队友的 Vue3 + Vite 渲染壳（`Eating-plan-main.zip`）已合入 `web/`，`vite build` 通过（39 modules）、`vite preview` 访问 200。

### 我改了什么、为什么（前端同事请重点看）

| 改动 | 原因 |
|---|---|
| 剔除模板自带的 `web/src/mock/` | 那是 v1 旧形态（顶层 `constraints`、`success` 布尔），与真实落盘差 9 个字段。改用项目 `web/mock/`，由 solver 真实求解生成 |
| 新增 `web/src/lib/normalize.js` | `verify.js` 读 `result.success` 和顶层 `constraints`，而真实落盘是 `status` 三态 + `request.constraints`。**不归一化的话校验徽章永远不亮** |
| `api.js` mock 路径改 `../../mock/` | 对齐项目的 `web/mock/` |
| `api.js` 返回值过 `normalizePlan()` | 后端 A 的 `api.js` 返回形态未定，归一化层同时吃 v1 / v1.1（现在 `/api/plan` 已是 v1.1 原生形态，归一化是幂等的） |

---

## 八、后端 A 的 `server/api.js` 已接入（2026-10-24 16:00）

实测结果（起临时端口跑完即关）：

```text
[200] /api/health        ok=true，菜单 125 品，命中真实缓存 data/menu-1450713.json
[200] /api/menu          125 品
[200] /api/stores        3 家（items 与 stores 双别名都给了）
[200] /api/plan 有解      status=success  ¥56.9 / 962kcal  objective=balanced
[200] /api/plan 无解      status=nosolution  conflict=预算 vs 人数  hint=预算提高到 51 元
[400] /api/plan 参数错     BAD_REQUEST（budget≤0 / people 越界 / objective 非法 都拦住了）
[501] /api/order          Day2 再接
[404] 未知路由
```

**前端联调现在可以这样起**：

```bash
node server/api.js        # 3000，Vite 已把 /api 代理过去
npm run dev               # web/ 下，5173
```

### 我接入时改了三处（后端 A 请知悉）

| 改动 | 原因 |
|---|---|
| 默认端口 8787 → **3000** | 前端 `vite.config.js` 把 `/api` 代理到 3000；原 8787 会与 `bridge.js`（Skill 文件桥）撞端口 |
| `/api/plan` 改为调用 `emit-plan` 的 `buildPayload()` | 三态判定只有那一处实现，且响应与 `data/skill-outbox/plan-*.json` **逐字段零差异**，前端一套解析吃两个来源。原先直接返回 solver 结果会缺 `status`/`request`/`objective` |
| `MAX_NODES` 透传给 `buildPayload` | 保留搜索节点上限保护，防止病态输入拖死服务 |

### 顺带修的数据缺陷

`fetch-menu.js` 写缓存时只写 `store: { code }`，门店名和地址丢失（`/api/menu` 返回空名，前端顶部餐厅名渲染不出来）。
已改为从 `data/menu-snapshot-<code>.json` 取 `storeName`/`address`，离线重跑后已生效：
`麦当劳上海黄浦华旭国际大厦餐厅 / 南京东路街道西藏中路336号`。取不到时留 `null`，不编造。

### 后端 A 剩余两项（演示前必须确认）

1. `create-order`（到支付链接为止，**不真实支付**）—— `/api/order` 目前 501；
2. `nutritionToMap` 的 `Number() || 0` 归零缺陷 + 菜单「有 code 无详情」条目跳过——当前数据未触发，但 v1.1 solver 严格化后会整体报 `INTERNAL_ERROR`。

### 归一化后的约定（组件照这个写）

```js
import { normalizePlan, isSuccess, isNoSolution, isError } from './lib/normalize.js';

const plan = normalizePlan(任何来源的响应);
isSuccess(plan) / isNoSolution(plan) / isError(plan)   // 三态唯一判据
plan.constraints        // 与 plan.request.constraints 是同一个对象
plan.objective          // balanced / lowest_price / lowest_calorie
plan.meta               // { storeCode, traceId, generatedAt, elapsedMs }
```

`status` 会原样保留未知值（例如 `'pending'`），**不会被误判成无解**——前端据此继续轮询。

### 前端仍待完成

1. 组件全面改用 `normalizePlan` 后的三态（目前部分组件仍读 `success` / `constraints`）。
2. 接真实数据源：`node server/bridge.js --port 8787`，`/api/plan/<traceId>` 已有 CORS；或等后端 A 的 `api.js`（Vite 已把 `/api` 代理到 3000）。
3. 轮询：未生成时 404 + `status:"pending"`，1.5s 重试，不弹报错。
