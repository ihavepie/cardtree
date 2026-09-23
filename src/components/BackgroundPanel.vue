<script setup>
import { store, setBg, randomBg, clearBg, addBackground, removeBackground, saveVideoBlob, toast } from '../store.js'
import Icon from './Icon.vue'

function bgStyleOf(item) {
  if (item.type === 'image') {
    return { backgroundImage: `url(${item.dataUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  }
  if (item.type === 'video') {
    return { background: 'linear-gradient(160deg, #1e293b, #0f172a)' }
  }
  return {}
}

function askName(fallback) {
  return prompt('给这个背景取个名字', fallback) || fallback
}

function onUploadImage(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  const url = URL.createObjectURL(file)
  const img = new Image()
  img.onload = () => {
    const maxW = 1920
    const scale = Math.min(1, maxW / img.width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * scale)
    canvas.height = Math.round(img.height * scale)
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    URL.revokeObjectURL(url)
    const name = askName('图片 ' + (store.customBackgrounds.length + 1))
    const item = addBackground(name, 'image', { dataUrl })
    setBg({ type: 'custom', id: item.id })
  }
  img.onerror = () => {
    URL.revokeObjectURL(url)
    toast('图片加载失败', 'warning')
  }
  img.src = url
  e.target.value = ''
}

async function onUploadVideo(e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  const name = askName('视频')
  try {
    const videoId = await saveVideoBlob(file)
    const item = addBackground(name, 'video', { videoId })
    setBg({ type: 'custom', id: item.id })
  } catch (err) {
    toast('视频保存失败', 'warning')
  }
  e.target.value = ''
}
</script>

<template>
  <div class="bg-panel-overlay" @mousedown.self="store.bgPanelOpen = false">
    <div class="bg-panel">
      <div class="bg-panel-head">
        <span>背景设置</span>
        <button class="icon-btn" title="关闭" @click="store.bgPanelOpen = false">✕</button>
      </div>

      <!-- 我的背景栏位 -->
      <div class="bg-section-title">我的背景</div>
      <div class="bg-images">
        <div
          v-for="item in store.customBackgrounds"
          :key="item.id"
          class="bg-image"
          :class="{ active: store.bg?.type === 'custom' && store.bg.id === item.id }"
          :style="bgStyleOf(item)"
          :title="item.name"
          @click="setBg({ type: 'custom', id: item.id })"
        >
          <span v-if="item.type === 'video'" class="bg-image-icon">▶</span>
          <span class="bg-image-name">{{ item.name }}</span>
          <button class="bg-image-del" title="删除" @click.stop="removeBackground(item.id)">✕</button>
        </div>
        <div v-if="!store.customBackgrounds.length" class="bg-empty-hint">还没有背景，上传图片或视频开始</div>
      </div>

      <!-- 添加背景 -->
      <div class="bg-section-title">添加背景</div>
      <div class="bg-add-btns">
        <label class="btn">
          上传图片
          <input type="file" accept="image/*" hidden @change="onUploadImage" />
        </label>
        <label class="btn">
          上传视频
          <input type="file" accept="video/*" hidden @change="onUploadVideo" />
        </label>
      </div>

      <div class="bg-actions">
        <button class="btn" @click="randomBg"><Icon name="shuffle" :size="14" /> 随机</button>
        <button v-if="store.bg" class="btn" @click="clearBg">恢复默认</button>
      </div>
    </div>
  </div>
</template>
