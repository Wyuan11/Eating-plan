<script setup>
import { computed, ref, watch } from 'vue'

/**
 * 总菜单选菜面板：数据来自后端 GET /api/menu（本地菜单快照，前端不直连 MCP）。
 * 用户从这里把单品加进当前方案，加完后由 ResultView 统一重算校验——
 * 红线：前端只做「选择 + 算术校验」，不做推荐决策，推荐仍归 Skill/solver。
 */
const props = defineProps({
  storeCode: { type: String, default: '' },
})
const emit = defineEmits(['add'])

const items = ref([])
const loading = ref(false)
const error = ref(null)
const loaded = ref(false)
const search = ref('')
const cat = ref('全部')

const CATS = ['全部', '主食', '小食', '饮品', '甜品']
const CAT_EMOJI = { 主食: '🍔', 小食: '🍟', 饮品: '🥤', 甜品: '🍦' }

watch(
  () => props.open,
  async (open) => {
    if (!open || loaded.value) return
    loading.value = true
    error.value = null
    try {
      const qs = props.storeCode ? `?storeCode=${encodeURIComponent(props.storeCode)}` : ''
      const res = await fetch(`/api/menu${qs}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      items.value = (data.items || []).filter((i) => i.kind === 'single' && i.available !== false)
      loaded.value = true
    } catch (e) {
      error.value = '菜单加载失败：' + (e?.message || '未知错误')
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)

const filtered = computed(() => {
  const kw = search.value.trim()
  return items.value.filter((i) => {
    if (cat.value !== '全部' && i.category !== cat.value) return false
    if (kw && !i.name.includes(kw) && !(i.tags || []).some((t) => t.includes(kw))) return false
    return true
  })
})
</script>

<template>
  <section class="picker">
    <div class="picker__bar">
      <input v-model="search" class="picker__search" type="search" placeholder="搜菜单：汉堡 / 鸡 / 可乐…" />
      <div class="picker__cats">
        <button
          v-for="c in CATS" :key="c" type="button" class="picker__cat"
          :class="{ active: cat === c }" @click="cat = c"
        >{{ c }}</button>
      </div>
    </div>

    <p v-if="loading" class="picker__state">菜单加载中…</p>
    <p v-else-if="error" class="picker__state picker__state--err">{{ error }}</p>
    <p v-else-if="!filtered.length" class="picker__state">没有匹配的商品</p>

    <ul v-else class="picker__list">
      <li v-for="i in filtered" :key="i.code" class="picker__row">
        <span class="picker__emoji">{{ CAT_EMOJI[i.category] || '🍽️' }}</span>
        <span class="picker__name" :title="i.name">{{ i.name }}</span>
        <span v-if="i.calorie_source !== 'official'" class="picker__warn" title="该商品官方热量未公布">热量未知</span>
        <span class="picker__kcal">{{ i.calorie == null ? '—' : i.calorie }} kcal</span>
        <span class="picker__price">¥{{ Number(i.price).toFixed(1) }}</span>
        <button class="picker__add" type="button" @click="emit('add', i)">＋ 加入</button>
      </li>
    </ul>
    <p class="picker__note">加入后金额与热量实时重算；超预算 / 超热量上限会被拦截提示。</p>
  </section>
</template>

<style scoped>
.picker {
  border: 1px dashed var(--border); border-radius: 14px; padding: 12px;
  background: var(--wash);
}
.picker__bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.picker__search {
  flex: 1 1 180px; min-width: 140px; padding: 7px 10px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--card); font: inherit; font-size: 13px;
}
.picker__cats { display: flex; gap: 4px; flex-wrap: wrap; }
.picker__cat {
  padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--card); font: inherit; font-size: 12px; cursor: pointer; color: var(--ink-secondary);
}
.picker__cat.active { border-color: var(--brand); background: var(--brand); color: #fff; font-weight: 600; }

.picker__state { margin: 8px 0; font-size: 13px; color: var(--ink-muted); }
.picker__state--err { color: #a31212; }

.picker__list {
  list-style: none; margin: 0; padding: 0; max-height: 300px; overflow-y: auto;
  display: flex; flex-direction: column; gap: 4px;
}
.picker__row {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px;
  background: var(--card); border: 1px solid var(--border); border-radius: 10px; font-size: 13px;
}
.picker__emoji { flex: 0 0 auto; }
.picker__name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-primary); font-weight: 500; }
.picker__warn { flex: 0 0 auto; font-size: 11px; color: #8a2b2b; background: #f7e8e8; padding: 1px 7px; border-radius: 999px; }
.picker__kcal { flex: 0 0 auto; color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.picker__price { flex: 0 0 auto; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }
.picker__add {
  flex: 0 0 auto; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--brand);
  background: var(--brand); color: #fff; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
}
.picker__note { margin: 10px 0 0; font-size: 11.5px; color: var(--ink-muted); }
</style>
