import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 前端只认 /api/*：后端（成员 A 的 server/api.js）起来后监听 3000，
// Vite 把 /api 代理过去；后端不在线时前端自动回退到内置 mock 数据。
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
