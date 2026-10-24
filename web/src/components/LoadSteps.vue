<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

// 分步 loading：定位门店 → 拉菜单 → 匹配营养 → 求解。自带动画，父组件只负责显示/隐藏。
const STEPS = ['定位附近门店', '拉取官方菜单', '匹配营养数据', '求解最优组合']
const step = ref(0)
let timer = null

onMounted(() => {
  timer = setInterval(() => {
    if (step.value < STEPS.length - 1) step.value++
  }, 700)
})
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div class="load">
    <div class="load__spinner" aria-hidden="true"></div>
    <ul class="load__steps">
      <li
        v-for="(s, i) in STEPS"
        :key="s"
        :class="{ done: i < step, active: i === step }"
      >
        <span class="load__dot">
          <span v-if="i < step">✓</span>
        </span>
        {{ s }}
      </li>
    </ul>
  </div>
</template>

<style scoped>
.load { display: flex; flex-direction: column; align-items: center; gap: 22px; padding: 48px 0; }
.load__spinner {
  width: 40px; height: 40px; border-radius: 50%;
  border: 4px solid var(--wash-2); border-top-color: var(--brand);
  animation: spin .8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.load__steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.load__steps li {
  display: flex; align-items: center; gap: 10px; font-size: 14px;
  color: var(--ink-muted); transition: color .2s;
}
.load__steps li.done { color: var(--ink-secondary); }
.load__steps li.active { color: var(--ink-primary); font-weight: 600; }
.load__dot {
  width: 20px; height: 20px; border-radius: 50%; flex: 0 0 auto;
  border: 2px solid var(--border); display: flex; align-items: center; justify-content: center;
  font-size: 11px; color: #fff; transition: all .2s;
}
.load__steps li.done .load__dot { background: var(--status-good); border-color: var(--status-good); }
.load__steps li.active .load__dot {
  border-color: var(--brand); border-top-color: transparent;
  animation: spin .7s linear infinite;
}
</style>
