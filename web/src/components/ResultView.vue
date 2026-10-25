<script setup>
import { computed, ref } from 'vue'
import { verify, recompute } from '../lib/verify.js'
import MeterBar from './MeterBar.vue'
import NutritionRing from './NutritionRing.vue'
import ItemCard from './ItemCard.vue'
import VerifyBadge from './VerifyBadge.vue'
import SavingsStrip from './SavingsStrip.vue'
import PlanTabs from './PlanTabs.vue'

const props = defineProps({
  result: { type: Object, required: true },
  mock: { type: Boolean, default: false },
  fallbackReason: { type: String, default: null },
})

const active = ref(-1) // -1 = 主方案；>=0 = alternatives 下标

const verification = computed(() => verify(props.result))
const constraints = computed(() => props.result.constraints || {})

const isMain = computed(() => active.value === -1)

const alt = computed(() =>
  active.value >= 0 ? (props.result.alternatives || [])[active.value] : null
)

// 备选方案也独立重算一次，保持"不信任声明值"的一致口径
// v1.1 起备选 items 自带 quantity，不能强制为 1
const altCheck = computed(() => {
  if (!alt.value) return null
  const items = (alt.value.items || []).map((it) => ({ ...it, quantity: it.quantity || 1 }))
  const re = recompute(items)
  return {
    re,
    priceMatch: Math.abs(re.total_price - (alt.value.total_price || 0)) < 0.01,
    calorieMatch: re.unknownCalorieCount === 0 && Math.abs(re.total_calorie - (alt.value.total_calorie || 0)) < 0.01,
  }
})

const activeView = computed(() => {
  if (isMain.value && verification.value) {
    const v = verification.value
    return {
      isMain: true,
      total_price: v.computed.total_price,
      total_calorie: v.computed.total_calorie,
      verified: v.verified,
      note: v.note,
      nutrition: props.result.nutrition,
      saved: props.result.plan?.saved ?? 0,
      original_price: props.result.plan?.original_price ?? 0,
    }
  }
  if (alt.value && altCheck.value) {
    const a = altCheck.value
    return {
      isMain: false,
      total_price: a.re.total_price,
      total_calorie: a.re.total_calorie,
      verified: a.priceMatch && a.calorieMatch,
      note: null,
      nutrition: null,
      saved: 0,
      original_price: 0,
    }
  }
  return null
})

const budgetColor = computed(() => {
  if (!activeView.value) return 'normal'
  const over = activeView.value.total_price > (constraints.value.budget || 0)
  if (over) return 'over'
  const usage = constraints.value.budget ? activeView.value.total_price / constraints.value.budget : 0
  return usage >= 0.9 ? 'warn' : 'normal'
})
const calorieColor = computed(() => {
  if (!activeView.value || constraints.value.calorie_limit == null) return 'normal'
  const over = activeView.value.total_calorie > constraints.value.calorie_limit
  if (over) return 'over'
  const usage = activeView.value.total_calorie / constraints.value.calorie_limit
  return usage >= 0.9 ? 'warn' : 'normal'
})

const overBudget = computed(() => activeView.value && activeView.value.total_price > (constraints.value.budget || 0))
const overCalorie = computed(
  () => activeView.value && constraints.value.calorie_limit != null && activeView.value.total_calorie > constraints.value.calorie_limit
)

const altItems = computed(() =>
  alt.value ? (alt.value.items || []).map((it, i) => ({ ...it, quantity: it.quantity || 1, tags: it.tags || [], key: it.code || i })) : []
)

const altCount = computed(() => altItems.value.reduce((n, it) => n + it.quantity, 0))

