'use strict';
/**
 * 优惠券：解析 → 时效判定 → 与菜单匹配 → 券后价。
 *
 * 设计红线（与「绝不编造热量」同级）：
 *   1. 券的抵扣额只能来自接口返回的真实「用券价格」，绝不推算面额。
 *   2. 只有券能【唯一、确定】地匹配到菜单里某个在售单品时才生效；
 *      命中 0 件 / 命中多件 / 命中套餐，一律不生效，并给出真实原因。
 *   3. 券后价 ≥ 门店促销价时不生效——用券反而更贵，不能为了好看硬算省钱。
 *   4. 券接口不返回 couponId/couponCode（只有 query-store-coupons 返回，而该店为空），
 *      所以下单核价无法把券传给 calculate-price；券最多影响「预算内的组合选择」，
 *      实付金额一律以 MCP 实时核价为准，这里不做任何承诺。
 *
 * 金额单位：分。
 */

/** 券名里的营销前缀，匹配商品前必须剥掉 */
const TITLE_PREFIX_RE = /^(新人专享|会员专享|新客专享|专享|限时|特惠)[-—－:：\s]*/;
/** 券名里的价格前缀：11.9元麦辣鸡腿堡 → 麦辣鸡腿堡 */
const PRICE_PREFIX_RE = /^\d+(?:\.\d+)?\s*元\s*/;
/** 折扣后缀：中杯美式7折 → 中杯美式 */
const DISCOUNT_SUFFIX_RE = /\d+(?:\.\d+)?\s*折\s*$/;
/** 组合券特征：任选2 / 三件套 / 双人餐 —— 需要多件组合匹配，本版不支持自动生效 */
const BUNDLE_RE = /(任选\s*\d+|\d+\s*件套|[一二三四五六七八九十]\s*件套|套餐|双人餐|全家桶)/;

const WEEKDAY_MAP = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };

