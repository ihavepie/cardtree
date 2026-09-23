import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 相对路径 base：产物可直接作为 chrome-extension 解压加载。
export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 600,
    // 扩展本地加载：用固定文件名，避免旧 index.html 引用被 emptyOutDir 删除的哈希文件而 404
    rollupOptions: {
      output: {
        entryFileNames: 'assets/index.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
})
