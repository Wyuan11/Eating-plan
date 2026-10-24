<script setup>
import { computed } from 'vue'
import { CALORIE_SOURCE_LABEL } from '../lib/schema.js'

const props = defineProps({
  item: { type: Object, required: true },
})

const CATEGORY_EMOJI = { 主食: '🍔', 小食: '🍟', 饮品: '🥤', 甜品: '🍦' }

const emoji = computed(() => CATEGORY_EMOJI[props.item.category] || '🍽️')
const qty = computed(() => props.item.quantity || 1)

const sourceClass = computed(() => {
  switch (props.item.calorie_source) {
    case 'official': return 'is-official'
    case 'estimated': return 'is-estimated'
    default: return 'is-unknown'
  }
})
const sourceLabel = computed(
  () => CALORIE_SOURCE_LABEL[props.item.calorie_source] || CALORIE_SOURCE_LABEL.unknown
)
</script>

<template>
  <article class="item">
    <div class="item__img">
      <img v-if="item.image" :src="item.image" :alt="item.name" loading="lazy" />
      <span v-else class="item__emoji">{{ emoji }}</span>
      <span v-if="qty > 1" class="item__qty">×{{ qty }}</span>
    </div>

    <div class="item__body">
      <div class="item__top">
        <h4 class="item__name">{{ item.name }}</h4>
        <span class="item__cat">{{ item.category }}</span>
      </div>

      <div class="item__tags">
        <span v-for="t in item.tags" :key="t" class="tag">{{ t }}</span>
      </div>

      <div class="item__meta">
        <span class="price">¥{{ item.price.toFixed(1) }}</span>
        <span class="kcal">
          {{ item.calorie == null ? '—' : item.calorie }} kcal
          <span class="src" :class="sourceClass">{{ sourceLabel }}</span>
        </span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.item {
  display: flex; gap: 12px; padding: 12px; background: var(--card);
  border: 1px solid var(--border); border-radius: 14px;
}
.item__img {
  position: relative; flex: 0 0 64px; width: 64px; height: 64px;
  border-radius: 12px; overflow: hidden; background: var(--wash);
  display: flex; align-items: center; justify-content: center;
}
.item__img img { width: 100%; height: 100%; object-fit: cover; }
.item__emoji { font-size: 30px; }
.item__qty {
  position: absolute; right: 4px; bottom: 4px; background: var(--brand);
  color: #fff; font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 999px;
}
.item__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.item__top { display: flex; align-items: center; gap: 8px; }
.item__name { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink-primary); }
.item__cat { font-size: 11px; color: var(--ink-muted); background: var(--wash); padding: 2px 8px; border-radius: 999px; flex: 0 0 auto; }

.item__tags { display: flex; gap: 4px; flex-wrap: wrap; }
.tag { font-size: 11px; color: var(--ink-secondary); background: var(--wash-2); padding: 1px 7px; border-radius: 6px; }

.item__meta { display: flex; align-items: center; gap: 12px; margin-top: auto; }
.price { font-size: 16px; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }
.kcal { font-size: 13px; color: var(--ink-secondary); display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.src { font-size: 11px; padding: 1px 7px; border-radius: 999px; font-weight: 600; }
.src.is-official { color: #0a6b2f; background: #e3f6ea; }
.src.is-estimated { color: #8a5a00; background: #fff3d6; }
.src.is-unknown { color: #8a2b2b; background: #f7e8e8; }
</style>
