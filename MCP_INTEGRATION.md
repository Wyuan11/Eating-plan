# MCP_INTEGRATION.md —— 麦当劳 MCP 接入说明

> 本文说明本项目**实际调用**的麦当劳 MCP Server、用到的 Tool、完整调用流程与设计取舍，
> 以及「为什么必须走官方 MCP 而不是让模型自己编菜名和热量」。

---

## 一、MCP Server 与接入方式

| 项目 | 值 |
|---|---|
| MCP Server | 麦当劳官方 MCP（`mcd-mcp`） |
| 端点 | `https://mcp.mcd.cn`（可用 `MCD_MCP_URL` 覆盖） |
| 传输协议 | Streamable HTTP，`POST tools/call`，无需 session 握手 |
| 鉴权 | `Authorization: Bearer ${MCD_MCP_TOKEN}`（自动兜底：环境变量 → 项目 `.env` → `~/.workbuddy/mcp.json`） |
| 超时 | 15s（`AbortSignal.timeout`） |
| 限流 | 600 次/分钟，收到 HTTP 429 立即抛错，不做静默重试 |
| 客户端实现 | `server/mcp-client.js`（`callTool` / `extractJson` / `parseMaybeJson`） |

接入验证命令（只读、不落盘、不下单）：

```
export MCD_MCP_TOKEN=xxx
node server/verify-mcp.js
```

脚本依次验证三件事：`now-time-info`（链路与鉴权通）→ `query-meals`（门店菜单可读）→ `list-nutrition-foods`（官方营养表可读）。

---

## 二、实际使用的 Tools

### 1. `query-meals` —— 门店菜单（价格 + 官方热量）

```js
await callTool('query-meals', { storeCode: '1450713', orderType: 1, beType: 1 });
```

- `orderType: 1` = 到店自取，`beType: 1` = 堂食/自取场景；演示固定这两个参数。
- 产出 `data/menu-<storeCode>.json`：品名、编码、价格、原价、`kind`（single/combo）、
  官方热量 + `calorie_source`（`official` / `unknown` / `not_applicable`）、官方标签（辣/鸡肉/牛肉…）。
- 当前已落盘 **7 家门店 + 1 份精简快照**（1450441 / 1450684 / 1450713 / 3330207 / 3330353 / 3330541 / 3330556 + snapshot）。

**业务价值**：价格与热量全部来自官方，不经过模型。评委随手挑一个汉堡去官网核对，数字一定对得上——
这是「控卡」这个卖点成立的前提。

### 2. `list-nutrition-foods` —— 官方营养表

```js
await callTool('list-nutrition-foods', {});
```

- 返回官方营养表（本项目快照 **158 条**，已去重），字段含蛋白质 / 脂肪 / 碳水 / 钠 / 钙。
- 与菜单做名称匹配后写入 `data/nutrition-cache.json` 和菜单条目里的 `nutrition` 字段。
- 匹配结果（门店 1450713，当前快照 125 品）：

| 分类 | 数量 |
|---|---|
| 菜单总品数 | 125 |
| 单品（营养匹配对象） | 54 |
| 套餐（990 开头，营养表无） | 66 |
| 周边 / 非食物 | 5 |
| **单品命中率（进入可信池）** | **63.0%（34/54）** |

匹配方式：精确匹配 + 别名表命中 + 子串包含；**歧义主动放弃（宁可标 unknown 也不猜）**。

**业务价值**：三大宏量营养素是营养环、减脂场景的数据来源。没这一层，前端的营养环只能是装饰品。

### 3. `query-nearby-stores` —— 附近门店

```js
await callTool('query-nearby-stores', { searchType: 2, city, keyword, beType: 1 });
```

- `searchType: 2` = 城市 + 关键词检索；产出 `data/stores-<city>.json`（现有上海、温州两份）。
- 前端「📍 定位」→ 浏览器定位 → 反查城市 → 后端按城市查门店 → 下拉选择。

**业务价值**：让「去哪家门店买」也基于官方门店数据，而不是写死一个门店名。

### 4. `calculate-price` + `create-order` —— 下单链路（只到支付链接为止）

```js
// server/order.js：期望价来自本地快照，核价走 MCP，差价即拦截
await callTool('calculate-price', { storeCode, orderType: 1, beType: 1, orderDetails });
await callTool('create-order', { /* … */ });   // 只取 orderId / payH5Url
```

**调用边界（安全红线）**：

1. **先核价**：本地快照算出期望总价 → `calculate-price` 取实时价 → 两者不一致返回 **409**，前端弹确认，绝不静默按旧价下单；
2. **create-order 只取两样东西**：`orderId` 与 `payH5Url`（支付链接），前端渲染二维码/链接后**流程终止**——不支付、不轮询支付状态、不自动跳转；
3. 未配置 Token 时返回 503 并提示可改用**演示订单**（`mock: true`，完全不碰 MCP，响应里明确标注 `source: "mock"`）。

