<script setup>
import { computed, ref, watch } from 'vue'
import { recompute } from '../lib/verify.js'
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

// v1.2：1～3 个方案，下标即顺序；换方案后整页（金额/热量/营养/校验）都跟着换
const active = ref(0)
const plans = computed(() => props.result.plans || [])
const activePlan = computed(() => plans.value[active.value] || plans.value[0] || null)
const isMain = computed(() => active.value === 0)
const constraints = computed(() => props.result.constraints || {})

// 换了一组方案（新求解结果）时回到第一个
watch(plans, () => { active.value = 0 })

const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.01

/** 每个方案都独立重算一次：不信任任何声明值，这是本项目的核心论点 */
const check = computed(() => {
  const p = activePlan.value
  if (!p || !p.plan) return null
  const items = p.items || []
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
  return {
    items,
    total_price: re.total_price,
    total_calorie: re.total_calorie,
    verified: priceMatch && calorieMatch && (nutritionMatch || !p.nutrition),
    note: !priceMatch
      ? 'AI 声明的总价与逐项重算不一致，已以重算值为准'
      : !calorieMatch
        ? (re.unknownCalorieCount
          ? `有 ${re.unknownCalorieCount} 件菜品热量未公布，总热量无法完全核验`
          : 'AI 声明的总热量与逐项重算不一致，已以重算值为准')
        : p.nutrition && !nutritionMatch
          ? '营养总和与声明值不一致，已以重算值为准'
          : null,
    nutrition: p.nutrition,
    saved: declared.saved ?? 0,
    original_price: declared.original_price ?? declared.total_price ?? 0,
    label: p.label,
    strategy: p.strategy,
    highlight: p.highlight,
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

const overBudget = computed(() => check.value && check.value.total_price > (constraints.value.budget || 0))
const overCalorie = computed(
  () => check.value && constraints.value.calorie_limit != null && check.value.total_calorie > constraints.value.calorie_limit
)

function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <div class="result" v-if="check">
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
          <li v-if="overBudget">总价 ¥{{ check.total_price.toFixed(1) }} 超出预算 ¥{{ constraints.budget }}（超 ¥{{ (check.total_price - constraints.budget).toFixed(1) }}）</li>
          <li v-if="overCalorie">总热量 {{ check.total_calorie }} 大卡超出上限 {{ constraints.calorie_limit }} 大卡</li>
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

    <!-- 双进度条（跟随当前方案） -->
    <section class="card result__meters">
      <MeterBar title="预算" :value="check.total_price" :limit="constraints.budget" unit="¥" :color="budgetColor" />
      <MeterBar title="热量" :value="check.total_calorie" :limit="constraints.calorie_limit" suffix=" 大卡" :color="calorieColor" />
    </section>

    <!-- 省钱模块 -->
    <SavingsStrip
      v-if="check.saved > 0"
      :original_price="check.original_price"
      :total_price="check.total_price"
      :saved="check.saved"
    />

    <div class="result__grid">
      <section v-if="check.nutrition" class="card ring-card">
        <h3 class="card__title">营养构成</h3>
        <NutritionRing :nutrition="check.nutrition" />
      </section>
      <section class="card items-card">
        <h3 class="card__title">
          「{{ check.label }}」方案菜品（{{ check.items.reduce((n, i) => n + (i.quantity || 1), 0) }} 件）
        </h3>
        <p v-if="check.strategy" class="items-card__strategy">{{ check.strategy }}<span v-if="check.highlight"> · {{ check.highlight }}</span></p>
        <div class="items">
          <ItemCard v-for="it in check.items" :key="it.code + '-' + it.quantity" :item="it" />
        </div>
      </section>
    </div>

    <!-- 建议（主方案的解说） -->
    <div v-if="isMain && result.suggestion" class="result__suggestion">
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
.result__grid:has(.ring-card) { grid-template-columns: 260px 1fr; }
.ring-card { position: sticky; top: 84px; }
.items { display: flex; flex-direction: column; gap: 10px; }
.items-card__strategy { margin: -8px 0 12px; font-size: 12.5px; color: var(--ink-muted); }

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
