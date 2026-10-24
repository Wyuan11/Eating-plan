# 动手实操手册

> 目标：你自己把整条链路跑一遍，亲眼看到「输入 → 求解 → 方案 → 校验」的效果。
> 当前数据来自本地菜单快照（125 品，其中可信营养池 34 品），**全程离线可跑**，不需要 Token。

---

## 0. 三个服务（已帮你启动，端口别关）

| 端口 | 命令 | 作用 |
|---|---|---|
| 3000 | `node server/api.js` | 后端求解 API（前端 `/api` 被 Vite 代理到这里） |
| 8787 | `node server/bridge.js --port 8787` | 文件桥，读 Skill 落盘方案 |
| 5173 | `cd web && npm run dev` | Vue 前端页面 |

确认活着：

```bash
curl http://127.0.0.1:3000/api/health   # 期望 ok:true, menu.count:125
curl http://127.0.0.1:8787/api/health   # 期望 ok:true
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5173/   # 期望 200
```

服务是我在后台起的进程，**会话结束可能被回收**。自己重启就按上表三条命令，各开一个终端窗口。

---

## 1. 玩法 A：浏览器里点一点（30 秒看效果）

打开 **http://localhost:5173**

1. 「用一句话点单」里填：`两个女生，预算 60，在减脂，不吃辣`
   （懒得打字就点下面的快捷预设按钮）
2. 预算 60 / 人数 2 / 热量上限开关打开填 1200 / 忌口勾「辣」
3. 点提交 → 看三块东西：
   - **方案卡片**：每样点了什么、单价
   - **合计条**：总价 ¥56.9、总热量 962 kcal、省了多少、预算占用 95% / 热量占用 80%
   - **校验徽章**：前端独立重算价格与热量，跟后端一致才亮绿
4. 判断是不是走了真实后端：页面右上角若出现「演示数据 / 未连接后端」字样说明回退到 mock 了，此时去检查 3000 端口还活着没。

**同一份输入改一个数字就能看状态变化**（见第 4 节）。

---

## 2. 玩法 B：命令行跑通全链路（看清每一步产物）

```bash
# ① Skill 侧：约束 → 求解 → 原子落盘
node server/emit-plan.js --traceId handson-001 \
  --budget 60 --calorie 1200 --people 2 --exclude 辣 \
  --intent "两个人午餐60元1200大卡不要辣"
# 期望：[OK] traceId=handson-001 / 方案：双层吉士汉堡×1 + 麦香鸡×1 + 燕麦奶铁×1 + 苹果片×1 / 合计 ¥56.9 / 962 kcal

# ② 看落盘文件
cat data/skill-outbox/plan-handson-001.json

# ③ 文件桥读出来（前端轮询的就是这个）
curl http://127.0.0.1:8787/api/plan/handson-001

# ④ 直接问后端求解（不落盘）
curl -X POST http://127.0.0.1:3000/api/plan -H "Content-Type: application/json" \
  -d '{"budget":45,"people":1,"calorie_limit":null,"excluded":[],"objective":"cheapest"}'
```

`objective` 三选一：`cheapest`(最省钱) / `lowcal`(最低卡) / `balanced`(均衡，默认)。

---

## 3. 玩法 C：HTTP 触发 Skill（真正让 AI 参与语义理解）

前面两条是「约束已给定、确定性求解」。想看 **AI 从自然语言里抽约束** 这一段，走 Gateway：

```bash
node server/trigger-skill.js --text "两个女生，预算60，减脂，不吃辣" \
  --budget 60 --calorie 1200 --people 2 --exclude 辣
```

它会：自动发现本机 Gateway → POST `/api/v1/runs`（拿到 202 + runId）→ 轮询 outbox 直到方案出现 → 打印结果。
Gateway 不可达时自动降级到本地求解（会明确提示已降级），所以这条命令在任何情况下都不会卡死。

---

## 4. 三种状态必须都看一遍（演示前必修）

| 状态 | 怎么触发 | 期望看到 |
|---|---|---|
| `success` | budget 60 / people 2 | 出方案，¥56.9 / 962 kcal |
| `nosolution` | budget 15 / people 2 | `status:"nosolution"`，文案「约束过严，无法生成方案」，**不是报错** |
| `error` | budget -1 | `error.code:"BAD_REQUEST"`，detail 指明哪个字段错 |
| `pending` | 桥接查一个不存在的 traceId | **HTTP 404 + `status:"pending"`**，前端应继续轮询，别当失败 |

```bash
curl -X POST http://127.0.0.1:3000/api/plan -H "Content-Type: application/json" -d '{"budget":15,"people":2,"calorie_limit":null,"excluded":[]}'
curl -X POST http://127.0.0.1:3000/api/plan -H "Content-Type: application/json" -d '{"budget":-1,"people":1}'
curl -i http://127.0.0.1:8787/api/plan/not-exist-xyz
```

---

## 5. 演示前必做

```bash
node scripts/demo-check.js            # 7 项自检，全 PASS 才算能演示
node server/fetch-menu.js --store 1450713   # 有 Token 时刷新成真实菜单（会调 MCP）
node server/fetch-menu.js --offline         # 没 Token：用本地缓存重跑营养匹配
node scripts/clean-outbox.js                # 清理历史方案（默认只预演，加 --yes 才真删）
```

---

## 6. 出问题先看这里

- **页面显示「演示数据」**：3000 挂了或 Vite 代理没生效 → `curl http://127.0.0.1:3000/api/health`。
- **提交后一直转圈**：solver 枚举慢或超时（前端 30s 上限）→ 换 `objective` 或提高预算再看。
- **端口被占用**：`netstat -ano | findstr :3000` 找到 PID，或换端口 `node server/api.js --port 3001`（同时改 `web/vite.config.js` 的 proxy target）。
- **热量显示「—」而不是 0**：这是对的。该菜品营养数据未知时写 `null` + `calorie_source:"unknown"`，**绝不估算**。
- **前端改了没生效**：Vite 有热更新，改了 `vite.config.js` 才需要重启。

## 7. 红线（操作别越界）

- 不调 `create-order`，不真实支付（`/api/order` 目前固定返回 501）。
- 演示固定门店 `1450713` + 到店自取（`orderType=1, beType=1`）。
- MCP Token 与 Gateway 密钥不进代码、不进 git（提交钩子会拦）。
