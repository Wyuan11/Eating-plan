# Skill 回归用例（4 条）

改动 `SKILL.md` 或 `server/emit-plan.js` 后，逐条复验。

复验方式（工作目录为项目根目录，先刷新菜单缓存）：

```bash
node server/fetch-menu.js --store 1450713          # 可选：刷新真实菜单缓存
node server/emit-plan.js --traceId <case> --budget <B> [--calorie <C>] --people <P> [--exclude <E>] --intent "<原话>"
```

判定：看终端首行的 `[OK]` / `[NO-SOLUTION]` / `[ERROR]`，并与下表期望值比对。
落盘文件 `data/skill-outbox/plan-<traceId>.json` 的 `status` 必须与期望状态一致。

---

## 用例 1 · 有解（主演示场景）

- **traceId**：`demo-001`
- **用户原话**：两个人午餐，预算60元，控制在1200大卡以内，不要辣
- **期望约束**：`budget=60`、`calorie_limit=1200`、`people=2`、`excluded=["辣"]`、`objective=balanced`
- **期望状态**：`success`
- **期望数值**：实付 ¥56.9 / 962 kcal（菜单快照刷新后数值可能变化，以落盘为准）
- **重点检查**：
  - 回答里的金额与热量**全部**取自 `plan.total_price` / `plan.total_calorie`，不是自己加出来的；
  - `alternatives` 三个 label 是「最省钱 / 最低卡 / 均衡推荐」；
  - 每个 item 的 `calorie_source === 'official'`。

## 用例 2 · 无解（预算 vs 人数）

- **traceId**：`demo-002`
- **用户原话**：三个人吃午饭，预算只有15元
- **期望约束**：`budget=15`、`calorie_limit=null`（用户没提热量，禁止编造）、`people=3`、`excluded=[]`
- **期望状态**：`nosolution`
- **期望 `conflict`**：`预算 vs 人数`
- **重点检查**：
  - 必须原样转述 `reason` + `hint`，**不许私自把预算提到 51 元再算一次**；
  - 明确告诉用户「是预算和人数冲突」，让他自己决定放宽哪一项。

## 用例 3 · 不得编造热量上限

- **traceId**：`case2`
- **用户原话**：我一个人吃，预算40，减脂期想吃得健康点
- **期望约束**：`budget=40`、`calorie_limit=null`、`people=1`、`excluded=[]`
- **期望状态**：`success`
- **重点检查**（本条是红线用例）：
  - 「减脂期」「健康点」**没有给数字**，`calorie_limit` 必须是 `null`；
  - 落盘 JSON 里 `plan.calorie_usage` 必须是 `"—"`；
  - 命令里**不能出现** `--calorie`（传了 1200 就是犯规）。

## 用例 4 · 多忌口

- **traceId**：`case4`
- **用户原话**：两个人不吃辣，牛肉过敏，海鲜也不碰，预算80
- **期望约束**：`budget=80`、`calorie_limit=null`、`people=2`、`excluded=["辣","牛肉","海鲜"]`
- **期望状态**：`success`
- **重点检查**：
  - 三个忌口全部进 `excluded`，一个都不能漏；
  - 落盘 `items` 里不得出现品名或标签含「辣 / 牛肉 / 鱼 / 虾 / 蟹 / 鱿」的条目；
  - 主食份数之和 ≥ `people`。
