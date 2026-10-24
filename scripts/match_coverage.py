# -*- coding: utf-8 -*-
"""菜单品名 ↔ 官方营养表 匹配覆盖率测试

用途：验证「控卡」场景是否成立。这是项目 P0 技术风险。
跑法：
    python scripts/match_coverage.py
产出：
    docs/match-coverage-report.md
"""
import difflib
import json
import re
import sys
import unicodedata
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"
DOCS = BASE / "docs"

MERCH_KEYWORDS = ("帽", "丝巾", "贴", "挠", "捶")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace(" ", "")
    s = re.sub(r"[^\w\u4e00-\u9fff]", "", s)
    return s.lower()


def main() -> int:
    nut_items = json.loads((DATA / "nutrition-cache.json").read_text(encoding="utf-8"))["items"]
    menu = json.loads((DATA / "menu-snapshot-1450713.json").read_text(encoding="utf-8"))
    cfg = json.loads((DATA / "alias-map.json").read_text(encoding="utf-8"))
    alias = cfg["map"]
    blocklist = set(cfg.get("blocklist", []))

    idx = {}
    for it in nut_items:
        idx.setdefault(norm(it["n"]), it)

    def match(name: str):
        if name in blocklist:
            return None, "blocked"
        if name in alias:
            k = norm(alias[name])
            if k in idx:
                return idx[k], "alias"
        n = norm(name)
        if n in idx:
            return idx[n], "exact"
        best = None
        for k, v in idx.items():
            if len(n) < 2 or len(k) < 2:
                continue
            if k in n or n in k:
                r = min(len(n), len(k)) / max(len(n), len(k))
                if r >= 0.5 and (best is None or r > best[0]):
                    best = (r, v)
        if best:
            return best[1], "substr"
        close = difflib.get_close_matches(n, list(idx.keys()), n=1, cutoff=0.8)
        if close:
            return idx[close[0]], "fuzzy"
        return None, "miss"

    rows = []
    for m in menu["items"]:
        code, name = m["code"], m["name"]
        if code.startswith("990"):
            kind = "combo"
        elif any(k in name for k in MERCH_KEYWORDS):
            kind = "merch"
        else:
            kind = "single"
        it, how = match(name) if kind == "single" else (None, "skip")
        rows.append({
            "code": code,
            "name": name,
            "price": m["price"],
            "kind": kind,
            "how": how,
            "kcal": it["kcal"] if it else None,
            "matched": it["n"] if it else None,
        })

    singles = [r for r in rows if r["kind"] == "single"]
    combos = [r for r in rows if r["kind"] == "combo"]
    merchs = [r for r in rows if r["kind"] == "merch"]
    hits = [r for r in singles if r["kcal"] is not None]
    rate = (len(hits) / len(singles) * 100) if singles else 0.0

    L = []
    A = L.append
    A("# 菜单 ↔ 营养表 匹配覆盖率报告")
    A("")
    A(f"- 门店：`{menu['storeCode']}` {menu['storeName']}")
    A(f"- 菜单快照：{menu['fetchedAt']}")
    A(f"- 营养表：{len(nut_items)} 条（官方 list-nutrition-foods，已去重）")
    A("")
    A("## 一、总览")
    A("")
    A("| 分类 | 数量 | 说明 |")
    A("|---|---|---|")
    A(f"| 菜单总品数 | {len(rows)} | |")
    A(f"| 单品（匹配对象） | {len(singles)} | 营养表的覆盖目标 |")
    A(f"| 套餐（990 开头） | {len(combos)} | 营养表无，需 query-meal-detail 拆解 |")
    A(f"| 周边 / 非食物 | {len(merchs)} | 无营养数据，属正常 |")
    A("")
    A(f"## 二、单品命中率：**{rate:.1f}%**（{len(hits)}/{len(singles)}）")
    A("")
    A("| 匹配方式 | 数量 | 说明 |")
    A("|---|---|---|")
    meta = [
        ("exact", "精确匹配", "归一化后完全一致"),
        ("alias", "别名表命中", "人工维护的规格映射"),
        ("substr", "子串包含", "长度比 ≥0.5 的包含关系"),
        ("fuzzy", "模糊匹配", "相似度 ≥0.8"),
        ("blocked", "歧义主动放弃", "宁可 unknown 也不猜"),
        ("miss", "未命中", "需人工补别名"),
    ]
    for how, label, desc in meta:
        A(f"| {label} | {sum(1 for r in singles if r['how'] == how)} | {desc} |")
    A("")
    A("## 三、未命中单品（需人工补别名或标记 unknown）")
    A("")
    A("| 菜单名 | 编码 | 价格 | 最接近的营养表品名 | 相似度 |")
    A("|---|---|---|---|---|")
    for r in singles:
        if r["kcal"] is None:
            n = norm(r["name"])
            close = difflib.get_close_matches(n, list(idx.keys()), n=1, cutoff=0.4)
            if close:
                sugg = idx[close[0]]["n"]
                ratio = f"{difflib.SequenceMatcher(None, n, close[0]).ratio():.2f}"
            else:
                sugg, ratio = "-", "-"
            A(f"| {r['name']} | `{r['code']}` | {r['price']} | {sugg} | {ratio} |")
    A("")
    A("## 四、命中明细")
    A("")
    A("| 菜单名 | 编码 | 价格 | 命中营养表品名 | 方式 | 热量(kcal) |")
    A("|---|---|---|---|---|---|")
    for r in sorted(hits, key=lambda x: x["how"]):
        A(f"| {r['name']} | `{r['code']}` | {r['price']} | {r['matched']} | {r['how']} | {r['kcal']} |")

    DOCS.mkdir(exist_ok=True)
    out = DOCS / "match-coverage-report.md"
    out.write_text("\n".join(L), encoding="utf-8")

    print(f"单品命中率: {rate:.1f}%  ({len(hits)}/{len(singles)})")
    for how, label, _ in meta:
        print(f"  {label:12s} {sum(1 for r in singles if r['how'] == how)}")
    print(f"套餐(需拆解): {len(combos)}    周边: {len(merchs)}")
    print(f"报告 -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
