import { createApp } from 'vue'
import './styles.css'
import App from './App.vue'
import { init, applyTheme, store } from './store.js'
import { setupDragListeners } from './drag.js'

setupDragListeners()
// 挂载前先落主题：深色用户刷新时不会先闪一下白（初值取自 localStorage 同步镜像）
applyTheme(store.theme)
init()
createApp(App).mount('#app')
