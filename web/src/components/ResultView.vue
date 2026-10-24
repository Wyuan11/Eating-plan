<script setup>
import { computed, ref, watch } from 'vue'
import { recompute } from '../lib/verify.js'
import MeterBar from './MeterBar.vue'
import NutritionRing from './NutritionRing.vue'
import ItemCard from './ItemCard.vue'
import VerifyBadge from './VerifyBadge.vue'
import SavingsStrip from './SavingsStrip.vue'
import PlanTabs from './PlanTabs.vue'
import MenuPicker from './MenuPicker.vue'
import OrderPanel from './OrderPanel.vue'

const props = defineProps({
  result: { type: Object, required: true },
  mock: { type: Boolean, default: false },
  fallbackReason: { type: String, default: null },
})

// v1.2：1～3 个方案，下标即顺序；换方案后整页（金额/热量/营养/校验）都跟着换
const active = ref(0)
const plans = computed(() => props.result.plans || [])
const activePlan = computed(() => plans.value[active.value] || plans.value[0] || null)
const isMain = computed(() => active.value === 0)
const constraints = computed(() => props.result.constraints || {})
const storeCode = computed(() => props.result.meta?.storeCode || props.result.request?.storeCode || '')

// 换了一组方案（新求解结果）时回到第一个，并清掉手动微调
watch(plans, () => { active.value = 0 })

// ---------- 手动微调：增减数量 / 从总菜单加菜（前端只做选择+算术，不产生新推荐） ----------
const deltas = ref({}) // 求解结果里已有商品的增减量（code -> delta）
const custom = ref([]) // 从总菜单手动加入的商品
const pickerOpen = ref(false)

const planItems = computed(() => activePlan.value?.items || [])
const adjustedItems = computed(() => {
  const out = []
  for (const it of planItems.value) {
    const q = (it.quantity || 1) + (deltas.value[it.code] || 0)
    if (q > 0) out.push({ ...it, quantity: q })
  }
  for (const it of custom.value) out.push({ ...it })
  return out
})
const customized = computed(
  () => Object.values(deltas.value).some((d) => d !== 0) || custom.value.length > 0
)
const baseQty = (code) => planItems.value.find((i) => i.code === code)?.quantity || 0

function incItem(it) {
  if (baseQty(it.code) > 0) deltas.value = { ...deltas.value, [it.code]: (deltas.value[it.code] || 0) + 1 }
  else {
    const c = custom.value.find((x) => x.code === it.code)
    if (c) c.quantity++
    else custom.value = [...custom.value, { ...it, quantity: 1, tags: it.tags || [] }]
  }
}
function decItem(it) {
  if (baseQty(it.code) > 0) {
    deltas.value = { ...deltas.value, [it.code]: Math.max(-baseQty(it.code), (deltas.value[it.code] || 0) - 1) }
  } else {
    const c = custom.value.find((x) => x.code === it.code)
    if (c) {
      c.quantity--
      if (c.quantity <= 0) custom.value = custom.value.filter((x) => x.code !== it.code)
    }
  }
}
function addFromMenu(item) {
  incItem({ ...item, quantity: 0 })
}
function resetTweaks() {
  deltas.value = {}
  custom.value = []
}

const notes = computed(() => props.result.request?.notes || [])
const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.01

/** 统一口径：不管有没有手动微调，都按 adjustedItems 逐项重算，再与声明值、约束两头比对 */
const check = computed(() => {
  const p = activePlan.value
  if (!p || !p.plan) return null
  const items = adjustedItems.value
  const re = recompute(items)
  const declared = p.plan
  const priceMatch = near(re.total_price, declared.total_price)
  const calorieMatch = re.unknownCalorieCount === 0 && near(re.total_calorie, declared.total_calorie)
  const nutrition = p.nutrition || {}
  const nutritionMatch =
    !!p.nutrition &&
    near(re.nutrition.protein, nutrition.protein) &&
    near(re.nutrition.fat, nutrition.fat) &&
    near(re.nutrition.carbohydrate, nutrition.carbohydrate)

  // 约束校验针对「微调后」的真实数量——这就是前端拦截的意义
  const overBudget = constraints.value.budget ? re.total_price > constraints.value.budget : false
  const overCalorie =
    constraints.value.calorie_limit != null && re.total_calorie > constraints.value.calorie_limit
  const constraintOK = !overBudget && !overCalorie

  let note = null
  if (customized.value && overBudget) note = `微调后超出预算 ¥${constraints.value.budget}`
  else if (customized.value && overCalorie) note = `微调后超出热量上限 ${constraints.value.calorie_limit} 大卡`
  else if (!priceMatch) note = 'AI 声明的总价与逐项重算不一致，已以重算值为准'
  else if (!calorieMatch)
    note = re.unknownCalorieCount
      ? `有 ${re.unknownCalorieCount} 件菜品热量未公布，总热量无法完全核验`
      : 'AI 声明的总热量与逐项重算不一致，已以重算值为准'
  else if (p.nutrition && !nutritionMatch) note = '营养总和与声明值不一致，已以重算值为准'

  return {
    items,
    total_price: re.total_price,
    total_calorie: re.total_calorie,
    verified: priceMatch && calorieMatch && (nutritionMatch || !p.nutrition) && constraintOK,
    note,
    nutrition: p.nutrition,
    saved: declared.saved ?? 0,
    original_price: declared.original_price ?? declared.total_price ?? 0,
    label: p.label,
    strategy: p.strategy,
    highlight: p.highlight,
    overBudget,
    overCalorie,
  }
})

