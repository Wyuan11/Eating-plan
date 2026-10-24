# 后端双人作战手册

> 前端已按 `docs/api-schema.md` 开工。这份是**后端两人（A：服务/算法，B：Skill/MCP 桥）**的执行手册。
> 所有字段与前端契约严格一致，**不要擅自改字段名**。

---

## 0. 一句话分工

```
用户自然语言
     │
     ▼
┌─────────────┐   结构化 constraints     ┌─────────────┐   Schema v1 JSON   ┌────────┐
│  Skill（B） │ ───────────────────────▶ │  Solver（A）│ ─────────────────▶ │  前端  │
│ 语义理解     │  {budget, calorie_limit, │ 确定性求解   │   plan / 无解      │ 渲染   │
│ 忌口/偏好抽取 │   people, excluded}      │ 价格热量累加 │                    │ + 校验  │
└─────────────┘                          └─────────────┘                    └────────┘
      ▲                                        ▲
      │                                        │
   Person B                                Person A
```

**切分依据是 `constraints` 这一个 JSON。** 两边各自独立开发，谁都不阻塞谁。

**为什么 solver 不放在 Skill 里？** 这不违背「Skill 为核心」——Skill 仍然是**唯一的决策入口**（用户说什么 → 要什么约束 → 偏好什么口味，全在 Skill 里由 AI 决定）。Solver 只是**执行器**：给定约束，保证算出的价格和热量绝对准确。大模型做加法会错，「保证 1200 大卡内」这种硬承诺不能交给它。
**答辩话术**：AI 负责理解人，代码负责算准数——我们知道 AI 的能力边界在哪。

---

## 1. 第一步（今天，2–3 小时）：三条并行线

