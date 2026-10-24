# 麦门智选助手 · 前后端接口契约 Schema v1.2

> ⚡ **v1.2 变更（2026-10-24）：一次返回 1～3 个方案**
>
> 1. 新增 **`plans: PlanEntry[]`（1～3 个）**：同一组约束下的多套方案，**每套都满足全部硬约束**
>    （预算 / 热量 / 人数 / 忌口），只是优化目标不同：
>
>    | key | label | 说明 |
>    |---|---|---|
>    | `balanced` | 均衡推荐 | 预算、热量、营养、多样性综合最优 |
>    | `cheapest` | 省钱优先 | 总价最低，把预算省下来 |
>    | `max_value` | 预算吃满 | 预算吃满，份量最足（本次新增策略） |
>    | `lowest_calorie` | 最低卡 | 总热量最低 |
>
> 2. `plans[0]` 即用户/接口指定的 `objective`；其余按「省钱 → 吃满 → 均衡 → 最低卡」补足，
>    **相同组合会去重**，所以实际可能是 1～3 个（菜单小或约束紧时只有 1～2 个）。
> 3. 每个 `PlanEntry` 都是**完整方案**：`plan`（合计）+ `items`（完整 PlanItem，含 `code`/`quantity`/`nutrition`）+ `nutrition`，
>    因此**任意方案都能独立重算校验、独立下单**。
> 4. **向后兼容**：顶层 `plan/items/nutrition` 仍是主方案（= `plans[0]`）；`alternatives` 仍是「除主方案外的其余方案」。
>    只认旧字段的前端不受影响；新前端优先读 `plans`。
> 5. `objective` 别名归一：`lowest_price`/`save` → `cheapest`，`lowcal` → `lowest_calorie`，`value` → `max_value`。
>    旧文档里写的 `lowest_price` 依然可用。
> 6. 前端接入：响应先过 `normalizePlan()`，**没有 `plans` 时它会用主方案 + `alternatives` 自动合成**，
>    所以旧后端 / 旧 mock 也能按多方案渲染。
>
> ```jsonc
> "plans": [
>   { "key": "balanced", "label": "均衡推荐", "strategy": "预算、热量、营养、多样性综合最优",
>     "highlight": "预算 / 热量 / 营养 / 多样性 综合最优",
>     "plan": { "total_price": 59, "total_calorie": 907, "budget_usage": "98%", "saved": 0 },
>     "items": [ /* 完整 PlanItem[] */ ], "nutrition": { /* 五项营养汇总 */ } },
>   { "key": "cheapest", "label": "省钱优先", "strategy": "总价最低，把预算省下来",
>     "highlight": "比主方案省 ¥25.0", "plan": { "total_price": 34, "total_calorie": 738 }, "items": [] },
>   { "key": "max_value", "label": "预算吃满", "strategy": "预算吃满，份量最足",
>     "highlight": "预算用到 99%，共 4 件", "plan": { "total_price": 59.5, "total_calorie": 996 }, "items": [] }
> ]
> ```

> 前端同学：这份文档 + `web/mock/*.json` + `web/src/types.ts` 三件套到手即可开工，**不需要等后端**。  
> 所有 mock 数据均由麦当劳官方 MCP 实测返回推导，字段与最终联调完全一致。  
> **本文档冻结后不再变更字段名**；如需变更，必须走 v2 并同步更新本文件。

## ⚡ v1.1 变更（2026-10-24，与 solver v1.1 同步；**与下方 v1 正文冲突时以本节为准**）

1. **三态判据改为 `status`**：`success` / `nosolution` / `error`，外加异步态 `pending`。
   不再用 `success` 布尔 + `conflict` 有无去猜——`error` 态以前会被误判成「无解」，用户以为是自己预算不合理。
