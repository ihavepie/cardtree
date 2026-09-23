import { createApp } from 'vue'
import './styles.css'
import App from './App.vue'
import { init } from './store.js'
import { setupDragListeners } from './drag.js'

setupDragListeners()
init()
createApp(App).mount('#app')
