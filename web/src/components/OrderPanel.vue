<script setup>
/**
 * 下单面板：把「当前方案」提交到 /api/order，拿到支付链接渲染二维码。
 *
 * 红线（不可绕过）：
 *  1. 只到 payH5Url 为止 —— 渲染二维码 + 可点击链接，绝不自动跳转、绝不自动支付；
 *  2. mock:true 是唯一能拿到假订单的入口，拿到后必须自曝「演示订单」徽章；
 *  3. 价格发生变化（409 PRICE_CHANGED）时后端已拦下不下单，这里如实展示两个价格。
 */
import { computed, ref, watch } from 'vue'
import { createOrder } from '../lib/api.js'
import QRCode from 'qrcode'

const props = defineProps({
  /** 当前方案的菜品（含手动微调后的数量） */
  items: { type: Array, default: () => [] },
  storeCode: { type: String, default: '' },
  /** 校验未通过（超预算/超热量）时禁止下单 */
  disabled: { type: Boolean, default: false },
  disabledReason: { type: String, default: null },
})

const loading = ref(false)
const order = ref(null)
const error = ref(null)
const priceCheck = ref(null)
const isMock = ref(false)
const qr = ref('')

const count = computed(() => props.items.reduce((n, i) => n + (i.quantity || 1), 0))
const total = computed(() =>
  Math.round(props.items.reduce((s, i) => s + (i.price || 0) * (i.quantity || 1), 0) * 10) / 10
)

// 换方案 / 改数量后，旧订单信息失效，回到未下单状态
watch(
  () => props.items.map((i) => `${i.code}:${i.quantity || 1}`).join('|'),
  () => {
    order.value = null
    error.value = null
    priceCheck.value = null
    isMock.value = false
    qr.value = ''
  }
)

async function drawQr(url) {
  try {
    qr.value = await QRCode.toDataURL(url, { width: 208, margin: 1, errorCorrectionLevel: 'M' })
  } catch {
    qr.value = '' // 画不出来就只给链接，不伪造二维码
  }
}

async function placeOrder(useMock = false) {
  if (loading.value || props.disabled || !props.items.length) return
  loading.value = true
  error.value = null
  order.value = null
  priceCheck.value = null
  isMock.value = false
  qr.value = ''
  try {
    const payload = {
      storeCode: props.storeCode,
      beType: 1, // 到店自取：账号为空号（无配送地址），这是唯一可走的就餐方式
      orderType: 1,
      items: props.items.map((i) => ({ code: i.code, quantity: i.quantity || 1 })),
    }
    if (useMock) payload.mock = true
    const { status, body } = await createOrder(payload)
    priceCheck.value = body?.price_check || null
    if (status === 200 && body?.success && body.order) {
      order.value = body.order
      isMock.value = body.meta?.source === 'mock'
      if (body.order.payH5Url) await drawQr(body.order.payH5Url)
    } else {
      error.value = body?.error || { code: 'UNKNOWN', detail: `下单失败（HTTP ${status}）` }
    }
  } catch (e) {
    error.value = { code: 'NETWORK', detail: '未连接后端 /api/order：' + (e?.message || '未知错误') }
  } finally {
    loading.value = false
  }
}

/** 按后端错误码给前端话术；不认识就原样显示 detail，不瞎猜 */
const errorHint = computed(() => {
  const c = error.value?.code
  if (c === 'PRICE_CHANGED') return '实时价与方案价不一致，后端已拦下未下单。确认后可重新求解再下单。'
  if (c === 'MCP_UNAVAILABLE') return 'MCP 不可用（通常是未配置 Token）。可用演示订单继续走通流程。'
  if (c === 'NO_TAKEWAY') return '该门店未返回可取餐方式，无法下单。'
  if (c === 'MCP_TOOL_ERROR') return '麦当劳接口返回异常，请稍后重试。'
  return error.value?.detail || ''
})
const canMock = computed(() => error.value?.code === 'MCP_UNAVAILABLE')
</script>

