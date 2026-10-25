<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { EXCLUDE_OPTIONS, QUICK_PRESETS } from '../lib/schema.js'
import { parseQuery } from '../lib/parseQuery.js'

const props = defineProps({
  stores: { type: Array, default: () => [] },
  storesMock: { type: Boolean, default: false },
  city: { type: String, default: '上海' },
  keyword: { type: String, default: '' },
  storesSource: { type: String, default: 'snapshot' }, // 'live' | 'snapshot' | 'mock'
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['submit', 'store-search'])

const query = ref('')
// 正向诉求（想吃 X × N）：从自然语言抽出，可手动删除；数量会作为硬约束传给求解器
const wants = ref([])
const form = reactive({
  budget: 60,
  // 不设预算开关：用户说「不设预算/不限预算」时关掉，求解只受热量/忌口/人数约束。
  // 与「没提预算」不同——没提时保持默认 60，显式说「不设」才关掉。
  useBudget: true,
  people: 2,
  // 红线：用户没提热量就不设上限。此前默认 true + 1200，会导致
  // "两个人预算60" 这种没提热量的请求被强加一个 1200 大卡硬约束，
  // 答辩被问"1200 哪来的"答不上来。现在只有用户勾选或话语里出现
  // 减脂/低卡等词时才带上热量上限。
  useCalorie: false,
  calorie_limit: 1200,
  excluded: [],
})
const storeCode = ref('')

// 门店定位（本地输入态，点「搜索/定位」后上抛给父组件重拉门店）
const cityInput = ref(props.city)
const keywordInput = ref(props.keyword)
const locating = ref(false)
const locateError = ref('')

const storeHint = computed(() => {
  const src = props.storesMock ? '门店为演示数据' : '门店来自麦当劳官方门店数据'
  return `${src}；距离为距搜索位置中心估算`
})

watch(
  () => props.stores,
  (list) => {
    if (!list?.length) { storeCode.value = ''; return }
    // 城市切换后旧 storeCode 可能已不在新列表，重置到第一家
    if (!list.some((s) => s.code === storeCode.value)) storeCode.value = list[0].code
  },
  { immediate: true }
)

function searchStores() {
  emit('store-search', { city: cityInput.value.trim(), keyword: keywordInput.value.trim() })
}

// 从 display_name（如「…, 鹿城区, 温州市, 浙江省, …」）里提取「X市」这一级。
// 中国地址里 Nominatim 常把「区」放进 address.city（如 鹿城区），真正的市只出现在 display_name，
// 导致定位后拿到「鹿城区」而非「温州」，门店快照按城市名匹配就落空了。
function cityFromDisplayName(displayName) {
  if (!displayName) return ''
  const segs = String(displayName).split(',').map((s) => s.trim())
  for (const seg of segs) {
    if (/市$/.test(seg) && !/省$/.test(seg)) return seg
  }
  return ''
}

async function reverseGeocode(lat, lon) {
  const urls = [
    `https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}&lang=zh`,
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=zh`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const j = await res.json()
      const p = j.features?.[0]?.properties || j.address || null
      if (!p) continue
      const city = cityFromDisplayName(j.display_name) || p.city || p.town || p.county || p.state || p.province
      if (!city) continue
      // 更精确：优先取城区/街道级定位作为搜索关键词，让「附近」尽量贴近用户
      const keyword = (p.district || p.suburb || p.neighbourhood || p.name || '').replace(/市$/, '')
      return { city: String(city).replace(/市$/, ''), keyword: String(keyword || '').trim() }
    } catch { /* 尝试下一个源 */ }
  }
  return null
}

async function locate() {
  locateError.value = ''
  if (!('geolocation' in navigator)) {
    locateError.value = '当前浏览器不支持定位，请手动输入城市'
    return
  }
  locating.value = true
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000, maximumAge: 300000 })
    })
    const { latitude, longitude } = pos.coords
    const loc = await reverseGeocode(latitude, longitude)
    if (loc) {
      cityInput.value = loc.city
      if (loc.keyword) keywordInput.value = loc.keyword
      searchStores()
    } else {
      locateError.value = '已定位但未能识别城市，请手动输入'
    }
  } catch (e) {
    locateError.value = e?.code === 1 ? '定位被拒绝，请手动输入城市' : '定位失败，请手动输入城市'
  } finally {
    locating.value = false
  }
}

const parsePreview = computed(() => {
  if (!query.value.trim()) return null
  return parseQuery(query.value)
})

function removeWant(i) {
  wants.value.splice(i, 1)
}

function toggleExclude(w) {
  const i = form.excluded.indexOf(w)
  if (i >= 0) form.excluded.splice(i, 1)
  else form.excluded.push(w)
}

// 快捷示例：点击即回填整句与结构化表单（演示时不用手打）
function applyPreset(p) {
  query.value = p.query
  form.budget = p.constraints.budget
  form.people = p.constraints.people
  form.useCalorie = p.constraints.calorie_limit != null
  form.calorie_limit = p.constraints.calorie_limit ?? 1200
  form.excluded = [...(p.constraints.excluded || [])]
}

// 自然语言 → 结构化表单实时回填（输入即同步，表单是提交时的唯一权威来源）。
// 这样手动划预算/改人数不会被文本里的旧数字覆盖（此前是提交时再 parse 文本去覆盖，导致滑块值「没保存」）。
watch(query, (q) => {
  // 清空输入时诉求 chips 也要一起消失，否则会残留上一次的诉求并提交给求解器
  if (!q || !q.trim()) { wants.value = []; return }
  const p = parseQuery(q)
  wants.value = p?.wants || []
  // 「不设预算」→ 关掉预算开关；抽到具体预算数字 → 重新打开并回填
  if (p.budget_unlimited) form.useBudget = false
  if (p.budget != null) { form.budget = p.budget; form.useBudget = true }
  if (p.people != null) form.people = p.people
  if (p.calorie_limit != null) { form.useCalorie = true; form.calorie_limit = p.calorie_limit }
  if (p.excluded.length) form.excluded = [...new Set([...form.excluded, ...p.excluded])]
})

function buildConstraints() {
  return {
    // 关掉预算开关 = 用户明确不设预算上限（null），不是"忘了填"
    budget: form.useBudget ? Number(form.budget) || 60 : null,
    people: Number(form.people) || 1,
    calorie_limit: form.useCalorie ? Number(form.calorie_limit) || null : null,
    excluded: [...form.excluded],
    // 正向诉求：表单里没有对应控件，来源是自然语言解析出的 chips（可手动删除）
    wants: wants.value.map((w) => ({ ...w })),
  }
}

function submit() {
  const p = query.value.trim() ? parseQuery(query.value) : null
  emit('submit', {
    storeCode: storeCode.value,
    query: query.value.trim() || undefined,
    constraints: buildConstraints(),
    // 目标词（划算/省钱等）→ 最省钱：与 constraints 平级，后端 /api/plan 顶层字段
    objective: p?.objective || undefined,
  })
}
</script>

<template>
  <div class="form">
    <!-- 自然语言输入（可选） -->
    <section class="form__block">
      <label class="form__label" for="nl">用一句话点单 <span class="form__hint">可选 · AI 语义解析</span></label>
      <textarea
        id="nl"
        v-model="query"
        rows="2"
        placeholder="例如：两个女生，预算 60，在减脂，不吃辣，想低卡又划算"
      ></textarea>
      <p v-if="parsePreview && parsePreview.parsed" class="form__preview">
        已识别：<template v-if="parsePreview.budget_unlimited">不设预算上限 · </template
        ><template v-else-if="parsePreview.budget">预算 ¥{{ parsePreview.budget }} · </template
        ><template v-if="parsePreview.people">{{ parsePreview.people }} 人 · </template
        ><template v-if="parsePreview.calorie_limit">热量上限 {{ parsePreview.calorie_limit }} 大卡 · </template
        ><template v-if="parsePreview.excluded.length">忌口 {{ parsePreview.excluded.join('、') }}</template
        ><template v-if="parsePreview.wants && parsePreview.wants.length"> · 想吃 {{ parsePreview.wants.map((w) => w.keyword + '×' + w.qty).join('、') }}</template>
      </p>
    </section>

    <!-- 快捷示例（点击即回填，演示用） -->
    <section class="form__presets">
      <button v-for="p in QUICK_PRESETS" :key="p.label" class="preset" type="button" @click="applyPreset(p)">
        {{ p.label }}
      </button>
    </section>

    <!-- 结构化约束 -->
    <section class="form__block">
      <div class="form__calorie">
        <label class="form__label" for="budget">预算（元）</label>
        <label class="switch" title="关闭 = 不设预算上限">
          <input id="useBudget" v-model="form.useBudget" type="checkbox" />
          <span class="switch__track"></span>
        </label>
      </div>
      <div v-if="form.useBudget" class="form__slider">
        <input id="budget" v-model.number="form.budget" type="range" min="10" max="200" step="5" />
        <input v-model.number="form.budget" type="number" class="form__num" min="10" max="500" />
      </div>
      <p v-else class="form__hint">不设预算上限：方案只受热量 / 忌口 / 人数约束</p>
    </section>

    <section class="form__block">
      <span class="form__label">用餐人数</span>
      <div class="form__seg">
        <button
          v-for="n in 5" :key="n" type="button" class="seg"
          :class="{ active: form.people === n }" @click="form.people = n"
        >{{ n }} 人</button>
      </div>
    </section>

    <section class="form__block">
      <div class="form__calorie">
        <label class="form__label" for="useCalorie">热量上限（大卡）</label>
        <label class="switch">
          <input id="useCalorie" v-model="form.useCalorie" type="checkbox" />
          <span class="switch__track"></span>
        </label>
      </div>
      <input
        v-if="form.useCalorie"
        v-model.number="form.calorie_limit"
        type="number" class="form__num form__num--full"
        min="200" max="3000" step="50" placeholder="如 1200"
      />
    </section>

    <!-- 正向诉求：数量是硬约束，可手动删除 -->
    <section v-if="wants.length" class="form__block">
      <span class="form__label">想吃（数量按需求严格执行）</span>
      <div class="form__chips">
        <button
          v-for="(w, i) in wants"
          :key="w.keyword"
          class="chip chip--want"
          type="button"
          :title="'点击移除该诉求'"
          @click="removeWant(i)"
        >
          🍽️ {{ w.keyword }} ×{{ w.qty }} ✕
        </button>
      </div>
    </section>

    <section class="form__block">
      <span class="form__label">忌口（可多选）</span>
      <div class="form__chips">
        <button
          v-for="w in EXCLUDE_OPTIONS" :key="w" type="button" class="chip"
          :class="{ active: form.excluded.includes(w) }" @click="toggleExclude(w)"
        >{{ w }}</button>
      </div>
    </section>

    <!-- 附近门店定位 -->
    <section class="form__block">
      <label class="form__label">附近门店</label>
      <div class="store-locate">
        <input v-model="cityInput" class="form__input" placeholder="城市，如：上海" @keyup.enter="searchStores" />
        <input v-model="keywordInput" class="form__input" placeholder="关键词（可选），如：人民广场" @keyup.enter="searchStores" />
      </div>
      <div class="store-locate__actions">
        <button type="button" class="btn-locate" :disabled="locating" @click="locate">
          {{ locating ? '定位中…' : '📍 定位' }}
        </button>
        <button type="button" class="btn-search" @click="searchStores">搜索门店</button>
      </div>
      <p v-if="locateError" class="form__hint form__hint--error">{{ locateError }}</p>
      <p class="form__hint">{{ storeHint }}</p>
    </section>

    <!-- 门店 -->
    <section class="form__block">
      <label class="form__label" for="store">选择门店</label>
      <select id="store" v-model="storeCode" class="form__select">
        <option v-for="s in stores" :key="s.code" :value="s.code">
          {{ s.name }}{{ s.distance ? ' · 距搜索点 ' + s.distance : '' }}
        </option>
      </select>
    </section>

    <button class="form__submit" type="button" :disabled="loading" @click="submit">
      <span v-if="loading" class="form__submit-spinner"></span>
      <span>{{ loading ? '求解中…' : '生成方案' }}</span>
    </button>
  </div>
</template>

<style scoped>
.form { display: flex; flex-direction: column; gap: 18px; }
.form__block { display: flex; flex-direction: column; gap: 10px; }
.form__label { font-size: 13px; font-weight: 600; color: var(--ink-primary); }
.form__hint { font-weight: 400; color: var(--ink-muted); font-size: 12px; }

textarea {
  width: 100%; box-sizing: border-box; resize: vertical; min-height: 52px;
  border: 1px solid var(--border); border-radius: 12px; padding: 10px 12px;
  font: inherit; font-size: 14px; color: var(--ink-primary); background: var(--card);
  transition: border-color .15s, box-shadow .15s;
}
textarea:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }

.form__preview { margin: 0; font-size: 12.5px; color: var(--categorical-3, #1baf7a); font-weight: 600; }

.form__presets { display: flex; flex-wrap: wrap; gap: 6px; }
.preset {
  font-size: 12px; padding: 6px 10px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border); background: var(--wash); color: var(--ink-secondary);
  transition: all .15s; font: inherit;
}
.preset:hover { border-color: var(--brand-soft); color: var(--brand); background: #fff5f3; }

.form__slider { display: flex; align-items: center; gap: 12px; }
input[type="range"] { flex: 1; accent-color: var(--brand); }

.form__num {
  width: 72px; box-sizing: border-box; border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 10px; font: inherit; font-size: 14px; color: var(--ink-primary); background: var(--card);
}
.form__num:focus { outline: none; border-color: var(--brand); }
.form__num--full { width: 100%; }

.form__seg { display: flex; gap: 6px; }
.seg {
  flex: 1; padding: 8px 0; border-radius: 10px; border: 1px solid var(--border);
  background: var(--card); cursor: pointer; font: inherit; font-size: 13px; color: var(--ink-secondary);
  transition: all .15s;
}
.seg.active { border-color: var(--brand); background: #fff5f3; color: var(--brand); font-weight: 700; }

.form__calorie { display: flex; justify-content: space-between; align-items: center; }
.switch { position: relative; display: inline-block; width: 42px; height: 24px; }
.switch input { opacity: 0; width: 0; height: 0; }
.switch__track {
  position: absolute; inset: 0; border-radius: 999px; background: var(--border);
  transition: background .2s; cursor: pointer;
}
.switch__track::before {
  content: ''; position: absolute; left: 3px; top: 3px; width: 18px; height: 18px;
  border-radius: 50%; background: #fff; transition: transform .2s;
}
.switch input:checked + .switch__track { background: var(--brand); }
.switch input:checked + .switch__track::before { transform: translateX(18px); }

.form__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); cursor: pointer;
  background: var(--card); font: inherit; font-size: 13px; color: var(--ink-secondary); transition: all .15s;
}
.chip.active { border-color: var(--brand); background: var(--brand); color: #fff; font-weight: 600; }
/* 正向诉求 chip：可点击删除，颜色区别于忌口（忌口=实心品牌色，诉求=描边绿） */
.chip--want {
  border-color: var(--categorical-3, #1baf7a); color: var(--categorical-3, #1baf7a);
  background: transparent; font-weight: 600;
}
.chip--want:hover { background: rgba(27, 175, 122, .1); }

.form__select {
  width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 10px; font: inherit; font-size: 14px; color: var(--ink-primary); background: var(--card);
}

.store-locate { display: flex; flex-direction: column; gap: 8px; }
.form__input {
  width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 10px; font: inherit; font-size: 14px; color: var(--ink-primary); background: var(--card);
}
.form__input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }

.store-locate__actions { display: flex; gap: 8px; }
.btn-locate, .btn-search {
  flex: 1; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--card); cursor: pointer; font: inherit; font-size: 13px; color: var(--ink-secondary);
  transition: all .15s;
}
.btn-locate:hover:not(:disabled), .btn-search:hover { border-color: var(--brand-soft); color: var(--brand); background: #fff5f3; }
.btn-locate:disabled { opacity: .6; cursor: not-allowed; }

.form__hint--error { color: #a31212; }

.form__submit {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 13px; border: none; border-radius: 14px; cursor: pointer;
  background: var(--brand); color: #fff; font: inherit; font-size: 16px; font-weight: 700;
  transition: filter .15s, transform .05s;
}
.form__submit:hover:not(:disabled) { filter: brightness(1.06); }
.form__submit:active:not(:disabled) { transform: translateY(1px); }
.form__submit:disabled { opacity: .6; cursor: not-allowed; }
.form__submit-spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.4); border-top-color: #fff; animation: spin .7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
