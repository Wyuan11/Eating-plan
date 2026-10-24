<script setup>
import { computed } from 'vue'

const props = defineProps({
  mainPlan: { type: Object, required: true },
  alternatives: { type: Array, default: () => [] },
  active: { type: Number, default: -1 }, // -1 = 主方案
})
const emit = defineEmits(['change'])

const tabs = computed(() => [
  { index: -1, label: '均衡推荐', price: props.mainPlan.total_price, calorie: props.mainPlan.total_calorie },
  ...props.alternatives.map((a, i) => ({
    index: i,
    label: a.label,
    price: a.total_price,
    calorie: a.total_calorie,
  })),
])
</script>

<template>
  <div class="tabs" role="tablist">
    <button
      v-for="t in tabs"
      :key="t.index"
      class="tab"
      :class="{ active: active === t.index }"
      role="tab"
      :aria-selected="active === t.index"
      @click="emit('change', t.index)"
    >
      <span class="tab__label">{{ t.label }}</span>
      <span class="tab__nums">¥{{ t.price.toFixed(1) }} · {{ t.calorie }}kcal</span>
    </button>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tab {
  flex: 1; min-width: 120px; display: flex; flex-direction: column; gap: 2px;
  padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border);
  background: var(--card); cursor: pointer; text-align: left;
  transition: border-color .15s, background .15s, box-shadow .15s;
  font: inherit;
}
.tab:hover { border-color: var(--brand-soft); }
.tab.active {
  border-color: var(--brand); background: #fff5f3;
  box-shadow: 0 2px 0 var(--brand);
}
.tab__label { font-size: 13px; font-weight: 600; color: var(--ink-primary); }
.tab__nums { font-size: 12px; color: var(--ink-secondary); font-variant-numeric: tabular-nums; }
</style>