<template>
  <section class="card order">
    <h3 class="card__title">下单（到店自取）</h3>

    <p class="order__sum">
      按当前方案下单：<strong>{{ count }} 件 · ¥{{ total.toFixed(1) }}</strong>
      <span v-if="total !== Math.round(total)" class="order__sum-note"></span>
    </p>

    <div class="order__actions">
      <button
        class="order__btn"
        type="button"
        :disabled="disabled || loading || !items.length"
        @click="placeOrder(false)"
      >
        {{ loading ? '正在核价并下单…' : '生成支付链接' }}
      </button>
      <span v-if="disabled && disabledReason" class="order__blocked">{{ disabledReason }}</span>
    </div>

    <p class="order__redline">
      🔒 只生成支付链接（二维码 + 可点击链接），<strong>不自动跳转、不自动支付</strong>；演示到此为止。
    </p>

    <!-- 失败：按错误码给针对性提示 -->
    <div v-if="error" class="order__err" role="alert">
      <div class="order__err-head">
        <strong>下单未完成</strong>
        <code>{{ error.code }}</code>
      </div>
      <p>{{ errorHint }}</p>
      <div v-if="priceCheck" class="order__price">
        方案价 ¥{{ priceCheck.expected }} → 实时价 ¥{{ priceCheck.actual }}
      </div>
      <button v-if="canMock" class="order__btn order__btn--ghost" type="button" :disabled="loading" @click="placeOrder(true)">
        改用演示订单（mock，不真实下单）
      </button>
    </div>

    <!-- 成功：订单信息 + 二维码 -->
    <div v-if="order" class="order__done">
      <div v-if="isMock" class="order__mockbadge">🧪 演示订单（mock）· 非真实下单</div>
      <dl class="order__meta">
        <div><dt>订单号</dt><dd>{{ order.orderId }}</dd></div>
        <div><dt>金额</dt><dd class="order__price-strong">¥{{ order.total_price }}</dd></div>
        <div><dt>状态</dt><dd>{{ order.orderStatus || '待支付' }}</dd></div>
        <div v-if="order.expireAt"><dt>支付截止</dt><dd>{{ order.expireAt }}</dd></div>
      </dl>

      <div v-if="qr" class="order__qr">
        <img :src="qr" alt="支付二维码" />
        <p class="order__qr-tip">扫码支付（演示不付款，订单会自动失效）</p>
      </div>
      <div v-else-if="order.payH5Url" class="order__qr">
        <p class="order__qr-tip">二维码渲染失败，可直接打开链接</p>
      </div>
      <div v-else class="order__qr">
        <p class="order__qr-tip">接口未返回支付链接（payH5Url 为空）—— 不伪造二维码</p>
      </div>

      <a
        v-if="order.payH5Url"
        class="order__link"
        :href="order.payH5Url"
        target="_blank"
        rel="noopener noreferrer"
      >在新标签页打开支付页 ↗</a>
    </div>
  </section>
</template>

<style scoped>
.order { display: flex; flex-direction: column; gap: 12px; }
.order__sum { margin: 0; font-size: 13.5px; color: var(--ink-secondary); }
.order__sum strong { color: var(--ink-primary); }

.order__actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.order__btn {
  padding: 9px 18px; border-radius: 10px; border: 1px solid var(--brand);
  background: var(--brand); color: #fff; font: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer;
}
.order__btn:hover:not(:disabled) { filter: brightness(1.05); }
.order__btn:disabled { background: var(--wash); border-color: var(--border); color: var(--ink-muted); cursor: not-allowed; }
.order__btn--ghost { background: var(--card); color: var(--brand); font-weight: 600; }
.order__blocked { font-size: 12.5px; color: var(--status-critical); }

.order__redline { margin: 0; font-size: 12px; color: var(--ink-muted); line-height: 1.6; }

.order__err {
  padding: 12px 14px; border-radius: 12px; background: #ffe3e1; border: 1px solid #f3b6b3; color: #a31212;
  display: flex; flex-direction: column; gap: 8px; align-items: flex-start;
}
.order__err-head { display: flex; align-items: center; gap: 8px; font-size: 13.5px; }
.order__err-head code {
  font-size: 11.5px; background: rgba(0, 0, 0, .06); padding: 2px 6px; border-radius: 6px; color: #7a1010;
}
.order__err p { margin: 0; font-size: 13px; line-height: 1.6; }
.order__price { font-size: 13px; font-variant-numeric: tabular-nums; }

.order__done { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.order__mockbadge {
  font-size: 12px; font-weight: 700; color: #8a5a00; background: #fff3d6;
  border-radius: 999px; padding: 4px 10px;
}
.order__meta { margin: 0; display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 13px; }
.order__meta div { display: flex; align-items: baseline; gap: 6px; }
.order__meta dt { color: var(--ink-muted); }
.order__meta dd { margin: 0; color: var(--ink-primary); font-weight: 600; word-break: break-all; }
.order__price-strong { color: var(--brand) !important; font-size: 15px; }

.order__qr { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.order__qr img {
  width: 208px; height: 208px; border-radius: 12px; border: 1px solid var(--border);
  background: #fff; padding: 6px;
}
.order__qr-tip { margin: 0; font-size: 12px; color: var(--ink-muted); }

.order__link { font-size: 13px; color: var(--brand); font-weight: 600; text-decoration: none; }
.order__link:hover { text-decoration: underline; }
</style>