2. **约束改放 `request.constraints`**（顶层 `constraints` 作为兼容别名同时提供，二者是同一个对象）。
3. 新增 **`objective`**：`balanced` / `lowest_price` / `lowest_calorie`，前端可做三个目标切换。
4. **`alternatives[].items` 升级为完整 `PlanItem[]`**（含 `code`/`quantity`），备选方案可直接下单与校验；
   label 改为 **「最省钱」/「最低卡」/「均衡推荐」**。
5. `meta` 不再有 `candidates`；`items` 按 `code` 排序。
6. **前端接入方式**：任何来源的响应先过 `web/src/lib/normalize.js` 的 `normalizePlan()`，
   再用 `isSuccess/isNoSolution/isError` 判别三态。这样后端 `api.js` 无论返回 v1 还是 v1.1 都能吃。

```js
import { normalizePlan, isSuccess, isNoSolution, isError } from './lib/normalize.js';
const plan = normalizePlan(res);          // status / request.constraints / objective / meta 全部就位
if (isSuccess(plan)) renderPlan(plan);
else if (isNoSolution(plan)) renderNoSolution(plan);   // reason + conflict + hint
else if (isError(plan)) renderError(plan);             // error.code + error.detail
else keepPolling(plan);                                 // status === 'pending'
```

---

## 0. 三分钟上手

```bash
web/
├── src/types.ts        # 全部 TypeScript 类型，直接 import
└── mock/
    ├── stores.json           # 门店列表
    ├── menu.json             # 菜单 124 品（含可信热量标记）
    ├── plan.success.json     # 推荐成功 ← 主开发态
    ├── plan.nosolution.json  # 约束无解
    ├── plan.error.json       # 服务异常
    └── order.success.json    # 下单成功
```

**Mock 开关**（务必按这个写，联调时改一个环境变量即可切换）：

```ts
// src/api/client.ts
const USE_MOCK = import.meta.env.VITE_USE_MOCK !== 'false';

export async function requestPlan(req: PlanRequest): Promise<PlanResponse> {
  if (USE_MOCK) {
    // 按场景返回不同 mock，便于调试各个 UI 状态
    const file =
      req.constraints.budget < 20 ? 'plan.nosolution.json' : 'plan.success.json';
    return fetch(`/mock/${file}`).then((r) => r.json());
  }
  return fetch('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  }).then((r) => r.json());
}
```

> 关键：**URL 路径与请求/响应结构保持完全一致**，只有 `USE_MOCK` 决定走本地文件还是真接口。

---

## 1. 接口清单

| # | 方法   | 路径                           | 用途           | Mock 文件              | 优先级 |
| - | ---- | ---------------------------- | ------------ | -------------------- | --- |
| 1 | GET  | `/api/stores?city=&keyword=` | 门店列表         | `stores.json`        | P1  |
| 2 | GET  | `/api/menu?storeCode=`       | 门店菜单         | `menu.json`          | P0  |
| 3 | POST | `/api/plan`                  | **核心：多约束求解** | `plan.success.json`  | P0  |
| 4 | POST | `/api/order`                 | 创建订单拿支付链接    | `order.success.json` | P1  |
| 5 | GET  | `/api/health`                | 健康检查         | —                    | P2  |

**P0 = 第一天必须跑通；P1 = 第二天；P2 = 有空再说。**

演示时门店固定 `1450713`（上海黄浦华旭国际大厦餐厅，已实测可用），接口 1 可先做成下拉框写死三家常备数据。

---

## 2. 接口 2：GET /api/menu?storeCode=1450713

菜单是求解器的输入，也是前端「商品卡片」的数据源。

