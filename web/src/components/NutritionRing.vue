<script setup>
import { computed, reactive, ref } from 'vue'

const props = defineProps({
  nutrition: { type: Object, default: () => ({}) },
})

// 三大宏量营养（钠另列，因单位不同 mg 不并入环形图）
const MACRO_DEFS = [
  { key: 'protein', label: '蛋白质', color: '#2a78d6' },
  { key: 'fat', label: '脂肪', color: '#eb6834' },
  { key: 'carbohydrate', label: '碳水', color: '#1baf7a' },
]

const SIZE = 168
const CX = SIZE / 2
const RO = 70 // 外半径
const RI = 46 // 内半径

const total = computed(() => {
  const n = props.nutrition || {}
  return MACRO_DEFS.reduce((s, d) => s + (n[d.key] || 0), 0)
})

const polar = (deg, r) => {
  const rad = ((deg - 90) * Math.PI) / 180 // 0° 从顶部开始
  return { x: CX + r * Math.cos(rad), y: CX + r * Math.sin(rad) }
}

const arc = (startDeg, endDeg) => {
  const a0 = polar(startDeg, RO)
  const a1 = polar(endDeg, RO)
  const b0 = polar(startDeg, RI)
  const b1 = polar(endDeg, RI)
  const large = endDeg - startDeg > 180 ? 1 : 0
  return [
    `M ${a0.x.toFixed(2)} ${a0.y.toFixed(2)}`,
    `A ${RO} ${RO} 0 ${large} 1 ${a1.x.toFixed(2)} ${a1.y.toFixed(2)}`,
    `L ${b1.x.toFixed(2)} ${b1.y.toFixed(2)}`,
    `A ${RI} ${RI} 0 ${large} 0 ${b0.x.toFixed(2)} ${b0.y.toFixed(2)}`,
    'Z',
  ].join(' ')
}

const segments = computed(() => {
  const t = total.value || 1
  let acc = 0
  return MACRO_DEFS.filter((d) => (props.nutrition?.[d.key] || 0) > 0).map((d) => {
    const value = props.nutrition[d.key] || 0
    const span = (value / t) * 360
    const gap = Math.min(span * 0.3, 5)
    const seg = {
      ...d,
      value,
      pct: Math.round((value / t) * 100),
      d: arc(acc + gap / 2, acc + span - gap / 2),
    }
    acc += span
    return seg
  })
})

const hover = reactive({ active: false, x: 0, y: 0, seg: null })
const wrap = ref(null)

function onMove(e) {
  if (!wrap.value) return
  const rect = wrap.value.getBoundingClientRect()
  hover.x = e.clientX - rect.left
  hover.y = e.clientY - rect.top
}
function enter(seg) { hover.active = true; hover.seg = seg }
function leave() { hover.active = false; hover.seg = null }
</script>

<template>
  <div class="ring">
    <div ref="wrap" class="ring__chart" @mousemove="onMove" @mouseleave="leave">
      <svg :width="SIZE" :height="SIZE" viewBox="0 0 168 168" role="img" aria-label="三大宏量营养构成">
        <!-- 背景轨道 -->
        <circle :cx="CX" :cy="CX" :r="(RO + RI) / 2" fill="none" :stroke-width="RO - RI" stroke="var(--track)" />
        <!-- 各段 -->
        <path
          v-for="(seg, i) in segments"
          :key="seg.key"
          :d="seg.d"
          :fill="seg.color"
          :opacity="!hover.active || hover.seg?.key === seg.key ? 1 : 0.35"
          style="transition: opacity .2s; cursor: pointer;"
          @mouseenter="enter(seg)"
        >
          <title>{{ seg.label }} {{ seg.value }}g · {{ seg.pct }}%</title>
        </path>
        <!-- 中心文字 -->
        <text :x="CX" :y="CX - 4" text-anchor="middle" class="ring__center-num">{{ total }}</text>
        <text :x="CX" :y="CX + 16" text-anchor="middle" class="ring__center-label">三大宏量 (g)</text>
      </svg>

      <!-- 悬停提示 -->
      <div
        v-if="hover.active && hover.seg"
        class="ring__tooltip"
        :style="{ left: hover.x + 12 + 'px', top: hover.y - 12 + 'px' }"
      >
        <span class="dot" :style="{ background: hover.seg.color }"></span>
        {{ hover.seg.label }} <strong>{{ hover.seg.value }}g</strong> · {{ hover.seg.pct }}%
      </div>
    </div>

    <!-- 图例（文字标签，满足可见性/无障碍要求） -->
    <ul class="ring__legend">
      <li v-for="seg in segments" :key="seg.key" @mouseenter="enter(seg)" @mouseleave="leave">
        <span class="dot" :style="{ background: seg.color }"></span>
        <span class="name">{{ seg.label }}</span>
        <span class="val">{{ seg.value }}g</span>
        <span class="pct">{{ seg.pct }}%</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ring { display: flex; align-items: center; gap: 20px; }
.ring__chart { position: relative; flex: 0 0 auto; }
.ring__center-num { font-size: 26px; font-weight: 700; fill: var(--ink-primary); font-variant-numeric: tabular-nums; }
.ring__center-label { font-size: 11px; fill: var(--ink-muted); }

.ring__tooltip {
  position: absolute; z-index: 5; transform: translateY(-50%);
  background: var(--ink-primary); color: #fff; font-size: 12px; padding: 6px 10px;
  border-radius: 8px; white-space: nowrap; pointer-events: none;
  display: flex; align-items: center; gap: 6px;
  box-shadow: 0 4px 14px rgba(0,0,0,.18);
}
.ring__tooltip .dot { width: 8px; height: 8px; border-radius: 50%; }

.ring__legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; min-width: 132px; }
.ring__legend li { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: default; }
.ring__legend .dot { width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto; }
.ring__legend .name { color: var(--ink-secondary); }
.ring__legend .val { font-weight: 700; color: var(--ink-primary); font-variant-numeric: tabular-nums; margin-left: auto; }
.ring__legend .pct { color: var(--ink-muted); width: 36px; text-align: right; font-variant-numeric: tabular-nums; }

@media (max-width: 420px) {
  .ring { flex-direction: column; align-items: flex-start; }
  .ring__legend { flex-direction: row; flex-wrap: wrap; min-width: 0; }
}
</style>
