<script setup>
import { onMounted, ref } from 'vue'
import { getStores, submitPlan } from './lib/api.js'
import ConstraintForm from './components/ConstraintForm.vue'
import ResultView from './components/ResultView.vue'
import LoadSteps from './components/LoadSteps.vue'

const stores = ref([])
const storesMock = ref(false)
const city = ref('上海')
const keyword = ref('')
const storesSource = ref(null) // 'live' | 'snapshot' | 'mock'
const loading = ref(false)
const result = ref(null)
const mock = ref(false)
const fallbackReason = ref(null)
const error = ref(null)

async function loadStores() {
  const r = await getStores({ city: city.value, keyword: keyword.value })
  stores.value = r.data || []
  storesMock.value = r.mock
  storesSource.value = r.mock
    ? 'mock'
    : (r.meta?.source || '').includes('live') ? 'live' : 'snapshot'
}

onMounted(loadStores)

// 门店定位区：城市/关键词变化或点「定位」后重拉附近门店
function onStoreSearch(p) {
  if (p && p.city != null) city.value = p.city
  if (p && p.keyword != null) keyword.value = p.keyword
  loadStores()
}

// 防重提交：loading 期间忽略再次点击
async function onSubmit(payload) {
  if (loading.value) return
  loading.value = true
  result.value = null
  error.value = null
  mock.value = false
  fallbackReason.value = null
  try {
    const r = await submitPlan(payload)
    result.value = r.data
    mock.value = r.mock
    fallbackReason.value = r.fallbackReason || null
  } catch (e) {
    error.value = '求解失败：' + (e?.message || '未知错误')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="app">
    <header class="header">
      <div class="header__inner">
        <div class="brand">
          <span class="brand__logo">🍔</span>
          <div class="brand__text">
            <h1>麦门智选助手</h1>
            <p>控卡 × 省钱 × 忌口 · 四维约束求解</p>
          </div>
        </div>
        <div class="header__badge" title="数据来自麦当劳官方 MCP">
          <span class="header__dot"></span> 麦当劳官方 MCP 数据
        </div>
      </div>
    </header>

    <main class="layout">
      <aside class="layout__form">
        <ConstraintForm
          :stores="stores"
          :stores-mock="storesMock"
          :city="city"
          :keyword="keyword"
          :stores-source="storesSource"
          :loading="loading"
          @submit="onSubmit"
          @store-search="onStoreSearch"
        />
      </aside>

      <section class="layout__content">
        <!-- 加载态 -->
        <div v-if="loading" class="card state">
          <LoadSteps />
        </div>

        <!-- 错误态 -->
        <div v-else-if="error" class="card state">
          <div class="state__icon">😵</div>
          <h3>出错了</h3>
          <p>{{ error }}</p>
        </div>

        <!-- 参数错误态：与"无解"必须分开，否则用户以为自己预算不合理 -->
        <div v-else-if="result && result.status === 'error'" class="card state state--nosolution">
          <div class="state__icon">⚠️</div>
          <h3>请求参数有问题</h3>
          <p class="state__reason">{{ result.error?.detail || result.message }}</p>
          <div v-if="result.error?.code" class="state__conflict">
            <span>错误码：</span>{{ result.error.code }}
          </div>
          <p v-if="mock" class="state__mock">🧪 内置演示数据 · 未连接后端 /api/plan</p>
        </div>

        <!-- 等待态：Skill 异步落盘时先占位，不要落到空态误导用户 -->
        <div v-else-if="result && result.status === 'pending'" class="card state">
          <div class="state__icon">⏳</div>
          <h3>方案生成中</h3>
          <p>Skill 正在求解，稍后自动刷新…</p>
        </div>

        <!-- 无解态 -->
        <div
          v-else-if="result && (result.status === 'nosolution' || (result.success === false && !result.error))"
          class="card state state--nosolution"
        >
          <div class="state__icon">🤔</div>
          <h3>暂时凑不出可行方案</h3>
          <p class="state__reason">{{ result.reason }}</p>
          <div v-if="result.conflict" class="state__conflict">
            <span>冲突点：</span>{{ result.conflict }}
          </div>
          <div v-if="result.hint" class="state__hint">
            <span>💡 放宽建议：</span>{{ result.hint }}
          </div>
          <p v-if="mock" class="state__mock">🧪 内置演示数据 · 未连接后端 /api/plan</p>
        </div>

        <!-- 结果态 -->
        <ResultView
          v-else-if="result && (result.status === 'success' || (result.success === true && !result.status))"
          :result="result"
          :mock="mock"
          :fallback-reason="fallbackReason"
        />

        <!-- 空态 -->
        <div v-else class="card state state--idle">
          <div class="state__icon">🥗</div>
          <h2>一顿又省又低卡的麦当劳，AI 帮你算</h2>
          <p>在左侧输入预算、人数、忌口（或一句话点单），<br />AI 在 Skill 内调用官方菜单与营养数据，求出最优点单组合。</p>
          <ul class="state__features">
            <li>🎯 预算 · 热量 · 忌口 · 人数 四维约束</li>
            <li>🔬 热量全部来自官方营养表，可核验</li>
            <li>🧮 前端独立重算校验，AI 算错会自动修正</li>
          </ul>
        </div>
      </section>
    </main>

    <footer class="footer">
      麦门智选助手 · WayToAGI 1024 AI 切磋大会（用餐赛道） · 演示到生成方案为止，不真实下单
    </footer>
  </div>
</template>

<style scoped>
.header {
  position: sticky; top: 0; z-index: 20; background: rgba(255,255,255,.9);
  backdrop-filter: blur(10px); border-bottom: 1px solid var(--border);
}
.header__inner {
  max-width: 1120px; margin: 0 auto; padding: 12px 20px;
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
}
.brand { display: flex; align-items: center; gap: 12px; }
.brand__logo {
  width: 42px; height: 42px; border-radius: 12px; background: var(--brand);
  display: flex; align-items: center; justify-content: center; font-size: 22px;
  box-shadow: 0 4px 12px rgba(218,41,28,.28);
}
.brand__text h1 { margin: 0; font-size: 18px; font-weight: 800; color: var(--ink-primary); line-height: 1.2; }
.brand__text p { margin: 2px 0 0; font-size: 12px; color: var(--ink-muted); }

.header__badge {
  display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink-secondary);
  background: var(--wash); padding: 6px 12px; border-radius: 999px; white-space: nowrap;
}
.header__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--status-good); box-shadow: 0 0 0 3px rgba(12,163,12,.15); }