```jsonc
{
  "success": true,
  "store": { "code": "1450713", "name": "麦当劳上海黄浦华旭国际大厦餐厅", "address": "南京东路街道西藏中路336号" },
  "count": 124,
  "items": [
    {
      "code": "1406",              // string，唯一键，全部用 code 做 key
      "name": "板烧鸡腿堡",
      "price": 23.5,               // 实付价
      "original_price": 23.5,      // 原价，price < original_price 才显示促销划线价
      "kind": "single",            // single 单品 | combo 套餐(990开头) | merch 周边
      "category": "主食",           // 主食/小食/饮品/甜品/其他
      "calorie": 391,              // number | null —— 无数据必须渲染成 null
      "calorie_source": "official",// official|estimated|unknown|not_applicable
      "nutrition": { "protein": 26, "fat": 18, "carbohydrate": 32, "sodium": 872, "calcium": 121 },
      "tags": ["不辣", "鸡肉", "经典"],
      "available": true
    }
  ],
  "meta": { "generatedAt": "2026-10-24T12:50:00+08:00", "source": "mcd-mcp query-meals" }
}
```

### ⚠️ 前端必须处理的三种热量状态

| `calorie_source` | 含义                                | 渲染要求                            |
| ---------------- | --------------------------------- | ------------------------------- |
| `official`       | 官方营养表权威值                          | 正常显示「391 kcal」                  |
| `estimated`      | 同类估算                              | 显示「约 391 kcal」+ 灰色小字「估算」        |
| `unknown`        | **官方未公布**（马苏里拉芝士条、龙焰系列、枫糖厚松饼堡等新品） | 显示「—」或「暂无数据」，**绝不允许显示 0 或编造数字** |
| `not_applicable` | 套餐/周边                             | 不显示热量                           |

> 这是本项目的**可信度底线**。菜单 124 品中 33 个单品有官方热量，覆盖率 62.3%，未覆盖的全是新品和限时品。  
> 遇到 `unknown` 就要如实告诉用户「官方没公布，我没算进去」——**这条在答辩时会专门讲，是加分项，别改。**

---

## 3. 接口 3：POST /api/plan（核心）

### 请求

```jsonc
{
  "storeCode": "1450713",
  "constraints": {
    "budget": 60,           // 必填，元
    "calorie_limit": 1200,  // 可选，大卡；不填则不约束热量
    "people": 2,            // 可选，默认 1
    "excluded": ["辣"]      // 可选，忌口关键词
  }
}
```

### 成功响应 `200`

```jsonc
{
  "status": "success",            // v1.1：三态唯一判据
  "success": true,                // 兼容旧代码，等价于 status === 'success'
  "traceId": "demo-001",
  "createdAt": "2026-10-24T07:00:00.000Z",
  "objective": "balanced",
  "request": {
    "storeCode": "1450713",
    "constraints": { "budget": 60, "calorie_limit": 1200, "people": 2, "excluded": ["辣"] },
    "intent": "两个人午餐60元1200大卡不要辣"
  },
  "constraints": { "budget": 60, "calorie_limit": 1200, "people": 2, "excluded": ["辣"] },  // 与 request.constraints 同源
  "message": "推荐完成",
  "plan": {
    "total_price": 56.9,
    "total_calorie": 962,
    "original_price": 70,
    "saved": 13.1,
    "budget_usage": "95%",   // 字符串，含 % 号，直接渲染
    "calorie_usage": "80%"   // 无热量约束时为 "—"
  },
  "items": [
    { "code": "1406", "name": "板烧鸡腿堡", "price": 23.5, "calorie": 391,
      "calorie_source": "official", "category": "主食", "quantity": 1,
      "nutrition": { "protein": 26, "fat": 18, "carbohydrate": 32, "sodium": 872, "calcium": 121 },
      "tags": ["不辣", "鸡肉", "经典"] }
    // ... 麦香鸡 17 / 燕麦奶铁 9.9 / 纯悦 7.5
  ],
  "nutrition": { "protein": 41, "fat": 39, "carbohydrate": 91, "sodium": 1859, "calcium": 436 },
  "alternatives": [
    { "label": "最省钱", "objective": "lowest_price", "total_price": 39.5, "total_calorie": 694,
      "items": [ { "code": "1450", "name": "麦香鸡", "price": 17, "calorie": 369, "quantity": 1 } ] },
    { "label": "最低卡", "objective": "lowest_calorie", "total_price": 45.0, "total_calorie": 650, "items": [ /* ... */ ] },
    { "label": "均衡推荐", "objective": "balanced", "total_price": 56.9, "total_calorie": 962, "items": [ /* ... */ ] }
  ],
  "suggestion": "这套方案把预算用到了 95%……（一句话解释，直接展示）",
  "source_note": "数据来自麦当劳官方 MCP 实时菜单与营养表（未公布营养的新品不参与计算）",
  "meta": { "storeCode": "1450713", "traceId": "demo-001", "generatedAt": "...", "elapsedMs": 276 }
}
```

