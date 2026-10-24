# 麦门智选助手 · Web 前端

> 一款用自然语言提约束、由 AI 在 Skill 内调用麦当劳官方 MCP 数据求解最优组合，并用可视化界面呈现的点餐助手 —— 的**前端渲染壳**。

本目录只做三件事（严守职责红线）：**收集参数、渲染可视化、算术校验**。不直接调 MCP、不写推荐逻辑、不改后端业务结论。

## 技术栈

- Vue 3（`<script setup>` + Composition API）
- Vite 6
- 纯 CSS（无 UI 框架），营养环形图为手写 SVG，无图表库依赖

## 快速开始

```bash
cd web
npm install
npm run dev        # http://localhost:5173
```

生产构建：`npm run build` → 产物在 `dist/`；`npm run preview` 本地预览。

## 后端接通方式

前端只认 `/api/*`。Vite 已把 `/api` 代理到 `http://localhost:3000`（见 `vite.config.js`），对应后端成员 A 的 `server/api.js`：

```
GET  /api/stores?city=&keyword=
POST /api/plan           ← 核心（constraints → solver → Schema v1）
POST /api/order
GET  /api/health
```

**后端不在线时，前端自动回退到 `src/mock/` 内置演示数据**，并在结果顶部标注「内置演示数据」。所以：

- 现在（无后端）→ 也能离线完整演示（走 mock）
- 后端起来后 → 无需改前端，自动走真实链路（Step 2 联调即如此）

## 核心能力

| 能力 | 位置 | 说明 |
|---|---|---|
| 参数表单 + 一句话点单 | `components/ConstraintForm.vue` | 预算/人数/热量上限/忌口；自然语言输入做轻量回填（真正语义理解在 Skill） |
| 双进度条 | `components/MeterBar.vue` | 预算 + 热量，超限标红 |
| 营养环形图 | `components/NutritionRing.vue` | 蛋白/脂肪/碳水，配色经 CVD 校验 |
| 菜品卡 | `components/ItemCard.vue` | 热量来源透明标注（官方/估算/未公布） |
| 省钱模块 | `components/SavingsStrip.vue` | 原价 → 现价 · 省了多少 |
| 备选切换 | `components/PlanTabs.vue` | 均衡 / 更省钱 / 更低卡 |
| **独立校验** | `lib/verify.js` | 前端逐项重算价格/热量/营养，与后端声明值比对，不一致自动修正 |
| **超标拦截** | `components/ResultView.vue` | 重算超预算/超热量 → 红色警示 |

### 独立校验（答辩亮点）

`lib/verify.js` 不信任后端声明的 `total_price` / `total_calorie`，而是从 `items` 逐项重算：

- 一致 → 显示「已校验 ✓」
- 不一致 → 显示「已自动修正」，并以重算值为准
- 超限 → 进度条标红 + 明确警示

> 这是「AI 负责理解人，代码负责算准数」在渲染层的最后一层保险。

## 数据契约

字段严格遵循 `Schema v1`（见作战计划第五节 / `docs/api-schema.md`），类型说明见 `src/lib/schema.js`。**字段名不许改**，要改需升 v2 并同步后端。

## 目录结构

```
web/
├── index.html
├── vite.config.js        # /api 代理 → localhost:3000
└── src/
    ├── main.js
    ├── App.vue           # 布局 + 状态编排
    ├── style.css         # 设计令牌（品牌色 + 校验过的数据色）
    ├── lib/
    │   ├── schema.js     # Schema v1 类型 + 常量
    │   ├── verify.js     # 独立算术校验
    │   ├── api.js        # API 客户端 + mock 回退
    │   └── parseQuery.js # 自然语言轻量约束抽取（mock 演示）
    ├── mock/             # 内置演示数据（success / nosolution / stores）
    └── components/       # 表单、进度条、环形图、菜品卡、校验徽章等
```
