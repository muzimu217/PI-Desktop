<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{ locale: string }>()
const isZh = computed(() => props.locale === 'zh-CN')

const shotSrc = '/hero-workspace.webp'
const loaded = ref(false)
watch(
  () => props.locale,
  () => {
    loaded.value = false
  }
)

const caption = computed(() =>
  isZh.value
    ? {
        title: '本地优先的智能体工作区',
        meta: '会话 · 子代理 · 文件 · 插件',
      }
    : {
        title: 'A local-first workspace for AI agents',
        meta: 'Sessions · subagents · files · plugins',
      }
)
</script>

<template>
  <div
    class="home-stage"
    :aria-label="isZh ? 'PI-Desktop 产品界面预览' : 'PI-Desktop product preview'"
  >
    <div class="home-stage__frame">
      <img
        class="home-stage__shot"
        :class="{ 'is-loaded': loaded }"
        :src="shotSrc"
        :alt="
          isZh
            ? 'PI-Desktop 多智能体协作与文件管理工作区截图'
            : 'PI-Desktop multi-agent workspace with file manager screenshot'
        "
        width="1800"
        height="1012"
        decoding="async"
        fetchpriority="high"
        @load="loaded = true"
      />
    </div>
    <div class="home-stage__caption">
      <strong>{{ caption.title }}</strong>
      <span>{{ caption.meta }}</span>
    </div>
  </div>
</template>