> v1.1 的 `alternatives[].items` 是**完整 PlanItem**（带 `code`/`quantity`/`calorie_source`），
> 所以备选方案也能直接做独立重算校验和下单；v1 只有 `name/price/calorie`，不能。

### 失败响应 A：约束无解 `200`（业务失败，非 HTTP 错误）

```jsonc
{
  "success": false,
  "message": "约束过严，无法生成可行方案",
  "reason": "3 人用餐最少需要 3 份主食，当前门店最便宜的主食为麦香鸡 17 元，3 份已需 51 元，远超 15 元预算",
  "conflict": "预算 vs 人数",
  "hint": "把预算提高到 51 元以上，或把人数调整为 1 人（单人最低可行方案约 22.5 元）",
  "constraints": { "budget": 15, "calorie_limit": 300, "people": 3, "excluded": [] },
  "source_note": "数据来自麦当劳官方 MCP 实时菜单与营养表",
  "meta": { "traceId": "mock-nosolution", "generatedAt": "..." }
}
```

### 失败响应 B：服务异常 `4xx/5xx`

```jsonc
{
  "success": false,
  "message": "上游服务暂不可用",
  "error": { "code": "MCP_UPSTREAM_ERROR", "detail": "MCP query-meals 超时（>8s）", "retryable": true },
  "meta": { "storeCode": "1450713", "traceId": "...", "generatedAt": "..." }
}
```

### 判别逻辑（照抄 `types.ts` 里的守卫）

```ts
// v1.1：先看 status，再分支。不要把 error 当成 no_solution
switch (res.status) {
  case 'success':    renderSuccess(res);    break;
  case 'nosolution': renderNoSolution(res); break;   // reason + conflict + hint
  case 'error':      renderError(res);      break;   // error.code + error.detail
  default:           keepPolling(res);               // 'pending' 等未知态，继续轮询
}
```

最低成本写法：直接用 `web/src/lib/normalize.js` 的 `isSuccess/isNoSolution/isError` 三个守卫。

**错误码**：`BAD_REQUEST` / `MCP_UPSTREAM_ERROR` / `NO_SOLUTION` / `STORE_CLOSED` / `NOT_FOUND` / `INTERNAL_ERROR`

---

## 4. 接口 4：POST /api/order

```jsonc
// 请求
{ "storeCode": "1450713", "items": [{ "code": "1406", "quantity": 1 }, { "code": "1450", "quantity": 1 }] }

// 响应
{
  "success": true,
  "message": "订单已创建，请在 15 分钟内完成支付",
  "order": {
    "orderId": "MOCK202610240001",
    "total_price": 57.9,
    "payH5Url": "https://example.com/pay/MOCK202610240001",  // 转成二维码展示
    "expireAt": "2026-10-24T13:05:00+08:00"
  },
  "meta": { "generatedAt": "..." }
}
```

**注意**：`payH5Url` 只做**展示**（渲染二维码 + 可点击链接），**不要**在前端自动跳转或自动支付。演示到此为止，不产生真实扣款。

#### 4.1 已实现（2026-10-24，server/order.js）

链路：**本地快照算期望价 → `calculate-price` 重新核价（变价即 409 拦截）→ `create-order` → 返回 `payH5Url`**。

请求额外支持：`beType`（默认 1 到店取餐）、`mock:true`（演示逃生门，不调 MCP）。

