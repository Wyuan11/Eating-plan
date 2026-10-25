<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { EXCLUDE_OPTIONS, QUICK_PRESETS } from '../lib/schema.js'
import { parseQuery } from '../lib/parseQuery.js'

const props = defineProps({
  stores: { type: Array, default: () => [] },
  storesMock: { type: Boolean, default: false },
  loading: { type: Boolean, default: false },
})
const emit = defineEmits(['submit'])

const query = ref('')
const form = reactive({
  budget: 60,
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

watch(
  () => props.stores,
  (list) => {
    if (list?.length && !storeCode.value) storeCode.value = list[0].code
  },
  { immediate: true }
)

const parsePreview = computed(() => {
  if (!query.value.trim()) return null
  return parseQuery(query.value)
})

// 识别到结构化约束就同步回填表单控件，避免「文本里是 80，滑块停在 150」的误导
watch(query, (q) => {
  if (!q.trim()) return
  const p = parseQuery(q)
  if (p.budget != null) form.budget = p.budget
  if (p.people != null) form.people = p.people
  if (p.calorie_limit != null) {
    form.useCalorie = true
    form.calorie_limit = p.calorie_limit
  }
  if (p.excluded.length) form.excluded = [...new Set([...form.excluded, ...p.excluded])]
})

function toggleExclude(w) {
  const i = form.excluded.indexOf(w)
  if (i >= 0) form.excluded.splice(i, 1)
  else form.excluded.push(w)
}

function applyPreset(p) {
  query.value = p.query
  form.budget = p.constraints.budget
  form.people = p.constraints.people
  form.useCalorie = p.constraints.calorie_limit != null
  form.calorie_limit = p.constraints.calorie_limit ?? 1200
  form.excluded = [...(p.constraints.excluded || [])]
}

function buildConstraints() {
  const c = {
    budget: Number(form.budget) || 60,
    people: Number(form.people) || 1,
    calorie_limit: form.useCalorie ? Number(form.calorie_limit) || null : null,
    excluded: [...form.excluded],
  }
  // 自然语言覆盖空位（仅演示回填，真正的语义理解在 Skill）
  if (query.value.trim()) {
    const p = parseQuery(query.value)
    if (p.budget != null) c.budget = p.budget
    if (p.people != null) c.people = p.people
    if (p.calorie_limit != null) c.calorie_limit = p.calorie_limit
    if (p.excluded.length) c.excluded = [...new Set([...c.excluded, ...p.excluded])]
  }
  return c
}

function submit() {
  emit('submit', {
    storeCode: storeCode.value,
    query: query.value.trim() || undefined,
    constraints: buildConstraints(),
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
        已识别：<template v-if="parsePreview.budget">预算 ¥{{ parsePreview.budget }} · </template
        ><template v-if="parsePreview.people">{{ parsePreview.people }} 人 · </template
        ><template v-if="parsePreview.calorie_limit">热量上限 {{ parsePreview.calorie_limit }} 大卡 · </template
        ><template v-if="parsePreview.excluded.length">忌口 {{ parsePreview.excluded.join('、') }}</template>
      </p>
    </section>

    <!-- 快捷示例 -->
    <section class="form__presets">
      <button v-for="p in QUICK_PRESETS" :key="p.label" class="preset" type="button" @click="applyPreset(p)">
        {{ p.label }}
      </button>
    </section>

    <!-- 结构化约束 -->
    <section class="form__block">
      <label class="form__label" for="budget">预算（元）</label>
      <div class="form__slider">
        <input id="budget" v-model.number="form.budget" type="range" min="10" max="200" step="5" />
        <input v-model.number="form.budget" type="number" class="form__num" min="10" max="500" />
      </div>
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

    <section class="form__block">
      <span class="form__label">忌口（可多选）</span>
      <div class="form__chips">
        <button
          v-for="w in EXCLUDE_OPTIONS" :key="w" type="button" class="chip"
          :class="{ active: form.excluded.includes(w) }" @click="toggleExclude(w)"
        >{{ w }}</button>
      </div>
    </section>

    <!-- 门店 -->
    <section class="form__block">
      <label class="form__label" for="store">门店</label>
      <select id="store" v-model="storeCode" class="form__select">
        <option v-for="s in stores" :key="s.code" :value="s.code">
          {{ s.name }}{{ s.distance ? ' · ' + s.distance : '' }}
        </option>
      </select>
      <p v-if="storesMock" class="form__hint">门店为演示数据，接入 /api/stores 后为真实附近门店</p>
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

.form__select {
  width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 10px; font: inherit; font-size: 14px; color: var(--ink-primary); background: var(--card);
}

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