> **第一天的唯一目标：不依赖 Skill，后端也能独立产出一份合法的 `plan.success.json。**
> 也就是说——**先把"没有 AI 也能跑"的版本做出来**，AI 是增强，不是依赖。

| 谁 | 做什么 | 产出 | 验收标准 |
|---|---|---|---|
| **B（30 分钟，先做）** | 验证 Skill 能否被外部 HTTP 触发 | 一句话结论：能 / 不能 | 见 §2，跑通或明确放弃 |
| **A（立即开始，不被阻塞）** | 跑通 `server/solver.js`，读懂并调评分 | 能用 CLI 算出方案 | 见 §3 的四条 |
| **B（验证完之后）** | 补 `data/alias-map.json` 别名，把命中率从 63% 往上推 | 更新的别名表 | 重跑后命中数增加 |

> ⚠️ **B 的第一件事只有一件：验证 HTTP 触发。** 这是全项目唯一的架构级未知项，手册里那个 `api.workbuddy.com/trigger/xxx` 是占位符。
> **30 分钟出不结论就立刻切「文件桥」保底方案，不要继续挖。** 保底方案见 §2-B。

---

## 2. Person B：Skill 与 MCP 桥

### 2.1 先做的决策点（30 分钟）

**方案 A（首选）**：Skill 能被外部 HTTP 触发 → Web 后端 POST 给 Skill，拿到 JSON 返回。
**方案 B（保底，必须准备）**：文件桥 —— Skill 把结果写成 `data/skill-outbox/plan-<traceId>.json`，本地 Node 服务监听目录 / 轮询读取。

> **B 方案必须做出来，不能赌 A。** 好在它对前端完全透明——前端只认 `/api/*`。

### 2.2 已交付：`server/mcp-client.js`（**重大解锁**）

**实测结论：`https://mcp.mcd.cn` 是标准 streamable HTTP MCP Server，不需要 session 握手，直接 POST `tools/call` 就能调。**

这意味着：**后端脚本能自己直连 MCP 拉数据，既不需要依赖 WorkBuddy 的 MCP 挂载，也不需要经过 Skill。**

```
环境变量：MCD_MCP_TOKEN（从 ~/.workbuddy/mcp.json 里取那串 Bearer token，不要提交到 git）
限流：600 次/分钟
```

用法：

```js
const { callTool } = require('./mcp-client');
const text = await callTool('query-meals', { storeCode: '1450713', orderType: 1, beType: 1 });
```

### 2.3 已交付：`server/fetch-menu.js`（数据管道）

```bash
export MCD_MCP_TOKEN=xxx
node server/fetch-menu.js --store 1450713 --mock
```

**它比第一版强在三点**（都是实测发现的）：
1. **用麦当劳官方分类判定品类**，不再靠品名瞎猜。菜单返回里有 `data.categories[].name`（如「鸡肉汉堡/卷」「巨无霸牛鱼肉堡」「500大卡套餐」），映射到主食/小食/饮品/甜品。第一版靠关键词猜，把「麦香鸡」错分成了小食。
2. **用真实 `currentPrice` / `originalPrice`**，所以「省了多少」是真的。实测：燕麦奶铁 9.9/23（省 13.1）、麦咖啡奶铁 13.9/21、龙焰鸡腿堡 15.9/24。
3. **真实图片 URL**（`data.meals[].image`）。

⚠️ **两个已踩过的坑，别再踩**：
- MCP 返回的 `Original Response` 里，营养表是**二次转义**的：换行是字面量 `\n` 两个字符，必须先 `replace(/\\n/g, '\n')` 再按行切。
- 营养表是 **TOON 紧凑格式** `[160]{字段...}:\n 值,值,值`，不是 JSON。

**B 的持续任务**：补 `data/alias-map.json`。当前 34/54（63%）。未命中的全是新品/限时品（龙焰系列、枫糖厚松饼堡、马苏里拉芝士条…）。
**原则：宁可标 `unknown` 也不要乱猜。** 有歧义的品名（「派」可能是香芋派或菠萝派）加进 `blocklist`，不要塞进 `map` 刷命中率。

### 2.4 B 的第二阶段：写 Skill 提示词

Skill 只输出**结构化约束**，不要让它算数：

```jsonc
{
  "storeCode": "1450713",
  "constraints": { "budget": 60, "calorie_limit": 1200, "people": 2, "excluded": ["辣"] },
  "intent": "减脂期两人午餐，想要低卡又划算"
}
```

提示词要约束住的事：
- 「在减脂」→ `calorie_limit` 取 1000–1400；「随便吃点」→ 不设上限
- 「不吃辣」→ `excluded: ["辣"]`（注意 tag 精确匹配，别把「不辣」误判成辣）
- 「两个人」→ `people: 2`，**并提醒 solver 每人至少一份主食**
- 预算没说就默认 60，并明确告诉用户这是默认值

---

## 3. Person A：服务与算法

### 3.1 已交付：`server/solver.js`（确定性求解器）

```bash
node server/solver.js --budget 60 --calorie 1200 --people 2 --exclude 辣
node server/solver.js --budget 60 --people 2 --out web/mock/plan.success.json
```

**算法思路**：
- 只用**可信池**（`kind==='single'` 且 `calorie_source==='official'`），官方没公布营养的新品一律不参与
- 硬约束：`people` 份主食 + 总价 ≤ budget + 总热量 ≤ calorie_limit（若设）
- 枚举主食组合 × 0–3 件配餐，剪枝后逐条算分
- 三种目标各取最优：均衡（主方案）/ 最省钱 / 最低卡（后两个进 `alternatives`）

**均衡分权重**：预算利用率 0.3 + 热量贴合度 0.3 + 品类齐全度 0.2 + 蛋白占比 0.1 + 优惠力度 0.1

**A 的调优点**：权重是拍的，跑几个场景看看结果合不合常理，不合适就调。这是 A 今天最该花时间的活——**评分函数决定产品气质**。

### 3.2 A 的验收（今天必须过这四条）

```bash
# 1. 主场景
node server/solver.js --budget 60 --calorie 1200 --people 2 --exclude 辣
# 2. 无解场景（必须给出冲突原因 + 放宽建议，不能只说"无法推荐"）
node server/solver.js --budget 15 --people 3
# 3. 不设热量上限
node server/solver.js --budget 40 --people 1
# 4. 多重忌口
node server/solver.js --budget 80 --calorie 1000 --people 2 --exclude 辣,牛肉
```

四条都必须跑通，且**输出的热量/价格与 items 累加完全一致**（这是硬指标，前端会重算校验）。

### 3.3 A 的下一步：`server/api.js`（Express / 或原生 http）

把 solver 包成 Schema v1 接口：

```
GET  /api/stores?city=&keyword=
GET  /api/menu?storeCode=
POST /api/plan           ← 核心
POST /api/order
GET  /api/health
```

要点：
- `/api/plan` 内部：收到 constraints → 调 solver → 直接返回。**第一阶段不接 Skill，先把链路跑通**
- 菜单走本地缓存 `data/menu-1450713.json`，别每次请求都打 MCP（限流 600/min，且慢）
- 出错返回 Schema v1 的 `PlanFailure`，`retryable` 标清楚
- 加 `--mock` 之外的 CORS：`Access-Control-Allow-Origin: *`（前端 Vite 默认 5173）

---

## 4. 联调顺序（别一上来就全接）

```
Step 1  前端 + mock                    ← 现在
Step 2  前端 + /api/plan（solver 直出） ← A 完成后立刻联，此时完全不依赖 Skill
Step 3  /api/plan 换成「Skill → constraints → solver」
Step 4  接 /api/order 拿支付链接
```

**Step 2 必须能独立完成。** 这样即使 Step 3 出问题，演示照样跑得起来。

---

## 5. 命令速查

```bash
# 配置 token（从 ~/.workbuddy/mcp.json 取）
export MCD_MCP_TOKEN=xxx

# 拉最新菜单（会刷新 web/mock/menu.json）
node server/fetch-menu.js --store 1450713 --mock

# 求解
node server/solver.js --budget 60 --calorie 1200 --people 2 --exclude 辣

# 只重跑营养匹配，不联网
node server/fetch-menu.js --offline --mock
```

---

## 6. 红线（谁都不许碰）

1. **不许把 `calorie: null` 当 0 参与计算**——会影响求解正确性
2. **不许为了让方案好看去估算新品热量**——官方没公布就是没公布，如实说
3. **不许改 Schema 字段名**——前端已经按 `docs/api-schema.md` 在写了，要改就升 v2 并同步通知
4. **不许把 token 提交到 git**——加 `.gitignore`
5. **不许真实下单支付**——演示到 `payH5Url` 二维码为止
