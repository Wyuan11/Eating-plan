<script setup>
defineProps({
  original_price: { type: Number, required: true },
  total_price: { type: Number, required: true },
  saved: { type: Number, required: true },
})
</script>

<template>
  <div class="savings">
    <div class="savings__main">
      <span class="savings__label">原价 <s>¥{{ original_price.toFixed(1) }}</s></span>
      <span class="savings__arrow">→</span>
      <span class="savings__now">现价 ¥{{ total_price.toFixed(1) }}</span>
    </div>
    <div class="savings__save" v-if="saved > 0">
      已省 <strong>¥{{ saved.toFixed(1) }}</strong>
    </div>
  </div>
</template>

<style scoped>
.savings {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  background: linear-gradient(135deg, #fff7e6, #fff0f0);
  border: 1px solid #f3ddA0; border-radius: 14px; padding: 12px 16px;
}
.savings__main { display: flex; align-items: center; gap: 10px; font-size: 14px; }
.savings__label { color: var(--ink-muted); }
.savings__label s { color: var(--ink-muted); }
.savings__arrow { color: var(--ink-muted); }
.savings__now { font-weight: 700; color: var(--ink-primary); font-variant-numeric: tabular-nums; }
.savings__save {
  font-size: 14px; color: #a31212; background: #fff; border-radius: 999px;
  padding: 6px 14px; font-weight: 600;
}
.savings__save strong { font-size: 18px; font-variant-numeric: tabular-nums; }
</style>