响应额外字段（都在 `order` 之外，不影响上面的老字段）：

```jsonc
{
  "order": { "orderId": "...", "total_price": 22, "payH5Url": "...", "expireAt": null,
             "storeName": "...", "orderStatus": "待支付" },
  "price_check": { "expected_price": 22, "actual_price": 22, "matched": true, "discount": 0 },
  "meta": { "source": "mcp" }   // mock 时为 "mock"，前端必须区分展示
}
```

- `expireAt` 为 `null` 是**故意的**：MCP 不返回支付截止时间，宁可留空也不编造倒计时。
- 金额单位：MCP 返回「分」，后端统一转成「元」后再给前端。

错误码（HTTP 状态码与业务 code 一致，前端按 code 分支）：

| HTTP | code | 含义 | 前端该做什么 |
|---|---|---|---|
| 400 | `BAD_REQUEST` | items 为空 / 数量非法 / beType 不合法 | 提示修正 |
| 409 | `PRICE_CHANGED` | 快照价与实时价不一致，**未下单** | 展示两个价格，让用户确认后重试 |
| 502 | `MCP_TOOL_ERROR` / `NO_TAKEWAY` | MCP 业务失败 / 算价未返回取餐方式 | 提示稍后重试 |
| 503 | `MCP_UNAVAILABLE` | 未配 Token 或 MCP 不可达 | 提示可用 `mock:true` 演示 |

**红线**：不调用任何支付/扣款工具；`mock:true` 是**唯一**能拿到假订单的入口，且响应自曝 `source:"mock"`，绝不静默伪造。

回归：`npm run test:order`（无 Token 时自动 SKIP 真实链路；`ORDER_LIVE=1` 才会真实创建**未支付**订单）。

---

## 5. 页面状态机（前端必须实现这 5 个态）

```
idle ──点击「帮我搭配」──> loading ──┬─> success      渲染方案卡片
                                    ├─> no_solution  渲染无解提示 + 放宽建议
                                    ├─> error        渲染错误 + 重试按钮
                                    └─> pending      方案生成中，继续轮询（异步链路）
```

| 状态            | 触发条件                            | UI 要求                                           |
| ------------- | ------------------------------- | ----------------------------------------------- |
| `idle`        | 初始                              | 约束输入表单（预算必填、热量上限、人数、忌口多选）                       |
| `loading`     | 请求中                             | **必须有骨架屏**，不要转圈等待。求解耗时可能 3–8 秒                  |
| `pending`     | `status==='pending'` 或 404+pending | 显示「方案生成中」，**1.5s 轮询，不要弹报错**（文件桥未生成时返回 404 + `status:"pending"`） |
| `success`     | `status==='success'`            | 见下方区块清单                                         |
| `no_solution` | `status==='nosolution'`         | 高亮 `reason`，把 `hint` 做成**一键放宽**按钮               |
| `error`       | `status==='error'`              | `error.detail` + 「重试」，`retryable===false` 时禁用重试 |

### success 态渲染区块（自上而下）

1. **总览条**：实付 ¥57.9（原价 ¥71 划线）· 省 ¥13.1 · 预算占用 96% · 热量占用 74%
2. **热量进度条**：892 / 1200 kcal；**超过 100% 时必须标红**（这是硬约束，见 §6）
3. **营养结构**：蛋白质 / 脂肪 / 碳水 / 钠 四项（可用条形图或环形图）
4. **商品卡片列表**：图片位（暂无真实图可先用首字母色块占位）· 名称 · 单价 · 热量 · tags
5. **备选方案**：两张小卡「更省钱的」「更低卡的」，点击可切换主方案
6. **AI 说明**：`suggestion` 原文展示，配一个 AI 图标
7. **底部操作栏**：「去下单」→ 调 `/api/order` → 展示二维码

---

## 6. ⚠️ 前端必须做的一道校验（P0，别省）

**背景**：方案由 Skill 里的大模型生成，大模型做加法会出错。如果它说「控制在 1200 大卡内」但实际 1350，演示当场翻车。

