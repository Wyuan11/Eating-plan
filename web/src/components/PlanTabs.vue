<script setup>
import { computed } from 'vue'

/**
 * v1.2 多方案切换：后端返回 1～3 个策略化方案（省钱优先 / 预算吃满 / 均衡推荐 / 最低卡），
 * 全部满足同一组约束，只是优化目标不同。这里只负责渲染切换，不参与任何计算。
 */
const props = defineProps({
  plans: { type: Array, default: () => [] },
  active: { type: Number, default: 0 },
})
const emit = defineEmits(['change'])

const tabs = computed(() =>
  props.plans.map((p, i) => ({
    index: i,
    label: p.label,
    strategy: p.strategy,
    highlight: p.highlight,
    price: p.plan?.total_price ?? 0,
    calorie: p.plan?.total_calorie ?? 0,
  }))
)
</script>

<template>
  <div v-if="tabs.length > 1" class="tabs" role="tablist">
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
      <span class="tab__nums">¥{{ Number(t.price).toFixed(1) }} · {{ t.calorie }}kcal</span>
      <span v-if="t.strategy" class="tab__strategy">{{ t.strategy }}</span>
      <span v-if="t.highlight" class="tab__highlight">{{ t.highlight }}</span>
    </button>
  </div>
</template>

<style scoped>
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tab {
  flex: 1; min-width: 150px; display: flex; flex-direction: column; gap: 2px;
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
.tab__label { font-size: 13px; font-weight: 700; color: var(--ink-primary); }
.tab__nums { font-size: 12px; color: var(--ink-secondary); font-variant-numeric: tabular-nums; }
.tab__strategy { font-size: 11.5px; color: var(--ink-muted); line-height: 1.4; }
.tab__highlight {
  margin-top: 2px; font-size: 11.5px; font-weight: 600; color: var(--brand);
  background: #fff0ed; border-radius: 6px; padding: 2px 6px; align-self: flex-start;
}
</style>
