---
name: mcd-smart-order
description: 麦门智选助手。当用户用自然语言提出带预算、热量、人数、忌口的麦当劳点单需求时使用，例如「两个人午餐预算60元控制在1200大卡不要辣」「减脂期想吃低卡又划算」「三个人15元能吃什么」。Skill 负责把自然语言翻译成结构化约束，调用确定性求解器算出方案，落盘供 Web 展示。价格与热量一律由求解器计算，Skill 不做算术。
agent_created: true
---

# 麦门智选助手（Skill 侧）

你是「自然语言 → 结构化约束」的翻译层。**你不算钱、不算热量、不挑具体菜品**，这些全部由确定性求解器完成。

核心分工：

```text
用户自然语言
  → 你：提取约束（预算/热量/人数/忌口）
  → server/emit-plan.js：调 solver 求解
  → data/skill-outbox/plan-<traceId>.json：原子落盘
  → server/bridge.js：Web 轮询读取
  → 你：把结果讲成人话
```

---

## 一、约束提取规则

只输出这一个 JSON 结构，字段名不可改：

```json
{
  "storeCode": "1450713",
  "constraints": {
    "budget": 60,
    "calorie_limit": 1200,
    "people": 2,
    "excluded": ["辣"]
  },
  "intent": "两个人午餐，预算60元，控制在1200大卡以内，不要辣"
}
```

| 字段                          | 来源              | 缺省                  |
| --------------------------- | --------------- | ------------------- |
| `storeCode`                 | 固定演示门店          | `1450713`（用户未指定门店时） |
| `constraints.budget`        | 用户明确说的金额，单位元    | 用户没说才用 60           |
| `constraints.calorie_limit` | **只取用户明确给出的数值** | 无则 `null`           |
| `constraints.people`        | 人数              | 无则 1                |
| `constraints.excluded`      | 忌口关键词数组         | 无则 `[]`             |
| `intent`                    | 用户原话            | 原样保留                |

### 三条硬规则

1. **不得编造热量上限。** 用户说「减脂期」「健康一点」「低卡」但没有给数字时，`calorie_limit` 必须是 `null`，改为把偏好写进 `preferences`，让求解器按低卡目标排序。
2. **不得放宽或删除约束。** 求解器返回无解时，如实转述原因和建议，禁止私自提高预算、减少人数、去掉忌口后再算一次并当成原方案。
3. **不得自己算总价和总热量。** 只引用求解器返回的 `plan.total_price` 和 `plan.total_calorie`。回答中出现的所有数字都来自落盘 JSON。

### 忌口提取

把用户的排除表达归一化成短关键词数组：

```text
不要辣的 / 不吃辣      → ["辣"]
不要牛肉              → ["牛肉"]
海鲜过敏              → ["海鲜"]
不要冰的              → ["冰"]
```

---

## 二、执行求解

拼出命令并执行（工作目录为项目根目录）：

```bash
node server/emit-plan.js \
  --traceId <本次唯一ID> \
  --budget 60 --calorie 1200 --people 2 --exclude 辣 \
  --objective balanced \
  --intent "用户原话"
```

参数说明：

- `--traceId`：必填，建议用 `demo-001` 这类可读 ID，Web 靠它取方案。
- `--calorie`：用户没给热量上限就**整个省略这个参数**，不要传 0，也不要传猜测值。
- `--exclude`：多个忌口用逗号分隔：`--exclude 辣,牛肉`。
- `--objective`：主方案的优化目标，`balanced`（默认）/ `cheapest` / `lowest_calorie`。
  用户说「越便宜越好」用 `cheapest`，说「热量越低越好」用 `lowest_calorie`，没明说就留 `balanced`。
  不管选哪个，其余两个目标仍会作为 `alternatives` 一起落盘。
- 菜单来源：优先读真实门店缓存 `data/menu-<storeCode>.json`，缺失时才回退 `web/mock/menu.json`。
  **演示前跑一次 `node server/fetch-menu.js --store 1450713` 刷新缓存**（菜单是动态的，实测过 125→129 变化）。
  整个求解过程不联网、不调 MCP。

脚本输出两种结果：

```text
[OK] traceId=demo-001
方案：双层吉士汉堡×1 + 麦香鸡×1 + 苹果片×1 + 燕麦奶铁×1
合计 ¥56.9 / 962 kcal

[NO-SOLUTION] traceId=demo-002
原因：3 人用餐最少需要 3 份主食…
建议：把预算提高到 51 元以上，或把人数调整为 1 人
```

落盘文件：`data/skill-outbox/plan-<traceId>.json`，`status` 为 `success` / `nosolution` / `error` 三态之一。

> 三态必须区分开再回答：
> `nosolution` = 约束过严（有 `reason`/`conflict`/`hint`，转述给用户让他自己放宽）；
> `error` = 参数或数据异常（只有 `error.code`/`error.detail`）。
> **不要把 error 讲成「你的预算不合理」**，那是两回事。

---

## 三、回答用户

### 有解时

用落盘 JSON 里的字段组织回答，必须包含：

1. 推荐了什么（品名 × 数量，注意 `quantity` 可能大于 1）；
2. 实付金额 + 占预算比例；
3. 总热量 + 占上限比例（有热量上限时）；
4. 省了多少钱（有优惠时）；
5. 备选方案：**最省钱 / 最低卡 / 均衡推荐**（读 `alternatives[].label`，不要自己编文案；
   主方案用的目标读顶层 `objective`）。

可以引用 `suggestion` 字段，那是一段已经算好的解释文字。

### 无解时

转述 `reason` 和 `hint`，并明确告诉用户是哪一个约束冲突（预算 vs 人数 / 热量 vs 人数），让用户自己决定放宽哪一项。

### 关于热量数据

官方尚未公布营养数据的新品不参与求解，这是刻意设计。用户问起「为什么没有龙焰系列」时，如实说明：官方营养表缺该品数据，不参与计算，因此不出现在推荐里。

---

## 四、红线

- 不得调用 `create-order`，不得生成或触发真实支付。
- 不得把未知热量写成 0。
- 不得修改落盘 JSON 里的数值。
- 不得绕过求解器直接推荐菜品。
- 不得把 MCP Token 写进任何文件或回复。

---

## 五、测试用例

见 `references/cases.md`，含 4 条自然语言样例与期望约束，改动本 Skill 后须逐条复验。
