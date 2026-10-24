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
