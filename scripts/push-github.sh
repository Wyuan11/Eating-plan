#!/usr/bin/env bash
# 首次把本项目推送到 GitHub：https://github.com/Wyuan11/Eating-plan
# 用法：在项目根目录打开 Git Bash（或 GitHub Desktop 的 Open in Command Prompt），
#       运行：bash scripts/push-github.sh
#
# 为什么 main 要用 --force：
#   GitHub 网页上已经手动上传过一版文件快照（一个没有历史的提交）。
#   本地仓库有完整提交历史且内容是它的超集/更新版，用 force 用完整历史
#   替换那个快照即可，文件内容不会丢，只会更全。之后的日常推送不再需要 force。
set -euo pipefail

REMOTE_URL="https://github.com/Wyuan11/Eating-plan.git"

# 环境里若有指向本机的代理变量（WorkBuddy 沙箱），推 GitHub 时绕开它们
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy 2>/dev/null || true

git remote add origin "$REMOTE_URL" 2>/dev/null || git remote set-url origin "$REMOTE_URL"
echo "[OK] 远端已指向 $REMOTE_URL"

echo "[1/3] 推送 main（--force 替换网页上传的快照提交，本地完整历史为准）..."
git push -u origin main --force

echo "[2/3] 推送协作分支 feat/web-frontend 与 feat/backend-api ..."
git push -u origin feat/web-frontend feat/backend-api

echo "[3/3] 完成。现在可以："
echo "  - 队友 clone:  git clone https://github.com/Wyuan11/Eating-plan.git"
echo "  - 或在 GitHub Desktop 里按 PR 流程开分支开发"
echo "首次推送时会弹出 GitHub 登录窗口（授权一次即可）。"
echo "若终端里提示输密码：GitHub 已不支持账号密码，需用 Personal Access Token，"
echo "或直接改用 GitHub Desktop 推送（它自带登录授权）。"
