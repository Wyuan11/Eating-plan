# Skill 约束提取测试用例

改 SKILL.md 后逐条复验。判定标准：**只验约束提取是否正确**，不验求解结果（求解结果由 solver 保证）。

## 用例 1：完整约束（四项齐全）

输入：

```text
两个人午餐，预算60元，热量不超过1200大卡，不要辣。
```

期望约束：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 60, "calorie_limit": 1200, "people": 2, "excluded": ["辣"] }
}
```

执行命令：

```bash
node server/emit-plan.js --traceId case1 --budget 60 --calorie 1200 --people 2 --exclude 辣 --intent "两个人午餐，预算60元，热量不超过1200大卡，不要辣"
```

实测结果（2026-10-24）：成功 → 双层吉士汉堡 + 麦香鸡 + 苹果片 + 燕麦奶铁 = ¥56.9 / 962 kcal。

---

## 用例 2：无明确热量上限（关键反例）

输入：

```text
两个人吃午饭，预算60元，想要低卡又划算。
```

期望约束：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 60, "calorie_limit": null, "people": 2, "excluded": [] }
}
```

**不合格输出**（出现即判失败）：

```json
{ "calorie_limit": 1000 }
```

「低卡」是偏好，不是用户给的数字。命令里必须省略 `--calorie`：

```bash
node server/emit-plan.js --traceId case2 --budget 60 --people 2 --intent "两个人吃午饭，预算60元，想要低卡又划算"
```

---

## 用例 3：无解场景

输入：

```text
三个人，预算15元，每个人都要一份主食。
```

期望约束：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 15, "calorie_limit": null, "people": 3, "excluded": [] }
}
```

执行命令：

```bash
node server/emit-plan.js --traceId case3 --budget 15 --people 3 --intent "三个人，预算15元，每个人都要一份主食"
```

实测结果（2026-10-24）：无解 → 「3 人最少需 3 份主食，最便宜主食 麦香鸡 17 元，3 份需 51 元，超出 15 元预算」，建议提高预算到 51 元或改为 1 人。

判定重点：Skill 必须如实转述，**不得**私自把预算改成 51 元或把人数改成 1 人后当成用户原方案返回。

---

## 用例 4：多忌口

输入：

```text
两个人，预算80元，不要辣，也不要牛肉。
```

期望约束：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 80, "calorie_limit": null, "people": 2, "excluded": ["辣", "牛肉"] }
}
```

执行命令：

```bash
node server/emit-plan.js --traceId case4 --budget 80 --people 2 --exclude 辣,牛肉 --intent "两个人，预算80元，不要辣，也不要牛肉"
```

---

## 复验方式

跑完命令后，检查落盘文件 `data/skill-outbox/plan-<traceId>.json`：

- `status` 是否与预期一致；
- `request.constraints` 是否与本文件期望完全一致（尤其 `calorie_limit` 是否为 `null`）；
- `plan.total_price`、`plan.total_calorie` 是否直接来自 `items` 累加（前端会独立重算，不一致会标红）。

---

## 用例 5：意图词不是商品（陷阱 1）

输入：

```text
我一个人，预算 40，想吃得划算的。
```

期望拆解：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 40, "calorie_limit": null, "people": 1, "excluded": [], "wants": [] },
  "objective": "cheapest"
}
```

**不合格输出**（出现即判失败）：

```json
{ "wants": [{ "keyword": "划算的", "qty": 1 }] }
```

「划算」是目标词不是商品，抽成 want 必然 nosolution。命令：

```bash
node server/emit-plan.js --traceId case5 --budget 40 --people 1 --objective cheapest --intent "我一个人，预算 40，想吃得划算的"
```

---

## 用例 6：口语简称原样传，不自行纠正（陷阱 2）

输入：

```text
一个人，预算 40，一个辣堡。
```

期望拆解：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 40, "calorie_limit": null, "people": 1, "excluded": [], "wants": [{ "keyword": "辣堡", "qty": 1 }] },
  "objective": "balanced"
}
```

**不合格输出**（出现即判失败）：

```json
{ "wants": [{ "keyword": "麦辣鸡腿堡", "qty": 1 }] }
```

求解器已支持简称匹配（字符子序列），会自行命中并披露「『辣堡』按简称匹配到：麦辣鸡腿汉堡」。
Skill 自己"纠正"成全名反而会猜错（菜单真名是「麦辣鸡腿汉堡」，多个「汉」字）。

```bash
node server/emit-plan.js --traceId case6 --budget 40 --people 1 --want "辣堡x1" --intent "一个人，预算 40，一个辣堡"
```

实测结果（2026-10-25）：成功 → 麦辣鸡腿汉堡×1 + 燕麦奶铁×1 + 苹果片×1 = ¥39.4，
`suggestion` 含「『辣堡』按简称匹配到：麦辣鸡腿汉堡」。

---

## 用例 7：品类忌口写品类词（陷阱 3）

输入：

```text
预算40，一个人，不要饮料。
```