**业务价值**：完整演示了真实交易链路的工程设计（期望价 → 实时核价 → 变价拦截 → 人工确认 → 交还支付），
同时把风险边界钉死在「把用户送到麦当劳自己的收银台」为止。

---

## 三、调用流程：离线优先，请求链路不直连 MCP

```
[MCP 拉取阶段]（一次性，可离线）
  query-meals + list-nutrition-foods
        │  名称匹配 / 营养回填
        ▼
  data/menu-<storeCode>.json  ← 可提交 git 的事实快照

[运行阶段]（每次请求）
  用户输入 → /api/plan
        │  读本地快照（按 mtime 热重载，改文件即生效）
        ▼
  确定性求解器 server/solver.js（整数分 + 组合枚举）
        ▼
  方案 JSON（价格/热量/营养全部来自快照）
        ▼
  前端渲染 + 前端独立重算校验（recompute）

[下单阶段]（用户显式触发）
  方案微调 → /api/order
        │  快照期望价 vs calculate-price 实时价
        ▼
  一致 → create-order 取支付链接 │ 变价 → 409 人工确认

[快照缺失时的兜底]
  仅当设了 MCD_MCP_TOKEN 时，api.js 才实时拉一次 query-meals 并落盘（ensureMenu）
  无 token 或拉取失败 → 返回诚实错误，绝不用假数据糊弄
```

**为什么这样设计：**

1. **限流**：600 次/分钟看着宽裕，但演示现场反复刷新 + 组合枚举放大，很容易打满；快照把请求数降到 0。
2. **断网可演示**：比赛现场网络不可控，快照让整条链路离线自洽。
3. **可复现**：快照进 git，任何人 clone 下来跑出的方案与演示时**完全一致**，评委复算有据。
4. **事实与决策分离**：MCP 只提供事实，求解与决策全在本地代码，便于审计。

---

## 四、业务价值总结

| 维度 | 没有官方 MCP 会怎样 | 接了 MCP 之后 |
|---|---|---|
| 热量 | 模型凭印象估，误差 20%~50%，控卡承诺直接失效 | 官方热量，`calorie_source` 标明来源 |
| 价格 | 模型编价格，总价对不上账单 | 官方价格，整数分求和，与菜单完全自洽 |
| 忌口 | 靠猜「这个算不算辣」 | 用官方标签 + 品名特征词匹配，误伤可控 |
| 营养 | 无法绘制三大宏量 | 63.0% 单品命中官方营养表，未命中诚实标 `unknown` |
| 下单 | 凭空生成订单号像玩具 | 真实核价 + 变价拦截，止于官方支付链接 |
| 可信度 | 演示像玩具 | 每个数字可回溯到官方接口，评委可当场核对 |

一句话：**MCP 提供事实，确定性代码保证算数，LLM 只负责把人话翻译成约束。** 三者分工清晰，
这也是本项目区别于「纯 prompt 输出一个菜单」的关键。

---

## 五、失败与降级策略

- **无 token**：菜单读快照；门店回退本地 `stores-<city>.json`；下单提示可改演示订单；不报错、不臆造。
- **HTTP 429**：明确抛「触发限流（600 次/分钟）」，提示稍后重试，不静默重试打爆接口。
- **超时 / 5xx**：`isError` 检查 + 15s 超时，失败即返回结构化错误，前端显示 error 态而非「无解」。
- **营养未命中**：`calorie: null` + `calorie_source: "unknown"`，求解器只在**可信池**
  （`kind==='single'` 且 `calorie_source==='official'`）内枚举，宁可少选也不算错。
- **核价变价**：期望价 ≠ 实时价 → 409 + 差额披露，交人工确认，不静默成交。
- **密钥安全**：token 只走环境变量 / `.env`（已 gitignore）；`githooks/pre-commit`
  拦截 `Bearer <密钥>`、`MCD_MCP_TOKEN=<值>` 明文入库。

---

## 六、已知限制（如实说明）

1. **套餐（66 个 990 开头）无营养数据**：官方营养表不覆盖套餐，实测 `query-meal-detail` 拆不出子项，
   因此套餐 `calorie_source` 为 `not_applicable`，不进入求解可信池。
2. **单品营养命中率 63.0%（34/54）**：未命中品需人工补别名（见 `docs/match-coverage-report.md`）。
3. **门店快照仅上海、温州**（城市级门店检索）：定位到其他城市会回退默认门店。
4. **下单止于支付链接**：不读取支付状态、不自动跳转，属有意设计的安全边界。
