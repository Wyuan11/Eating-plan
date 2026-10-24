# 项目长期记忆：麦门智选助手

## 项目背景
- 赛事：WayToAGI 1024 AI 切磋大会（用餐赛道）+ 麦当劳程序员创意开发大赛
- 周期：2026-10-24 → 2026-10-25（两天），团队 3 人
- 分工：1 后端（Skill + MCP 编排）/ 1 前端（Web 渲染）/ 1 产品文档
- 为麦当劳做点单助手，已接入麦当劳 MCP

## 已确认的项目约定
1. **架构**：Skill 严格为核心，Web 仅做交互渲染层，不直接调 MCP（参赛合规红线）
2. **场景**：控卡 + 省钱 双目标（预算 × 热量 × 忌口 × 人数 四维求解）
3. **下单深度**：到 `create-order` 生成支付链接为止，不真实支付
4. **可信度底线**：绝不编造热量数据，未知就标 `calorie_source: "unknown"`
5. **Git 权限（红线）**：仓库 `Wyuan11/Eating-plan` 由另一成员创建，**`main` 归对方，我方一律不推送、不改动 `main`**；
   所有产出只推 `feat/backend-MCP` 分支。需要合入 main 由对方发 PR，我不代劳。

## 核心技术决策
- **AI 出方案 + 前端确定性校验**：Skill 内 LLM 做语义理解与组合决策；Web 前端独立重算价格/热量，超标标红拦截，不一致以前端为准
- **桥接**：A 首选 Skill HTTP 触发；B 保底「文件桥」（Skill 输出 JSON 落盘 + 本地 Node 服务供前端轮询）。B 必须实现
- **营养匹配**：归一化（全角转半角、去空格标点、剥规格词）→ 别名表 → 精确 → 子串 → 编辑距离 ≥0.8

## MCP 使用要点
- 接入：`https://mcp.mcd.cn`，Streamable HTTP，`Authorization: Bearer <token>`，限流 600 次/分钟
- 账号为空号（0 积分、无配送地址）→ 演示走到店自取 beType=1
- `list-nutrition-foods` 160 条，静态可缓存；990 开头编码是套餐，需 `query-meal-detail` 拆子项
- `searchType=1`（收藏门店）会报 600050，必须 `searchType=2` + city + keyword

## 交付物位置
- 作战计划：`麦门智选助手-48小时作战计划.md`
- 参考手册（用户提供）：`D:\WJwork\Note\Adding Note\麦门智选助手-项目实现参考手册.md`
- MCP 接入文档：`C:\Users\WAN\Downloads\麦当劳MCP接入文档.md`
