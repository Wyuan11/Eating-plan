/**
 * 前端输入解析（mock 模式的轻量约束抽取）
 *
 * 语义理解本属于 Skill（后端），前端只"收集参数"。
 * 这里提供的是后端未接通时的保底演示：把自然语言里的数字/忌口粗略抽出来，
 * 回填到结构化表单，而不是做任何推荐决策。字段语义与后端 constraints 对齐。
 */

const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

const EXCLUDE_WORDS = ['辣', '牛肉', '猪肉', '鸡肉', '鱼', '海鲜', '洋葱', '花生', '香菜'];

/** "减脂 / 控卡 / 低卡 / 减肥" → 默认热量上限（仅作演示预填，不做推荐） */
const CALORIE_HINTS = [
  { re: /(减脂|减肥|控卡|低卡|掉秤|瘦)/, limit: 1200 },
];

/**
 * @param {string} query 用户自然语言
 * @returns {{budget:number|null, calorie_limit:number|null, people:number|null, excluded:string[], parsed:boolean}}
 */
export function parseQuery(query = '') {
  const s = query || '';
  const out = { budget: null, calorie_limit: null, people: null, excluded: [], parsed: false };

  // 预算：优先「预算 X」/「预算：X」/「X 元」，其次裸数字 15~200
  // 注意 (\d{1,3})(?!\d)：防止「不超过 1500 大卡」被截断成预算 150
  let m = s.match(/(?:预算|花|控制在|不超过|最多)\s*[：:]?\s*(\d{1,3})(?!\d)\s*(?:元|块|块钱)?/);
  if (!m) m = s.match(/(\d{1,3})(?!\d)\s*(?:元|块|块钱)/);
  if (m) {
    const n = Number(m[1]);
    if (n > 0) { out.budget = n; out.parsed = true; }
  }

  // 人数：明确「X 人」/「人数 X」/「三个人」，或「两个女生/三位男生」
  m = s.match(/(?:人数\s*[：:]?\s*)?([一二两三四五六七八九\d]+)\s*(?:个|位)?\s*人/);
  if (!m) m = s.match(/([一二两三四五六七八九\d]+)\s*(?:个|位)\s*(?:女生|男生|女孩|男孩|小姐姐|小哥哥)/);
  if (m) {
    out.people = CN_NUM[m[1]] ?? Number(m[1]) ?? null;
    if (out.people) out.parsed = true;
  } else if (s.includes('一个人') || s.includes('我一个人') || s.includes('随便吃')) {
    out.people = 1; out.parsed = true;
  }

  // 热量上限：显式写法优先（「热量上限：2000」「不超过 1200 大卡」「热量 1000 kcal」）
  m = s.match(/(?:热量上限|热量|卡路里)\s*[：:]?\s*(?:不超过|控制在|低于|最多)?\s*(\d{3,5})\s*(?:大卡|千卡|kcal)?/i)
    || s.match(/(\d{3,5})\s*(?:大卡|千卡|kcal)/i);
  if (m) {
    out.calorie_limit = Number(m[1]);
    out.parsed = true;
  }

  // 热量上限：减脂类词触发默认值（仅作演示预填，不做推荐）
  if (out.calorie_limit == null) {
    for (const { re, limit } of CALORIE_HINTS) {
      if (re.test(s)) { out.calorie_limit = limit; out.parsed = true; break; }
    }
  }

  // 忌口：不吃 X / 忌口 X / 别放 X
  for (const w of EXCLUDE_WORDS) {
    const re = new RegExp(`(?:不吃|忌口|不要|别放|避开|讨厌|过敏)[^，。,\\s]{0,6}?${w}|(?:${w})\\s*(?:过敏)`);
    if (re.test(s) && !out.excluded.includes(w)) {
      out.excluded.push(w);
      out.parsed = true;
    }
  }

  return out;
}