所以前端拿到响应后，**用 items 独立重算一遍**，不一致就以重算值为准并给出提示：

```ts
// src/lib/verify.ts
export function verify(res: PlanSuccess) {
  const price = round2(res.items.reduce((s, i) => s + i.price * i.quantity, 0));
  const kcal = res.items.reduce((s, i) => s + (i.calorie ?? 0), 0);
  const problems: string[] = [];

  if (Math.abs(price - res.plan.total_price) > 0.01)
    problems.push(`价格不一致：后端 ${res.plan.total_price}，前端重算 ${price}`);

  if (Math.abs(kcal - res.plan.total_calorie) > 1)
    problems.push(`热量不一致：后端 ${res.plan.total_calorie}，前端重算 ${kcal}`);

  if (res.constraints.budget && kcal > 0 && price > res.constraints.budget)
    problems.push(`超出预算 ¥${res.constraints.budget}`);

  if (res.constraints.calorie_limit && kcal > res.constraints.calorie_limit)
    problems.push(`超出热量上限 ${res.constraints.calorie_limit} kcal`);

  return { ok: problems.length === 0, problems, actualPrice: price, actualCalorie: kcal };
}
```

**渲染规则**：

- `ok === true` → 正常渲染，右下角可加一行极小的「✓ 已校验」灰色标记
- `ok === false` → 主卡片顶部加**黄色警告条**，列出 `problems`，并把数值**替换为前端重算值**

> 这不是多此一举。「AI 出方案 + 确定性校验」是我们答辩时要讲的核心亮点——**我们知道 AI 的能力边界在哪，并且用工程手段兜住了**。请务必实现。

---

## 7. 前端不要做的事

| 不做                               | 原因                        |
| -------------------------------- | ------------------------- |
| 不直接调用麦当劳 MCP                     | Token 只在后端，前端碰不到，也不该碰     |
| 不自己实现求解/算价/算热量算法                 | 由后端确定性算法 + Skill 负责，前端只渲染 |
| 不把 `calorie: null` 渲染成 `0` 或编造数字 | 可信度底线，答辩会查                |
| 不自动跳转支付 / 不真实下单                  | 演示只到二维码为止                 |
| 不做登录、历史订单、收藏、多语言                 | 两天做不完，明确砍掉                |

---

## 8. 第一天交付验收清单

- [ ] 用 `web/mock/plan.success.json` 跑通 `success` 态全部 7 个区块
- [ ] 用 `plan.nosolution.json` 跑通无解态；`hint` 做成可点击的一键放宽
- [ ] 用 `plan.error.json` 跑通异常态 + 重试
- [ ] `menu.json` 中 `calorie: null` 的商品渲染为「—」，**不得显示 0**
- [ ] `verify()` 已接入：手工把 mock 的 `total_price` 改成 99.9，页面应弹出黄色警告条
- [ ] `VITE_USE_MOCK=false` 时请求打到 `/api/*` 且路径、字段名与 mock 完全一致
- [ ] 移动端宽度 375px 下不横向滚动

**Mock 数据重生成**（后端改了数据或需要换门店时）：

```bash
node scripts/build_mock.js   # 由 solver 真实求解推导，数值自洽，与线上结构同源
# （旧的 build_mock.py 已废弃删除：它基于旧快照，会漏品且产出旧结构）
```

---

## 9. 变更约定

- 字段命名统一 **snake_case**（与 MCP 返回对齐），前端内部可转 camelCase，但**网络层必须是 snake_case**
- 金额单位**元**（number，保留 2 位），热量单位**千卡**，钠/钙单位**毫克**，其余**克**
- 所有百分比字段是**带 % 号的字符串**，前端不需要再乘 100
- `status` 字段恒存在，用它判别三态（`success` / `nosolution` / `error` / `pending`）；`success` 布尔仅作兼容保留，不要只看 HTTP 状态码
