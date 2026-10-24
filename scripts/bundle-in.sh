#!/usr/bin/env bash
# 收队友的 .bundle 文件：先校验，再当作远端拉进来（不自动合并，避免冲掉本地改动）
# 用法: scripts/bundle-in.sh <bundle文件路径>
#   例: scripts/bundle-in.sh bundles/from-teammate.bundle
set -euo pipefail
cd "$(dirname "$0")/.."

F="${1:-}"
if [ -z "$F" ]; then
  echo "用法: scripts/bundle-in.sh <bundle文件路径>"
  exit 2
fi
if [ ! -f "$F" ]; then
  echo "[ERROR] 文件不存在: $F"
  exit 2
fi

# verify 会检查 bundle 是否完整、依赖的提交是否都在本仓库里有
if ! git bundle verify "$F" 2>&1 | tail -5; then
  echo "[ERROR] 校验未通过：文件损坏，或缺少前置提交（队友需基于最新版本重新打包）"
  exit 1
fi
echo "[OK] 校验通过"

echo "=== 这个 bundle 里包含的分支 ==="
git bundle list-heads "$F"

# 当作一次性远端拉取，落到本地的 teammate/* 引用下，不碰当前工作区
git fetch "$F" 'refs/heads/*:refs/remotes/teammate/*'

echo
echo "[OK] 已拉取到 refs/remotes/teammate/*"
echo "下一步："
echo "  git log --oneline teammate/feat/web-frontend    # 看队友提交了什么"
echo "  git diff main...teammate/feat/web-frontend      # 看改动内容"
echo "  git merge teammate/feat/web-frontend            # 确认无误后合并"