const mainCount = computed(() => (props.result.items || []).reduce((n, it) => n + (it.quantity || 1), 0))

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="result" v-if="activeView">
    <!-- 内置演示数据提示 -->
    <div v-if="mock" class="mock-banner" role="status">
      🧪 <span><strong>内置演示数据</strong>{{ fallbackReason ? ' · ' + fallbackReason : '' }} — 接入后端 /api/plan 后为真实求解结果</span>
    </div>

    <!-- 超标拦截（关键职责） -->
    <div v-if="overBudget || overCalorie" class="alert-over" role="alert">
      <div class="alert-over__icon">⚠</div>
      <div>
        <strong>方案超出约束上限，已拦截提示</strong>
        <ul>
          <li v-if="overBudget">总价 ¥{{ activeView.total_price.toFixed(1) }} 超出预算 ¥{{ constraints.budget }}（超 ¥{{ (activeView.total_price - constraints.budget).toFixed(1) }}）</li>
          <li v-if="overCalorie">总热量 {{ activeView.total_calorie }} 大卡超出上限 {{ constraints.calorie_limit }} 大卡</li>
        </ul>
      </div>
    </div>

    <!-- 校验 + 来源 -->
    <div class="result__head">
      <VerifyBadge :verified="activeView.verified" :note="activeView.note" />
      <span class="result__source">{{ result.source_note }}</span>
    </div>

    <!-- 双进度条 -->
    <section class="card result__meters">
      <MeterBar
        title="预算"
        :value="activeView.total_price"
        :limit="constraints.budget"
        unit="¥"
        :color="budgetColor"
      />
      <MeterBar
        title="热量"
        :value="activeView.total_calorie"
        :limit="constraints.calorie_limit"
        suffix=" 大卡"
        :color="calorieColor"
      />
    </section>

    <!-- 省钱模块（仅主方案有原价） -->
    <SavingsStrip
      v-if="activeView.isMain"
      :original_price="activeView.original_price"
      :total_price="activeView.total_price"
      :saved="activeView.saved"
    />

    <!-- 方案切换 -->
    <PlanTabs
      :main-plan="result.plan"
      :alternatives="result.alternatives || []"
      :active="active"
      @change="active = $event"
    />

    <!-- 主方案：营养环 + 菜品卡 + 建议 -->
    <template v-if="activeView.isMain">
      <div class="result__grid">
        <section class="card ring-card">
          <h3 class="card__title">营养构成</h3>
          <NutritionRing :nutrition="activeView.nutrition" />
        </section>
        <section class="card items-card">
          <h3 class="card__title">本方案菜品（{{ mainCount }} 件）</h3>
          <div class="items">
            <ItemCard v-for="it in result.items" :key="it.code + '-' + it.quantity" :item="it" />
          </div>
        </section>
      </div>
      <div class="result__suggestion">
        <span class="result__suggestion-label">💡 建议</span>
        <p>{{ result.suggestion }}</p>
      </div>
    </template>

    <!-- 备选方案：与主方案同构的完整视图（v1.1 起备选带 nutrition/image） -->
    <template v-else>
      <div class="result__grid">
        <section class="card ring-card">
          <h3 class="card__title">营养构成</h3>
          <NutritionRing v-if="altCheck && altCheck.re.nutrition" :nutrition="altCheck.re.nutrition" />
          <p v-else class="alt-note">营养数据不足，无法绘制</p>
        </section>
        <section class="card items-card">
          <h3 class="card__title">「{{ alt.label }}」菜品（{{ altCount }} 件）</h3>
          <div class="items">
            <ItemCard v-for="it in altItems" :key="it.key + '-' + it.quantity" :item="it" />
          </div>
          <div class="alt-total">
            <span>合计</span>
            <strong>¥{{ activeView.total_price.toFixed(1) }} · {{ activeView.total_calorie }} kcal</strong>
          </div>
        </section>
      </div>
      <p class="alt-note">备选方案的原价/节省信息以「均衡推荐」主方案为准；其余字段与主方案同构，可直接下单。</p>
    </template>

    <!-- 审计信息 -->
    <footer class="result__audit">
      <span>🏪 {{ result.meta?.storeName || '—' }}</span>
      <span class="sep">·</span>
      <span>Trace {{ result.meta?.traceId || '—' }}</span>
      <span class="sep">·</span>
      <span>{{ fmtTime(result.meta?.generatedAt) }}</span>
    </footer>
  </div>
</template>

<style scoped>
.result { display: flex; flex-direction: column; gap: 14px; }

.mock-banner {
  display: flex; gap: 8px; align-items: center; padding: 10px 14px; font-size: 13px;
  background: #eef4ff; border: 1px solid #cfe0fb; border-radius: 12px; color: #1c5cab;
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

.card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 16px; }
.card__title { margin: 0 0 14px; font-size: 14px; font-weight: 700; color: var(--ink-primary); }

.result__grid { display: grid; grid-template-columns: 260px 1fr; gap: 14px; align-items: start; }
.ring-card { position: sticky; top: 84px; }
.items { display: flex; flex-direction: column; gap: 10px; }

.result__suggestion {
  display: flex; gap: 12px; padding: 14px 16px; border-radius: 14px;
  background: var(--wash); border: 1px solid var(--border);
}
.result__suggestion-label { flex: 0 0 auto; font-weight: 700; color: var(--ink-primary); font-size: 13px; }
.result__suggestion p { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--ink-secondary); }

.alt-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.alt-list li { display: flex; align-items: center; gap: 12px; font-size: 14px; padding: 8px 0; border-bottom: 1px dashed var(--border); }
.alt-list__name { color: var(--ink-primary); font-weight: 500; }
.alt-list__kcal { color: var(--ink-muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.alt-list__price { margin-left: auto; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }
.alt-total { display: flex; justify-content: space-between; font-size: 14px; color: var(--ink-secondary); }
.alt-total strong { color: var(--ink-primary); font-variant-numeric: tabular-nums; }
.alt-note { margin: 10px 0 0; font-size: 12px; color: var(--ink-muted); }

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
