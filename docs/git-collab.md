# Git 协作说明（三人 · 48 小时）

> 目标：让队友的文件能进仓库、能合并、不互相覆盖。
> 当前状态：仓库已初始化，**尚未配置远端**（本机没有可用的托管 CLI 与 SSH 凭据，需要人工建仓）。
> 所以在远端就绪前，**用方案 B（bundle 单文件）**，它是现在就能用的。

---

## 一、分支约定

| 分支 | 负责人 | 内容 |
|---|---|---|
| `main` | 我（Skill/MCP） | 稳定主线，只接受合并，不直接开发 |
| `feat/web-frontend` | 前端 | `web/` 下的页面、组件、构建配置 |
| `feat/backend-api` | 后端 A | `server/api.js`、`server/order.js`、求解器相关 |

规则：`main` 只进已验证的代码；每人在自己分支上提交，确认能跑再合并回 `main`。

---

## 二、方案 B：bundle 单文件流转（无需任何账号，现在可用）

`git bundle` 把整个仓库（含全部分支和历史）压成一个文件，微信/QQ/网盘发过去，对方 `git clone` 这个文件即可，**效果和 clone 远端仓库一样**。

### 我 → 队友（发最新版）

```bash
bash scripts/bundle-out.sh
```

产物：`bundles/mcd-repo-<时间戳>.bundle`（约 136 KB）。
脚本会自动打印包内分支，确认 `main / feat/web-frontend / feat/backend-api` 都在再发出去。

### 队友首次接入

```bash
git clone "mcd-repo-20261024-xxxx.bundle" 麦门智选助手
cd 麦门智选助手
git config core.hooksPath githooks      # 必做，否则密钥拦截钩子不生效
git checkout feat/web-frontend          # 切到自己的分支（前端）
```

### 队友 → 我（交回成果）

```bash
git checkout feat/web-frontend
git add -A
git commit -m "feat: xxx"
git bundle create 回传.bundle --branches HEAD
```

把 `回传.bundle` 发给我。

### 我接收并合并

```bash
bash scripts/bundle-in.sh bundles/回传.bundle
git log --oneline teammate/feat/web-frontend -1      # 先看他改了什么
git diff main...teammate/feat/web-frontend           # 再核对改动
git checkout feat/web-frontend && git merge teammate/feat/web-frontend
git checkout main && git merge feat/web-frontend
```

脚本只拉取到 `refs/remotes/teammate/*`，**不自动合并、不碰工作区**，确认无误再手动合并。

### 两个坑（脚本已规避，手敲命令时必须注意）

1. **不能用 `--all`**：它会把 `refs/remotes/*` 一起打包，而 `git clone` 只认 `refs/heads/*`，队友 clone 完只能看到 `main`，看不到协作分支。
2. **必须显式带 `HEAD`**：只打分支时 bundle 里没有默认分支指针，队友 clone 完**工作区是空的**。

正确写法：`git bundle create out.bundle --branches HEAD`

---

## 三、方案 A：远端托管（推荐，需要你建一次仓）

在 GitHub / Gitee / CNB 任一平台新建一个**空仓库**（不要勾 README / .gitignore / license），拿到地址后：

```bash
cd C:\Users\WAN\WorkBuddy\1024AI切磋大会
git remote add origin <仓库地址>
git push -u origin --all          # 推全部分支
```

队友接入：

```bash
git clone <仓库地址>
cd 麦门智选助手
git config core.hooksPath githooks      # 必做
git checkout feat/web-frontend
```

队友交回：

```bash
git push origin feat/web-frontend
```

我合并：

```bash
git fetch origin
git checkout main && git merge origin/feat/web-frontend
```

> 若用 HTTPS 且没有凭据助手，首次 push 会要求登录；平台侧请生成 **Personal Access Token** 当密码用，不要输账号密码。

---

## 四、三条红线（每次提交前）

1. **密钥绝不入库**：`MCD_MCP_TOKEN`、Gateway `CODEBUDDY_GATEWAY_PASSWORD` 只放环境变量。
   `githooks/pre-commit` 会自动拦截明文密钥，**实测有效**（造含假密钥的文件提交会被拒，退出码 1）。
2. **clone 后必须跑 `git config core.hooksPath githooks`**，否则钩子不生效。
3. **不要 `git add` 运行时产物**：`data/skill-outbox/`、`bundles/*.bundle`、`node_modules/`、`web/dist/` 已在 `.gitignore` 中。

---

## 五、冲突了怎么办

两人改了同一个文件的同一处，merge 会报 `CONFLICT`：

```bash
git status                 # 看哪些文件冲突
# 打开冲突文件，删掉 <<<<<<< ======= >>>>>>> 标记，保留正确内容
git add <冲突文件>
git commit                 # 完成合并
```

不确定的话先 `git merge --abort` 撤回，商量好再合。48 小时赛程里，**改文件前先说一声**比事后解冲突便宜得多。
