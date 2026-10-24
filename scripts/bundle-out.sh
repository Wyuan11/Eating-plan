#!/usr/bin/env bash
# 打包当前仓库（含所有分支）为单个 .bundle 文件，发给队友即可
# 用法: scripts/bundle-out.sh
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p bundles
TS="$(date +%Y%m%d-%H%M)"
OUT="bundles/mcd-repo-${TS}.bundle"

git bundle create "$OUT" --all
SIZE="$(du -h "$OUT" | cut -f1)"
echo "[OK] 已生成 $OUT ($SIZE)"
echo "把这个文件发给队友（微信/QQ/网盘均可）"
echo "队友拿到后执行: git clone \"$OUT\" 麦门智选助手"