.layout {
  max-width: 1120px; margin: 0 auto; padding: 24px 20px 40px;
  display: grid; grid-template-columns: 360px 1fr; gap: 24px; align-items: start;
}
.layout__form {
  position: sticky; top: 84px;
}

.card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 20px; }

.state { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 48px 24px; }
.state__icon { font-size: 44px; }
.state h2 { margin: 4px 0 0; font-size: 20px; font-weight: 800; color: var(--ink-primary); }
.state h3 { margin: 0; font-size: 18px; font-weight: 700; color: var(--ink-primary); }
.state p { margin: 0; color: var(--ink-secondary); font-size: 14px; line-height: 1.6; }

.state__features { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.state__features li {
  font-size: 13px; color: var(--ink-secondary); text-align: left;
  background: var(--wash); padding: 8px 12px; border-radius: 10px;
}

.state--nosolution .state__reason { color: var(--ink-primary); font-weight: 600; max-width: 480px; }
.state__conflict, .state__hint {
  max-width: 520px; text-align: left; font-size: 13.5px; padding: 10px 14px; border-radius: 10px; line-height: 1.6;
}
.state__conflict { background: #ffe3e1; color: #a31212; }
.state__hint { background: #e3f6ea; color: #0a6b2f; }
.state__conflict span, .state__hint span { font-weight: 700; }
.state__mock { font-size: 12px; color: var(--ink-muted); }

.footer {
  max-width: 1120px; margin: 0 auto; padding: 20px; text-align: center;
  font-size: 12px; color: var(--ink-muted);
}

@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; }
  .layout__form { position: static; }
  .header__badge { display: none; }
}
</style>