const budgetColor = computed(() => {
  if (!check.value) return 'normal'
  const limit = constraints.value.budget || 0
  if (check.value.total_price > limit) return 'over'
  const usage = limit ? check.value.total_price / limit : 0
  return usage >= 0.9 ? 'warn' : 'normal'
})
const calorieColor = computed(() => {
  if (!check.value || constraints.value.calorie_limit == null) return 'normal'
  const limit = constraints.value.calorie_limit
  if (check.value.total_calorie > limit) return 'over'
  return check.value.total_calorie / limit >= 0.9 ? 'warn' : 'normal'
})

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="result" v-if="check">
    <!-- 数据来源提示：演示数据 / Skill 网关降级说明 -->
    <div v-if="mock || fallbackReason" class="mock-banner" role="status">
      <template v-if="mock">🧪 <span><strong>内置演示数据</strong>{{ fallbackReason ? ' · ' + fallbackReason : '' }} — 接入后端 /api/plan 后为真实求解结果</span></template>
      <template v-else>ℹ️ <span>{{ fallbackReason }}</span></template>
    </div>

    <!-- 已记录但无法参与求解的诉求（如「不要冰饮」菜单无温度数据）：如实披露，不静默丢弃 -->
    <div v-for="n in notes" :key="n.text" class="note-banner" role="status">
      📌 「{{ n.text }}」—— {{ n.reason }}
    </div>

    <!-- 超标拦截（关键职责）：微调后同样生效 -->
    <div v-if="check.overBudget || check.overCalorie" class="alert-over" role="alert">
      <div class="alert-over__icon">⚠</div>
      <div>
        <strong>方案超出约束上限，已拦截提示</strong>
        <ul>
          <li v-if="check.overBudget">总价 ¥{{ check.total_price.toFixed(1) }} 超出预算 ¥{{ constraints.budget }}（超 ¥{{ (check.total_price - constraints.budget).toFixed(1) }}）</li>
          <li v-if="check.overCalorie">总热量 {{ check.total_calorie }} 大卡超出上限 {{ constraints.calorie_limit }} 大卡</li>
        </ul>
      </div>
    </div>

    <!-- 校验 + 来源 -->
    <div class="result__head">
      <VerifyBadge :verified="check.verified" :note="check.note" />
      <span class="result__source">{{ result.source_note }}</span>
    </div>

    <!-- 方案切换：1～3 个策略化方案，全部满足同一组约束 -->
    <PlanTabs :plans="plans" :active="active" @change="active = $event" />

    <!-- 手动微调工具条 -->
    <div class="tweak-bar">
      <button class="tweak-bar__btn" type="button" @click="pickerOpen = !pickerOpen">
        {{ pickerOpen ? '收起菜单' : '＋ 从总菜单加菜' }}
      </button>
      <button v-if="customized" class="tweak-bar__btn tweak-bar__reset" type="button" @click="resetTweaks">
        ↺ 撤销全部微调
      </button>
      <span v-if="customized" class="tweak-bar__badge">已手动微调 · 实时重算校验</span>
    </div>
    <MenuPicker v-if="pickerOpen" :store-code="storeCode" @add="addFromMenu" />

    <!-- 双进度条（跟随当前方案与微调结果） -->
    <section class="card result__meters">
      <MeterBar title="预算" :value="check.total_price" :limit="constraints.budget" unit="¥" :color="budgetColor" />
      <MeterBar title="热量" :value="check.total_calorie" :limit="constraints.calorie_limit" suffix=" 大卡" :color="calorieColor" />
    </section>

    <!-- 省钱模块（手动微调后 saved 不再准确，隐藏避免误导） -->
    <SavingsStrip
      v-if="!customized && check.saved > 0"
      :original_price="check.original_price"
      :total_price="check.total_price"
      :saved="check.saved"
    />

    <div class="result__grid">
      <section v-if="check.nutrition && !customized" class="card ring-card">
        <h3 class="card__title">营养构成</h3>
        <NutritionRing :nutrition="check.nutrition" />
      </section>
      <section class="card items-card">
        <h3 class="card__title">
          「{{ check.label }}」方案菜品（{{ check.items.reduce((n, i) => n + (i.quantity || 1), 0) }} 件）
        </h3>
        <p v-if="check.strategy" class="items-card__strategy">{{ check.strategy }}<span v-if="check.highlight"> · {{ check.highlight }}</span></p>
        <div class="items">
          <div v-for="it in check.items" :key="it.code" class="item-row">
            <ItemCard :item="it" />
            <div class="item-row__ctrl" aria-label="数量调整">
              <button type="button" class="ctrl" @click="decItem(it)" :aria-label="'减少 ' + it.name">−</button>
              <span class="ctrl__qty">{{ it.quantity || 1 }}</span>
              <button type="button" class="ctrl" @click="incItem(it)" :aria-label="'增加 ' + it.name">＋</button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- 下单：按当前方案（含微调）生成支付链接，只渲染二维码不自动支付 -->
    <OrderPanel
      :items="check.items"
      :store-code="storeCode"
      :disabled="check.overBudget || check.overCalorie"
      :disabled-reason="check.overBudget || check.overCalorie ? '方案超出约束，已拦截下单' : null"
    />

    <!-- 建议（主方案的解说；手动微调后口径已变，隐藏） -->
    <div v-if="isMain && !customized && result.suggestion" class="result__suggestion">
      <span class="result__suggestion-label">💡 建议</span>
      <p>{{ result.suggestion }}</p>
    </div>

    <!-- 审计信息 -->
    <footer class="result__audit">
      <span>🏪 {{ result.meta?.storeName || '—' }}</span>
      <span class="sep">·</span>
      <span>Trace {{ result.meta?.traceId || '—' }}</span>
      <span class="sep">·</span>
      <span>{{ fmtTime(result.meta?.generatedAt) }}</span>
      <span class="sep">·</span>
      <span>{{ plans.length }} 个方案均满足约束</span>
    </footer>
  </div>
