#!/usr/bin/env bash
# 打包当前仓库（含所有分支）为单个 .bundle 文件，发给队友即可
# 用法: scripts/bundle-out.sh
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p bundles
TS="$(date +%Y%m%d-%H%M)"
OUT="bundles/mcd-repo-${TS}.bundle"

# 三个坑，逐个避开：
# 1) 不能用 --all：会把 refs/remotes/* 一起打进去，而 git clone 只认 refs/heads/*，
#    队友 clone 后看不到 feat/xxx 协作分支。
# 2) 必须显式带上 HEAD：否则 bundle 里没有默认分支指针，
#    队友 clone 完工作区是空的（remote HEAD refers to nonexistent ref）。
# 3) 打完立刻 list-heads 自检，确认分支齐全再发出去。
git bundle create "$OUT" --branches HEAD
SIZE="$(du -h "$OUT" | cut -f1)"
echo "[OK] 已生成 $OUT ($SIZE)"
echo "=== 包内分支（请确认 feat/* 都在）==="
git bundle list-heads "$OUT"
echo "把这个文件发给队友（微信/QQ/网盘均可）"
echo "队友拿到后执行: git clone \"$OUT\" 麦门智选助手 && cd 麦门智选助手 && git checkout feat/web-frontend"
