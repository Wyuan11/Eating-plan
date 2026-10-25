/**
 * 前端输入解析（mock 模式的轻量约束抽取）
 *
 * 语义理解本属于 Skill（后端），前端只"收集参数"。
 * 这里提供的是后端未接通时的保底演示：把自然语言里的数字/忌口粗略抽出来，
 * 回填到结构化表单，而不是做任何推荐决策。字段语义与后端 constraints 对齐。
 */

const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

// 品类词（饮料/甜品/小吃）与原料词共用 excluded 通道；
// 求解器侧对品类词按 category 整类过滤（见 server/solver.js CATEGORY_ALIASES）
// 温度类（冰饮/冷饮/热饮）：抽出来后交给求解器，菜单有 temperature 字段才生效，
// 否则会落进 notes 如实标注「无法参与求解」——绝不替用户猜某杯是冰的还是热的。
const EXCLUDE_WORDS = ['辣', '牛肉', '猪肉', '鸡肉', '鱼', '海鲜', '洋葱', '花生', '香菜', '饮料', '甜品', '冰淇淋', '冰饮', '冷饮', '咖啡'];

/** "减脂 / 控卡 / 低卡 / 减肥" → 默认热量上限（仅作演示预填，不做推荐） */
const CALORIE_HINTS = [
  { re: /(减脂|减肥|控卡|低卡|掉秤|瘦)/, limit: 1200 },
];

/**
 * @param {string} query 用户自然语言
 * @returns {{budget:number|null, calorie_limit:number|null, people:number|null, excluded:string[], wants:{keyword:string,qty:number}[]|undefined, objective:'cheapest'|undefined, parsed:boolean}}
 */
