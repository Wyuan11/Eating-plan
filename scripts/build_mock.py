# -*- coding: utf-8 -*-
"""生成前端联调用 mock 数据（全部由实测 MCP 数据推导，数值自洽）

产出 web/mock/:
    menu.json            门店菜单（含可信热量标记）
    stores.json          门店列表
    plan.success.json    推荐成功
    plan.nosolution.json 约束无解
    plan.error.json      服务异常
    order.success.json   下单成功（支付链接）

原则：mock 里的 total_price / total_calorie / nutrition 全部由 items 反算得出，
不手写，避免前后端数值不一致。前端「独立重算校验」功能可直接拿这份数据验证。
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
MOCK = BASE / "web" / "mock"

MERCH_KEYWORDS = ("帽", "丝巾", "贴", "挠", "捶")
STORE_CODE = "1450713"
STORE_NAME = "麦当劳上海黄浦华旭国际大厦餐厅"
GEN_AT = "2026-10-24T12:50:00+08:00"


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = s.replace(" ", "")
    s = re.sub(r"[^\w\u4e00-\u9fff]", "", s)
    return s.lower()


def guess_category(name: str) -> str:
    if any(k in name for k in ("堡", "麦满分", "卷", "鸡腿", "牛堡")):
        return "主食"
    if any(k in name for k in ("薯", "鸡块", "鸡翅", "鸡排", "鸡", "派", "玉米", "苹果片", "芝士条", "薯饼")):
        if any(k in name for k in ("堡",)):
            return "主食"
        return "小食"
    if any(k in name for k in ("咖啡", "茶", "可乐", "雪碧", "橙", "牛奶", "奶", "汁", "水", "悦", "泉", "酷", "冰", "新地", "旋风")):
        return "饮品"
    if any(k in name for k in ("旋风", "圆筒", "新地", "派", "阿芙佳朵")):
        return "甜品"
    return "其他"


def guess_tags(name: str) -> list:
    tags = []
    if any(k in name for k in ("辣", "龙焰", "灰焰")):
        tags.append("辣")
    else:
        tags.append("不辣")
    if any(k in name for k in ("鸡",)):
        tags.append("鸡肉")
    if any(k in name for k in ("牛", "安格斯")):
        tags.append("牛肉")
    if any(k in name for k in ("鱼",)):
        tags.append("鱼肉")
    if any(k in name for k in ("咖啡", "奶铁", "卡布", "美式", "浓缩", "阿芙佳朵")):
        tags.append("麦咖啡")
    if any(k in name for k in ("零卡", "纯悦", "无糖")):
        tags.append("零卡")
    return tags


def main() -> int:
    nut_items = json.loads((DATA / "nutrition-cache.json").read_text(encoding="utf-8"))["items"]
    menu = json.loads((DATA / f"menu-snapshot-{STORE_CODE}.json").read_text(encoding="utf-8"))
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

    MOCK.mkdir(parents=True, exist_ok=True)

    # ---------- menu.json ----------
    menu_items = []
    for m in menu["items"]:
        code, name = m["code"], m["name"]
        if code.startswith("990"):
            kind = "combo"
        elif any(k in name for k in MERCH_KEYWORDS):
            kind = "merch"
        else:
            kind = "single"
        it, how = match(name) if kind == "single" else (None, "skip")
        menu_items.append({
            "code": code,
            "name": name,
            "price": m["price"],
            "original_price": m.get("orig", m["price"]),
            "kind": kind,
            "category": guess_category(name),
            "calorie": it["kcal"] if it else None,
            "calorie_source": "official" if it else ("unknown" if kind == "single" else "not_applicable"),
            "nutrition": ({
                "protein": it["p"], "fat": it["f"],
                "carbohydrate": it["c"], "sodium": it["na"], "calcium": it["ca"],
            } if it else None),
            "tags": guess_tags(name),
            "available": True,
        })
    menu_payload = {
        "success": True,
        "store": {"code": STORE_CODE, "name": STORE_NAME, "address": menu["address"]},
        "count": len(menu_items),
        "items": menu_items,
        "meta": {"generatedAt": GEN_AT, "source": "mcd-mcp query-meals"},
    }
    (MOCK / "menu.json").write_text(
        json.dumps(menu_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---------- stores.json ----------
    stores_payload = {
        "success": True,
        "items": [
            {"code": STORE_CODE, "name": STORE_NAME, "address": "南京东路街道西藏中路336号",
             "distance": "0.3km", "beType": 1},
            {"code": "1450801", "name": "麦当劳上海黄浦南京东路餐厅", "address": "南京东路720号",
             "distance": "0.8km", "beType": 1},
            {"code": "1450912", "name": "麦当劳上海黄浦人民广场餐厅", "address": "西藏中路268号",
             "distance": "1.2km", "beType": 1},
        ],
        "meta": {"generatedAt": GEN_AT, "source": "mcd-mcp query-nearby-stores"},
    }
    (MOCK / "stores.json").write_text(
        json.dumps(stores_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---------- plan ----------
    lookup = {i["code"]: i for i in menu_items}

    def build_plan(codes, constraints, label, suggestion, alternatives=None):
        items = []
        for c in codes:
            src = lookup[c]
            items.append({
                "code": src["code"], "name": src["name"], "price": src["price"],
                "calorie": src["calorie"], "calorie_source": src["calorie_source"],
                "category": src["category"], "quantity": 1,
                "nutrition": src["nutrition"], "tags": src["tags"],
            })
        total_price = round(sum(i["price"] * i["quantity"] for i in items), 2)
        total_cal = sum(i["calorie"] for i in items if i["calorie"] is not None)
        nut = {"protein": 0, "fat": 0, "carbohydrate": 0, "sodium": 0, "calcium": 0}
        for i in items:
            if i["nutrition"]:
                for k in nut:
                    nut[k] += i["nutrition"][k]
        budget = constraints["budget"]
        cal_limit = constraints.get("calorie_limit")
        return {
            "success": True,
            "message": "推荐完成",
            "label": label,
            "constraints": constraints,
            "plan": {
                "total_price": total_price,
                "total_calorie": total_cal,
                "original_price": round(sum(lookup[c]["original_price"] for c in codes), 2),
                "saved": round(sum(lookup[c]["original_price"] - lookup[c]["price"] for c in codes), 2),
                "budget_usage": f"{round(total_price / budget * 100)}%" if budget else "—",
                "calorie_usage": f"{round(total_cal / cal_limit * 100)}%" if cal_limit else "—",
            },
            "items": items,
            "nutrition": nut,
            "alternatives": alternatives or [],
            "suggestion": suggestion,
            "source_note": "数据来自麦当劳官方 MCP 实时菜单与营养表",
            "meta": {"storeName": STORE_NAME, "storeCode": STORE_CODE,
                     "traceId": "mock-" + label, "generatedAt": GEN_AT},
        }

    # 主方案：板烧鸡腿堡 + 麦香鸡 + 燕麦奶铁 + 纯悦
    main = build_plan(
        ["1406", "1450", "510479", "3757"],
        {"budget": 60, "calorie_limit": 1200, "people": 2, "excluded": ["辣"]},
        "success-main",
        "这套方案把预算用到了 96%，同时把热量压在你的 1200 大卡上限内（74%），两人分量也够。"
        "燕麦奶铁正在促销，四件合计省了 13.1 元。注意：菜单里的新品（龙焰系列、枫糖厚松饼堡等）"
        "官方暂未公布营养数据，我没有把它们算进热量，也没有编造——这是刻意的。",
        alternatives=[
            build_plan(["1450", "521741", "510479", "3757"],
                       {"budget": 60, "calorie_limit": 1200, "people": 2, "excluded": ["辣"]},
                       "更省钱的", "把主堡换成麦香鸡 + 脆薯饼，省下 15 元，热量也在更低区间。")["items"]
            and {
                "label": "更省钱的",
                "total_price": round(sum(lookup[c]["price"] for c in ["1450", "521741", "510479", "3757"]), 2),
                "total_calorie": sum(lookup[c]["calorie"] for c in ["1450", "521741", "510479", "3757"]),
                "items": [{"name": lookup[c]["name"], "price": lookup[c]["price"], "calorie": lookup[c]["calorie"]}
                          for c in ["1450", "521741", "510479", "3757"]],
            },
            {
                "label": "更低卡的",
                "total_price": round(sum(lookup[c]["price"] for c in ["1600", "4437", "6102", "515837", "3757"]), 2),
                "total_calorie": sum(lookup[c]["calorie"] for c in ["1600", "4437", "6102", "515837", "3757"]),
                "items": [{"name": lookup[c]["name"], "price": lookup[c]["price"], "calorie": lookup[c]["calorie"]}
                          for c in ["1600", "4437", "6102", "515837", "3757"]],
            },
        ],
    )
    (MOCK / "plan.success.json").write_text(
        json.dumps(main, ensure_ascii=False, indent=2), encoding="utf-8")

    nosol = {
        "success": False,
        "message": "约束过严，无法生成可行方案",
        "reason": "3 人用餐最少需要 3 份主食，当前门店最便宜的主食为麦香鸡 17 元，3 份已需 51 元，远超 15 元预算",
        "conflict": "预算 vs 人数",
        "hint": "把预算提高到 51 元以上，或把人数调整为 1 人（单人最低可行方案约 22.5 元）",
        "constraints": {"budget": 15, "calorie_limit": 300, "people": 3, "excluded": []},
        "source_note": "数据来自麦当劳官方 MCP 实时菜单与营养表",
        "meta": {"storeName": STORE_NAME, "storeCode": STORE_CODE,
                 "traceId": "mock-nosolution", "generatedAt": GEN_AT},
    }
    (MOCK / "plan.nosolution.json").write_text(
        json.dumps(nosol, ensure_ascii=False, indent=2), encoding="utf-8")

    err = {
        "success": False,
        "message": "上游服务暂不可用",
        "error": {"code": "MCP_UPSTREAM_ERROR", "detail": "MCP query-meals 超时（>8s）",
                  "retryable": True},
        "meta": {"storeCode": STORE_CODE, "traceId": "mock-error", "generatedAt": GEN_AT},
    }
    (MOCK / "plan.error.json").write_text(
        json.dumps(err, ensure_ascii=False, indent=2), encoding="utf-8")

    order = {
        "success": True,
        "message": "订单已创建，请在 15 分钟内完成支付",
        "order": {
            "orderId": "MOCK202610240001",
            "total_price": main["plan"]["total_price"],
            "payH5Url": "https://example.com/pay/MOCK202610240001",
            "expireAt": "2026-10-24T13:05:00+08:00",
        },
        "meta": {"storeName": STORE_NAME, "storeCode": STORE_CODE, "generatedAt": GEN_AT},
    }
    (MOCK / "order.success.json").write_text(
        json.dumps(order, ensure_ascii=False, indent=2), encoding="utf-8")

    print("menu.json            items =", len(menu_items))
    print("plan.success.json    total =", main["plan"]["total_price"], "kcal =", main["plan"]["total_calorie"])
    print("  nutrition =", main["nutrition"])
    print("  alt1 =", main["alternatives"][0]["label"], main["alternatives"][0]["total_price"], main["alternatives"][0]["total_calorie"])
    print("  alt2 =", main["alternatives"][1]["label"], main["alternatives"][1]["total_price"], main["alternatives"][1]["total_calorie"])
    print("mock ->", MOCK)
    return 0


if __name__ == "__main__":
    sys.exit(main())
