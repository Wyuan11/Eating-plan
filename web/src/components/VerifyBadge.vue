<script setup>
defineProps({
  verified: { type: Boolean, required: true },
  note: { type: String, default: null },
})
</script>

<template>
  <div class="verify" :class="verified ? 'is-ok' : 'is-warn'" role="status">
    <span class="verify__icon">{{ verified ? '✓' : '!' }}</span>
    <span class="verify__text">
      <strong>{{ verified ? '已校验' : '已自动修正' }}</strong>
      <span v-if="!note" class="verify__sub">价格与热量逐项重算一致，可信</span>
      <span v-else class="verify__sub">{{ note }}</span>
    </span>
  </div>
</template>

<style scoped>
.verify {
  display: inline-flex; align-items: center; gap: 10px; padding: 10px 14px;
  border-radius: 12px; font-size: 13px;
}
.verify.is-ok { background: #e3f6ea; color: #0a6b2f; border: 1px solid #bfe6cd; }
.verify.is-warn { background: #fff3d6; color: #8a5a00; border: 1px solid #f3ddA0; }
.verify__icon {
  width: 22px; height: 22px; border-radius: 50%; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  font-weight: 800; color: #fff; font-size: 13px;
}
.is-ok .verify__icon { background: #0ca30c; }
.is-warn .verify__icon { background: #fab219; }
.verify__text { display: flex; flex-direction: column; line-height: 1.3; }
.verify__sub { font-size: 12px; opacity: .9; }
</style>