export function parseQuery(query = '') {
  const s = query || '';
  const out = { budget: null, calorie_limit: null, people: null, excluded: [], parsed: false };

  // 预算：优先「预算 X」/「X 元」，其次裸数字 15~200。
  // 数字后用 (?!\d) 防部分匹配：「控制在1200大卡」里的 1200 不能被截成预算 120；
  // 中文单位后不能跟 \b（CJK 字符不构成边界），「80块钱」会匹配不到。
  let m = s.match(/(?:预算|花|控制在|不超过|最多)\s*(\d{1,3})(?!\d)\s*(?:元|块|块钱)?/);
  if (!m) m = s.match(/(\d{1,3})(?!\d)\s*(?:元|块|块钱)/);
  // 口语里也会把数字放前面：「60预算」「40 块预算」
  if (!m) m = s.match(/(\d{1,3})(?!\d)\s*(?:元|块|块钱)?\s*预算/);
  if (m) {
    const n = Number(m[1]);
    if (n > 0) { out.budget = n; out.parsed = true; }
  }

  // 「不设预算 / 不限预算」→ 明确的无预算上限，与「没提预算」是两回事：
  // 没提时表单按默认 60 提交；显式声明不设时 budget=null 且 unlimited=true，
  // 表单关掉预算开关、后端不设上限。显式声明优先于前面抽到的数字。
  if (/(不设预算|不限预算|预算不限|无预算上限|不限制预算|不设限|随便花|不差钱)/.test(s)) {
    out.budget = null;
    out.budget_unlimited = true;
    out.parsed = true;
  }

  // 人数：明确「X 个 人/女生/男生…」。注意口语里数字和人称之间隔着「个」，
  // 「两个人 / 2个人 / 两个女生」都靠这条；漏了量词是历史 bug（人数永远抓不到，全靠 Skill 兜底）
  m = s.match(/([一二两三四五六七八九\d]+)\s*个?\s*(?:人|女生|男生|大人|小孩|儿童)/);
  if (m) {
    out.people = CN_NUM[m[1]] ?? Number(m[1]) ?? null;
    if (out.people) out.parsed = true;
  } else if (s.includes('一个人') || s.includes('我一个人') || s.includes('随便吃')) {
    out.people = 1; out.parsed = true;
  }

  // 显式热量数字（优先级高于减脂类词的默认值）：
  // 「热量1200cal」「1200大卡」「热量控制在1200」。
  // 必须靠「热量/卡路里」前缀或「大卡/千卡/kcal」单位区分预算数字——
  // 「预算 1200 元」绝不能被当成热量上限。
  m = s.match(/(?:热量|卡路里)\s*(?:控制在|上限|不超过|在|为|是)?\s*(\d{3,4})\s*(?:大卡|千卡|kcal|cal|卡)?/i)
    // 注意：中文单位后不能跟 \b——「大卡」的「卡」与后续标点都是非 word 字符，
    // \b 断言永远不成立，「1500大卡」会匹配不到。中文场景直接省略边界。
    || s.match(/(\d{3,4})\s*(?:大卡|千卡|kcal)/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 100 && n <= 5000) { out.calorie_limit = n; out.parsed = true; }
  }

  // 热量上限：减脂类词触发默认值
  for (const { re, limit } of CALORIE_HINTS) {
    if (re.test(s)) { out.calorie_limit = limit; out.parsed = true; break; }
  }

  // 忌口：不吃 X / 忌口 X / 别放 X
  for (const w of EXCLUDE_WORDS) {
    const re = new RegExp(`(?:不吃|忌口|不要|别放|避开|讨厌|过敏)[^，。,\\s]{0,6}?${w}|(?:${w})\\s*(?:过敏)`);
    if (re.test(s) && !out.excluded.includes(w)) {
      out.excluded.push(w);
      out.parsed = true;
    }
  }

  // 正向诉求：想吃X / 来份X / N个X —— 数量是硬约束，「一个冰淇淋」就必须是 1 个。
  // 已知不足：这是演示保底解析；真正的语义理解在 Skill（见 SKILL.md 正向诉求提取）。
  const CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  // 意图/评价词与结构词绝不是商品名（「想吃划算的」≠ 想吃一个叫"划算的"的东西），
  // 抽成 want 必然 nosolution。意图词里指向明确的映射到 objective（见下方 OBJ_HINTS）。
  const NON_PRODUCT = ['划算', '便宜', '实惠', '省钱', '优惠', '好吃', '好喝', '健康', '营养', '方便', '快', '预算', '大卡'];
  const wants = new Map();
  const addWant = (kw, qty) => {
    kw = kw.trim();
    if (!kw || kw.length > 6) return;
    if (NON_PRODUCT.some((w) => kw.includes(w))) return;
    wants.set(kw, (wants.get(kw) || 0) + qty);
  };
  // 动词式：想吃/想要/来/加/要/点 +（数量）+（量词）+ 品名。动词前不能是「不/别」，避免吃掉「不要饮料」。
  const verbRe = /(?<![不要别])(想吃|想要|来份|来个|来一|加份|加个|要份|要个|点份|点个)([一-龥0-9]{1,8})/g;
  for (const m of s.matchAll(verbRe)) {
    const rest = m[2];
    const qm = rest.match(/^([一二两三四五\d]+)?\s*(?:个|份|杯|支|盒)?\s*([一-龥]{2,6})$/);
    if (qm && qm[2]) addWant(qm[2], qm[1] ? (CN[qm[1]] ?? Number(qm[1]) ?? 1) : 1);
  }
  // 裸数量式：N个X（如「一个冰淇淋」）。跳过指人的词，避免把「两个女生」当成想吃的菜。
  const HUMAN = new Set(['人', '女生', '男生', '大人', '小孩', '儿童', '朋友', '同事', '同学']);
  for (const m of s.matchAll(/([一二两三四五\d])\s*[个杯份支盒]\s*([一-龥]{2,6})/g)) {
    const kw = m[2];
    if (HUMAN.has(kw)) continue;
    if ([...wants.keys()].some((k) => k.includes(kw) || kw.includes(k))) continue;
    addWant(kw, CN[m[1]] ?? Number(m[1]) ?? 1);
  }
  if (wants.size) {
    out.wants = [...wants].map(([keyword, qty]) => ({ keyword, qty }));
    out.parsed = true;
  }

  // 目标词 → objective：「划算/便宜/实惠/省钱」就是最省钱，映射后 wants 里绝不该再出现这些词
  if (/(划算|便宜|实惠|省钱|性价比)/.test(s)) {
    out.objective = 'cheapest';
    out.parsed = true;
  }

  return out;
}
