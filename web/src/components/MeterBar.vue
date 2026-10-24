<script setup>
import { computed } from 'vue'

const props = defineProps({
  title: { type: String, required: true },
  value: { type: Number, required: true },       // 当前值（元 / 大卡）
  limit: { type: Number, default: null },         // 上限；null = 未设上限
  unit: { type: String, default: '' },            // 值前缀，如 '¥'
  suffix: { type: String, default: '' },          // 值后缀，如 ' 大卡'
  color: { type: String, default: 'normal' },     // normal | warn | over 由外部按语义传入
})

const pct = computed(() => {
  if (!props.limit || props.limit <= 0) return 0
  return Math.min(100, (props.value / props.limit) * 100)
})

const usageText = computed(() => {
  if (!props.limit || props.limit <= 0) return '未设上限'
  return `${Math.round((props.value / props.limit) * 100)}%`
})

const fillColor = computed(() => {
  if (props.color === 'over') return 'var(--status-critical)'
  if (props.color === 'warn') return 'var(--status-warning)'
  return 'var(--categorical-1)'
})

// 整数显示不带小数（热量 962 而非 962.0），价格保留一位
const valueText = computed(() =>
  Number.isInteger(props.value) ? String(props.value) : props.value.toFixed(1)
)
</script>

<template>
  <div class="meter">
    <div class="meter__head">
      <span class="meter__title">{{ title }}</span>
      <span class="meter__nums">
        <template v-if="limit">
          <strong class="meter__value">{{ unit }}{{ valueText }}</strong>
          <span class="meter__limit"> / {{ unit }}{{ limit }}{{ suffix }}</span>
          <span class="meter__usage" :class="`is-${color}`">{{ usageText }}</span>
        </template>
        <template v-else>
          <strong class="meter__value">{{ unit }}{{ valueText }}{{ suffix }}</strong>
          <span class="meter__usage is-none">{{ usageText }}</span>
        </template>
      </span>
    </div>

    <div class="meter__track" role="meter" :aria-valuenow="pct" :aria-valuemin="0" :aria-valuemax="100">
      <div
        class="meter__fill"
        :class="`is-${color}`"
        :style="{ width: pct + '%', background: fillColor }"
      ></div>
    </div>

    <p v-if="color === 'over'" class="meter__warn" role="alert">
      ⚠ 已超出{{ title }}上限 {{ unit }}{{ (value - limit).toFixed(1) }}
    </p>
  </div>
</template>

<style scoped>
.meter + .meter { margin-top: 16px; }
.meter__head {
  display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
  margin-bottom: 8px;
}
.meter__title { font-weight: 600; color: var(--ink-primary); font-size: 14px; }
.meter__nums { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.meter__value { font-size: 18px; font-weight: 700; color: var(--ink-primary); font-variant-numeric: tabular-nums; }
.meter__limit { color: var(--ink-muted); font-size: 13px; }
.meter__usage {
  font-size: 12px; font-weight: 700; padding: 2px 8px; border-radius: 999px;
  color: var(--ink-secondary); background: var(--wash);
}
.meter__usage.is-warn { color: #8a5a00; background: #fff3d6; }
.meter__usage.is-over { color: #a31212; background: #ffe3e1; }
.meter__usage.is-none { color: var(--ink-muted); }

.meter__track {
  height: 12px; border-radius: 999px; overflow: hidden;
  background: var(--track);
}
.meter__fill {
  height: 100%; border-radius: 999px;
  transition: width .6s cubic-bezier(.22,.61,.36,1), background .3s;
  min-width: 4px;
}
.meter__warn {
  margin: 8px 0 0; font-size: 12.5px; font-weight: 600; color: var(--status-critical);
}
</style>