/** 归一：全角转半角、去空格与 ™® 等符号，用于名称匹配 */
function normName(s) {
  return String(s ?? '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s™®©（）()·・、,，.。\-—_/]/g, '')
    .toLowerCase();
}

/**
 * 解析 query-my-coupons 的 markdown 返回。
 * 真实样例：
 *   ## 11.9元麦辣鸡腿堡
 *   - **优惠**: ¥11.9 (用券价格)
 *   - **有效期**: 2026-10-26 10:30-2026-10-30 23:59 周一、二、三、四、五 10:30-23:59
 *   - **标签**: 到店专用、外送专用
 */
function parseMyCoupons(text) {
  const s = String(text ?? '');
  const out = [];
  const blocks = s.split(/^##\s+/m).slice(1);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    const title = (lines[0] || '').replace(/\s+$/, '');
    if (!title || /^Response Structure/i.test(title)) continue;

    const priceM = b.match(/\*\*优惠\*\*\s*[:：]\s*¥\s*([\d.]+)/);
    const validM = b.match(/\*\*有效期\*\*\s*[:：]\s*(.+)/);
    const tagM = b.match(/\*\*标签\*\*\s*[:：]\s*(.+)/);

    const coupon = {
      title,
      priceAfterFen: priceM ? Math.round(Number(priceM[1]) * 100) : null,
      channels: tagM ? tagM[1].split(/[、,，]/).map((t) => t.trim()).filter(Boolean) : [],
      validFrom: null,
      validTo: null,
      weekdays: [],
      dailyWindow: null, // [startMin, endMin]，每日可用时段（分钟）
      raw: { validity: validM ? validM[1].trim() : null, tags: tagM ? tagM[1].trim() : null },
    };

    if (coupon.raw.validity) parseValidity(coupon, coupon.raw.validity);
    out.push(coupon);
  }
  return out;
}

/** 从有效期字符串里抽日期区间 / 星期 / 每日时段 */
function parseValidity(coupon, v) {
  const rangeM = v.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (rangeM) {
    coupon.validFrom = `${rangeM[1]}T${rangeM[2]}`;
    coupon.validTo = `${rangeM[3]}T${rangeM[4]}`;
  }
  // 星期：支持「周一、二、三、四、五」这种只在开头写一个「周」的缩写写法
  const wdM = v.match(/周([一二三四五六日天](?:\s*[、,，]\s*[一二三四五六日天])*)/);
  if (wdM) {
    coupon.weekdays = [...new Set(
      wdM[1].split(/[、,，]/).map((t) => WEEKDAY_MAP[t.trim()]).filter((n) => Number.isInteger(n))
    )].sort((a, b) => a - b);
  }
  // 每日时段：剥掉日期区间与星期后剩下的 HH:MM-HH:MM
  const rest = v
    .replace(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/, '')
    .replace(/周[一二三四五六日天](?:\s*[、,，]\s*[一二三四五六日天])*/g, '')
    .replace(/[、,，]/g, ' ');
  const winM = rest.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (winM) coupon.dailyWindow = [Number(winM[1]) * 60 + Number(winM[2]), Number(winM[3]) * 60 + Number(winM[4])];
}

/** 券名 → 商品关键词 + 是否组合券 */
function couponKeyword(title) {
  let k = String(title ?? '').trim();
  k = k.replace(TITLE_PREFIX_RE, '').replace(PRICE_PREFIX_RE, '').replace(DISCOUNT_SUFFIX_RE, '');
  const isBundle = BUNDLE_RE.test(k);
  return { keyword: k.trim(), isBundle };
}

/**
 * 时效 + 渠道判定。channel: '到店' | '外送'
 * 返回 { ok, reason } —— 不 ok 时 reason 是给用户看的真实原因。
 */
function usableNow(coupon, now = new Date(), channel = '到店') {
  if (coupon.channels.length) {
    const hit = coupon.channels.some((t) => t.includes(channel));
    if (!hit) return { ok: false, reason: `该券仅限${coupon.channels.join('、')}，不适用于${channel}` };
  }
  if (!coupon.validFrom || !coupon.validTo) return { ok: false, reason: '券未返回可解析的有效期，不敢假定可用' };
  if (coupon.priceAfterFen == null) return { ok: false, reason: '券未返回用券价格，无法计算券后价' };

  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const cur = `${ymd(now)}T${hm(now)}`;
  if (cur < coupon.validFrom) return { ok: false, reason: `券 ${coupon.validFrom.replace('T', ' ')} 起生效，当前未到可用时间` };
  if (cur > coupon.validTo) return { ok: false, reason: `券已于 ${coupon.validTo.replace('T', ' ')} 过期` };

  const wd = now.getDay() === 0 ? 7 : now.getDay();
  if (coupon.weekdays.length && !coupon.weekdays.includes(wd)) {
    return { ok: false, reason: `券仅在周${coupon.weekdays.join('、')}可用` };
  }
  if (coupon.dailyWindow) {
    const min = now.getHours() * 60 + now.getMinutes();
    const [a, b] = coupon.dailyWindow;
    if (min < a || min > b) {
      const f = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return { ok: false, reason: `券每日 ${f(a)}-${f(b)} 可用，当前不在时段内` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * 把券匹配到菜单商品。
 * @param {Array} items 菜单项（建议传求解用的可信单品池）
 * @returns { keyword, isBundle, status, reason, matches:[{code,name,price}], appliedTo }
 *  status: 'applied' | 'no_match' | 'ambiguous' | 'not_cheaper' | 'unsupported' | 'not_now'
 */
function matchCoupon(coupon, items, opts = {}) {
  const now = opts.now ?? new Date();
  const channel = opts.channel ?? '到店';
  const { keyword, isBundle } = couponKeyword(coupon.title);
  const base = { title: coupon.title, keyword, isBundle, priceAfterFen: coupon.priceAfterFen, validFrom: coupon.validFrom, validTo: coupon.validTo, channels: coupon.channels };

  const time = usableNow(coupon, now, channel);
  if (!time.ok) return { ...base, status: 'not_now', reason: time.reason, matches: [], appliedTo: null };
  if (isBundle) return { ...base, status: 'unsupported', reason: `「${keyword}」是组合券（需多件搭配），本版只支持单品一口价券，未纳入自动计算`, matches: [], appliedTo: null };
  if (!keyword) return { ...base, status: 'unsupported', reason: '券名解析不出商品关键词，未纳入自动计算', matches: [], appliedTo: null };

  const k = normName(keyword);
  const matches = items.filter((i) => normName(i.name).includes(k));
  if (matches.length === 0) return { ...base, status: 'no_match', reason: `本店菜单里没有「${keyword}」，券无法用于当前门店`, matches: [], appliedTo: null };
  if (matches.length > 1) {
    return { ...base, status: 'ambiguous', reason: `菜单里有 ${matches.length} 件商品都含「${keyword}」（${matches.map((m) => m.name).join('、')}），无法确定券适用于哪一件，宁可不用`, matches: matches.map((m) => ({ code: m.code, name: m.name, price: m.price })), appliedTo: null };
  }
  const item = matches[0];
  const beforeFen = Math.round(Number(item.price) * 100);
  if (!(coupon.priceAfterFen < beforeFen)) {
    return { ...base, status: 'not_cheaper', reason: `券后价 ¥${(coupon.priceAfterFen / 100).toFixed(2)} 不低于该商品当前促销价 ¥${item.price}，用券不会更便宜`, matches: [{ code: item.code, name: item.name, price: item.price }], appliedTo: null };
  }
  return { ...base, status: 'applied', reason: null, matches: [{ code: item.code, name: item.name, price: item.price }], appliedTo: { code: item.code, name: item.name, beforeFen, afterFen: coupon.priceAfterFen, savedFen: beforeFen - coupon.priceAfterFen } };
}

/**
 * 把可生效的券套到商品池上：命中商品生成价格替换后的副本。
 * 副本携带 coupon 字段，summarize 会据此累计 coupon_saved。
 * @returns { pool, applied, skipped }
 */
function applyCoupons(pool, coupons, opts = {}) {
  const list = Array.isArray(coupons) ? coupons : [];
  if (!list.length) return { pool, applied: [], skipped: [] };

  const applied = [], skipped = [];
  const covered = new Set(); // 一件商品只吃一张券，避免重复抵扣
  const next = pool.slice();
  for (const c of list) {
    const m = matchCoupon(c, pool, opts);
    if (m.status !== 'applied') { skipped.push(m); continue; }
    if (covered.has(m.appliedTo.code)) {
      skipped.push({ ...m, status: 'ambiguous', reason: '该商品已被另一张券覆盖，避免重复抵扣', appliedTo: null });
      continue;
    }
    covered.add(m.appliedTo.code);
    const idx = next.findIndex((i) => i.code === m.appliedTo.code);
    if (idx >= 0) {
      next[idx] = {
        ...next[idx],
        price: m.appliedTo.afterFen / 100,
        coupon: { title: c.title, before_price: m.appliedTo.beforeFen / 100, after_price: m.appliedTo.afterFen / 100, saved: m.appliedTo.savedFen / 100 },
      };
    }
    applied.push(m);
  }
  return { pool: next, applied, skipped };
}

/**
 * 外部传入的券（HTTP 请求体）必须过白名单：求解器信它算钱，不能让调用方塞任意字段。
 * @returns {{value: Array}|{error: string}}
 */
function sanitizeCoupons(input) {
  if (!Array.isArray(input)) return { error: 'coupons 必须为数组' };
  const out = [];
  for (const c of input) {
    if (!c || typeof c !== 'object') return { error: 'coupons[] 必须为对象' };
    const title = typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 60) : null;
    if (!title) return { error: 'coupons[].title 必须为非空字符串' };
    const priceAfterFen = Number(c.priceAfterFen);
    if (!Number.isFinite(priceAfterFen) || priceAfterFen <= 0 || priceAfterFen > 100000) return { error: `coupons[].priceAfterFen 非法（1~100000 分）：${title}` };
    out.push({
      title,
      priceAfterFen: Math.round(priceAfterFen),
      channels: Array.isArray(c.channels) ? c.channels.filter((t) => typeof t === 'string').slice(0, 5) : [],
      validFrom: typeof c.validFrom === 'string' ? c.validFrom.slice(0, 19) : null,
      validTo: typeof c.validTo === 'string' ? c.validTo.slice(0, 19) : null,
      weekdays: Array.isArray(c.weekdays) ? c.weekdays.filter((n) => Number.isInteger(n) && n >= 1 && n <= 7).slice(0, 7) : [],
      dailyWindow: Array.isArray(c.dailyWindow) && c.dailyWindow.length === 2 && c.dailyWindow.every((n) => Number.isFinite(n)) ? c.dailyWindow.map(Number) : null,
    });
  }
  return { value: out };
}

/**
 * 拉真实券（query-my-coupons）。只读，不领券、不消耗券。
 * @returns {{ok:true, coupons:Array}|{ok:false, code:string, error:string}}
 */
async function fetchMyCoupons() {
  require('./token').ensureToken();
  if (!process.env.MCD_MCP_TOKEN) return { ok: false, code: 'MCP_UNAVAILABLE', error: '未配置 MCD_MCP_TOKEN，无法读取真实优惠券' };
  const { callTool } = require('./mcp-client'); // 必须在 ensureToken 之后
  try {
    // 该工具参数是 string 类型，分页上限 200
    const text = await callTool('query-my-coupons', { page: '1', pageSize: '200' });
    return { ok: true, coupons: parseMyCoupons(text) };
  } catch (e) {
    return { ok: false, code: 'MCP_TOOL_ERROR', error: e?.message || String(e) };
  }
}

module.exports = { parseMyCoupons, parseValidity, usableNow, couponKeyword, matchCoupon, applyCoupons, normName, sanitizeCoupons, fetchMyCoupons, BUNDLE_RE };