</template>

<style scoped>
.result { display: flex; flex-direction: column; gap: 14px; }

.mock-banner {
  display: flex; gap: 8px; align-items: center; padding: 10px 14px; font-size: 13px;
  background: #eef4ff; border: 1px solid #cfe0fb; border-radius: 12px; color: #1c5cab;
}

.note-banner {
  padding: 10px 14px; font-size: 13px; line-height: 1.6;
  background: #fff8e6; border: 1px solid #f0d89a; border-radius: 12px; color: #7a5300;
}

.alert-over {
  display: flex; gap: 10px; padding: 12px 14px; border-radius: 12px;
  background: #ffe3e1; border: 1px solid #f3b6b3; color: #a31212;
}
.alert-over__icon { font-size: 20px; line-height: 1.2; }
.alert-over strong { display: block; margin-bottom: 4px; }
.alert-over ul { margin: 0; padding-left: 18px; }
.alert-over li { font-size: 13px; }

.result__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.result__source { font-size: 12px; color: var(--ink-muted); }

.tweak-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.tweak-bar__btn {
  padding: 7px 14px; border-radius: 10px; border: 1px solid var(--brand);
  background: var(--card); color: var(--brand); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
.tweak-bar__btn:hover { background: #fff5f3; }
.tweak-bar__reset { border-color: var(--border); color: var(--ink-secondary); font-weight: 500; }
.tweak-bar__badge {
  font-size: 12px; color: #8a5a00; background: #fff3d6; border-radius: 999px; padding: 4px 10px; font-weight: 600;
}

.card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 16px; }
.card__title { margin: 0 0 14px; font-size: 14px; font-weight: 700; color: var(--ink-primary); }

.result__grid { display: grid; grid-template-columns: 260px 1fr; gap: 14px; align-items: start; }
.ring-card { position: sticky; top: 84px; }
.items { display: flex; flex-direction: column; gap: 10px; }
.items-card__strategy { margin: -8px 0 12px; font-size: 12.5px; color: var(--ink-muted); }

.item-row { display: flex; align-items: stretch; gap: 8px; }
.item-row > :first-child { flex: 1 1 auto; min-width: 0; }
.item-row__ctrl {
  flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  padding: 4px 2px;
}
.ctrl {
  width: 26px; height: 26px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--card); font: inherit; font-size: 15px; font-weight: 700; color: var(--ink-primary); cursor: pointer;
  line-height: 1;
}
.ctrl:hover { border-color: var(--brand); color: var(--brand); }
.ctrl__qty { font-size: 13px; font-weight: 700; color: var(--ink-primary); font-variant-numeric: tabular-nums; }

.result__suggestion {
  display: flex; gap: 12px; padding: 14px 16px; border-radius: 14px;
  background: var(--wash); border: 1px solid var(--border);
}
.result__suggestion-label { flex: 0 0 auto; font-weight: 700; color: var(--ink-primary); font-size: 13px; }
.result__suggestion p { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--ink-secondary); }

.result__audit {
  display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--ink-muted);
  padding-top: 6px;
}
.result__audit .sep { opacity: .5; }

@media (max-width: 900px) {
  .result__grid { grid-template-columns: 1fr; }
  .ring-card { position: static; }
}
</style>