期望拆解：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 40, "calorie_limit": null, "people": 1, "excluded": ["饮料"], "wants": [] }
}
```

**不合格输出**（出现即判失败）：

```json
{ "excluded": ["可乐", "雪碧", "美汁源"] }
```

品类忌口按 category 整类过滤，展开成商品清单必然列不全。

```bash
node server/emit-plan.js --traceId case7 --budget 40 --people 1 --exclude 饮料 --intent "预算40，一个人，不要饮料"
```

实测结果（2026-10-25）：成功 → 板烧鸡腿堡×1 + 圆筒冰淇淋×1 + 苹果片×1 = ¥35.5 / 516 kcal，整个饮品分类消失。

---

## 用例 8：诉求数量是硬约束（陷阱 4）

输入：

```text
预算40，只要一个冰淇淋。
```

期望拆解：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 40, "calorie_limit": null, "people": 1, "excluded": [], "wants": [{ "keyword": "冰淇淋", "qty": 1 }] }
}
```

**不合格输出**：`qty` 改成 2，或因为"一个太少"而忽略该诉求。

```bash
node server/emit-plan.js --traceId case8 --budget 40 --people 1 --want "冰淇淋x1" --intent "预算40，只要一个冰淇淋"
```

实测结果（2026-10-25）：成功 → 板烧鸡腿堡×1 + 燕麦奶铁×1 + 圆筒冰淇淋×1 = ¥38.4，冰淇淋**恰好 1 个**。

---

## 用例 9：无法执行的偏好只披露（陷阱 5）

输入：

```text
预算40，一个人，中辣，不要冰饮。
```

期望拆解：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 40, "calorie_limit": null, "people": 1, "excluded": ["冰饮"], "wants": [] },
  "notes": [{ "text": "中辣", "reason": "菜单无辣度分级数据，该口味偏好已记录但未参与求解" }]
}
```

**不合格输出**：把「中辣」塞进 `excluded`（会误杀所有含辣商品），或声称"已按中辣筛选"。

温度忌口可真执行（菜单有 `temperature:'cold'` 标注），辣度分级没有数据，只能披露。

```bash
node server/emit-plan.js --traceId case9 --budget 40 --people 1 --exclude 冰饮 --note "中辣|菜单无辣度分级数据，该口味偏好已记录但未参与求解" --intent "预算40，一个人，中辣，不要冰饮"
```

---

## 用例 10：人数与诉求数量的区分（数字归属）

输入：

```text
两个人，预算60，来两个麦香鸡。
```

期望拆解：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 60, "calorie_limit": null, "people": 2, "excluded": [], "wants": [{ "keyword": "麦香鸡", "qty": 2 }] },
  "objective": "balanced"
}
```

判定重点：第一个「两个」跟「人」→ 人数；第二个「两个」跟「麦香鸡」→ 诉求数量。
**不得**把「两个人」当成"想吃两个人份"，也**不得**把「两个麦香鸡」当成人数。

注意口语「两**个**人」中间有量词「个」，不是「两人」。

```bash
node server/emit-plan.js --traceId case10 --budget 60 --people 2 --want "麦香鸡x2" --intent "两个人，预算60，来两个麦香鸡"
```

---

## 用例 11：吃满预算目标

输入：

```text
两个人，预算60，想把钱花完，能吃什么？
```

期望拆解：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 60, "calorie_limit": null, "people": 2, "excluded": [], "wants": [] },
  "objective": "max_value"
}
```

「把钱花完 / 能吃什么 / 最值」→ `max_value`（吃满预算），不是 `cheapest`。

```bash
node server/emit-plan.js --traceId case11 --budget 60 --people 2 --objective max_value --intent "两个人，预算60，想把钱花完，能吃什么？"
```

---

## 用例 12：诉求与忌口冲突（必须如实无解）

输入：

```text
预算40，来个辣堡，但是不要辣的。
```

期望拆解（照常拆解，冲突交给求解器判定）：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 40, "calorie_limit": null, "people": 1, "excluded": ["辣"], "wants": [{ "keyword": "辣堡", "qty": 1 }] }
}
```

判定重点：Skill **照实拆**，不要自作主张删掉诉求或去掉忌口。求解器会返回带原因的
`nosolution`（冲突点：`正向诉求 vs 忌口`），Skill 如实转述并让用户自己决定。

```bash
node server/emit-plan.js --traceId case12 --budget 40 --people 1 --exclude 辣 --want "辣堡x1" --intent "预算40，来个辣堡，但是不要辣的"
```

---

## 用例 13：子类排除——「不要咖啡」

输入：

```text
一个人，预算 40，一个辣堡，不要咖啡。
```

期望拆解：

```json
{
  "storeCode": "1450713",
  "constraints": { "budget": 40, "calorie_limit": null, "people": 1, "excluded": ["咖啡"], "wants": [{ "keyword": "辣堡", "qty": 1 }] }
}
```

判定重点：「咖啡」既不是四大分类（主食/小食/饮品/甜品）也不是温度词，是**子类标签排除**——
靠商品 `tags` 命中（如燕麦奶铁的 tag「麦咖啡™咖啡」）。

**不合格输出**：把「咖啡」展开成 `["卡布奇诺","拿铁",...]` 商品清单（列不全），或写成 `["饮品"]`（误杀全部饮料）。

```bash
node server/emit-plan.js --traceId case13 --budget 40 --people 1 --exclude 咖啡 --want "辣堡x1" --intent "一个人，预算 40，一个辣堡，不要咖啡"
```

实测结果（2026-10-25）：成功 → 麦辣鸡腿汉堡×1 + 纯悦×1 + 苹果片×1 = ¥37。
7 款咖啡类饮品（含燕麦奶铁）全部被过滤，燕麦奶 / 抹茶阿芙佳朵等非咖啡保留。
