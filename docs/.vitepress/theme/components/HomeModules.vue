<script setup lang="ts">
import { computed } from 'vue'

type Locale = 'root' | 'zh-CN' | string

const props = defineProps<{ locale: Locale }>()
const isZh = computed(() => props.locale === 'zh-CN')
const localeFolder = computed(() => (isZh.value ? 'zh' : 'en'))

const copy = computed(() =>
  isZh.value
    ? {
        tourLabel: '产品一览',
        tourTitle: '看见真实的工作区，而不是概念图。',
        tourIntro:
          '首页展示的是 PI-Desktop 真实界面：会话、面板、插件、检索和模型配置都在同一套桌面环境里。',
        tour: [
          {
            slug: 'home-light',
            title: '工作区首页',
            meta: 'workspace',
            text: '项目、会话与编排状态集中在一个持续存在的桌面环境里。',
            link: '/zh-CN/guide/screenshots',
            feature: true,
          },
          {
            slug: 'panel-files',
            title: '文件与预览面板',
            meta: 'panels',
            text: '侧栏文件、浏览器与评审面板并排工作，不依赖单一 IDE。',
            link: '/zh-CN/guide/screenshots',
          },
          {
            slug: 'plugins-live',
            title: '插件运行时',
            meta: 'plugins',
            text: '插件不只是工具：可以扩展面板、视图、服务与 MCP。',
            link: '/zh-CN/plugin-development',
          },
          {
            slug: 'search',
            title: '全局检索',
            meta: 'search',
            text: '在会话、页面与设置之间快速定位上下文。',
            link: '/zh-CN/guide/screenshots',
          },
          {
            slug: 'extensions-mcp',
            title: '扩展与 MCP',
            meta: 'extensions',
            text: '子代理、技能、MCP 与权限边界都可检查、可配置。',
            link: '/zh-CN/guide/mcp-market',
          },
          {
            slug: 'settings-models',
            title: '模型与供应商',
            meta: 'models',
            text: '模型可替换，供应商配置留在本地工作区内。',
            link: '/zh-CN/guide/',
          },
        ],
        journeyLabel: '按意图阅读',
        journeyTitle: '先回答你正在解决的问题。',
        intro:
          '这不是按文件堆叠的目录，而是一张帮助你定位、理解、修改和验证系统的地图。',
        journeys: [
          {
            index: '01',
            label: 'ORIENT',
            title: '建立产品模型',
            text: '先知道当前交付了什么、明确不做什么。',
            link: '/zh-CN/guide/',
          },
          {
            index: '02',
            label: 'TRACE',
            title: '追踪一次请求',
            text: '从 Renderer 走到 Electron、pi、Rust host 和 SQLite。',
            link: '/zh-CN/spec/02-architecture/01-architecture',
          },
          {
            index: '03',
            label: 'EXTEND',
            title: '开发一个插件',
            text: '从包格式、API、权限到生命周期逐步展开。',
            link: '/zh-CN/plugin-development',
          },
          {
            index: '04',
            label: 'SHIP',
            title: '验证一次变化',
            text: '把规格、实现、E2E 场景和交付记录连起来。',
            link: '/zh-CN/spec/06-delivery/README',
          },
        ],
        mapLabel: '系统边界',
        mapTitle: '四层职责，一条可读主线。',
        layers: [
          {
            name: 'Shell',
            detail: 'Electron',
            text: '桌面窗口、preload IPC、生命周期和平台能力。',
          },
          {
            name: 'Agent',
            detail: 'pi sidecar',
            text: '代理循环、工具调用、上下文与 provider-facing model work。',
          },
          {
            name: 'Host',
            detail: 'Rust core',
            text: '权限、进程、文件系统、RPC 和可取消的运行时边界。',
          },
          {
            name: 'State',
            detail: 'SQLite',
            text: '会话、配置、检查点、插件状态和持久化所有权。',
          },
        ],
        shelfLabel: '规格地图',
        shelfTitle: '按主题深入，而不是在文件树里迷路。',
        shelves: [
          {
            title: '产品',
            text: '范围、操作模式和非目标。',
            link: '/zh-CN/spec/01-product/README',
          },
          {
            title: '架构',
            text: '进程、数据和工程结构。',
            link: '/zh-CN/spec/02-architecture/README',
          },
          {
            title: '运行时',
            text: '协议、工具、host 和模型。',
            link: '/zh-CN/spec/03-runtime/README',
          },
          {
            title: '体验',
            text: '信息架构、国际化和交互。',
            link: '/zh-CN/spec/04-ux/README',
          },
          {
            title: '安全',
            text: '权限、路径和隔离边界。',
            link: '/zh-CN/spec/05-security/README',
          },
          {
            title: '交付',
            text: '验收、E2E 和发布。',
            link: '/zh-CN/spec/06-delivery/README',
          },
          {
            title: '插件',
            text: '扩展包、API 和生命周期。',
            link: '/zh-CN/spec/07-plugins/README',
          },
          {
            title: '决策',
            text: 'ADR、决策日志和开放问题。',
            link: '/zh-CN/spec/08-meta/README',
          },
        ],
        snapshotLabel: '实现快照',
        snapshotTitle: '当前文档描述的版本线。',
        snapshot: [
          ['应用版本线', '0.15.2'],
          ['Host wire protocol', 'v9'],
          ['Storage schema', 'v11'],
          ['文档源语言', 'EN / 中文'],
        ],
        footerTitle: '准备好进入代码库了吗？',
        footerText: '从快速开始建立上下文，或者直接打开规格索引。',
        footerPrimary: '开始阅读',
        footerSecondary: '查看规格索引',
        footerPrimaryLink: '/zh-CN/guide/',
        footerSecondaryLink: '/zh-CN/spec/README',
      }
    : {
        tourLabel: 'Product tour',
        tourTitle: 'See the real workspace — not a concept diagram.',
        tourIntro:
          'These are real PI-Desktop screens: sessions, panels, plugins, search, and model configuration in one persistent desktop environment.',
        tour: [
          {
            slug: 'home-light',
            title: 'Workspace home',
            meta: 'workspace',
            text: 'Projects, sessions, and orchestration state live in one persistent desktop environment.',
            link: '/guide/screenshots',
            feature: true,
          },
          {
            slug: 'panel-files',
            title: 'Files & preview panels',
            meta: 'panels',
            text: 'Work files, browser, and review side by side without a single IDE dependency.',
            link: '/guide/screenshots',
          },
          {
            slug: 'plugins-live',
            title: 'Plugin runtime',
            meta: 'plugins',
            text: 'Plugins extend more than tools — panels, views, services, and MCP.',
            link: '/plugin-development',
          },
          {
            slug: 'search',
            title: 'Global search',
            meta: 'search',
            text: 'Jump across sessions, pages, and settings without losing context.',
            link: '/guide/screenshots',
          },
          {
            slug: 'extensions-mcp',
            title: 'Extensions & MCP',
            meta: 'extensions',
            text: 'Subagents, skills, MCP, and permission boundaries stay inspectable.',
            link: '/guide/mcp-market',
          },
          {
            slug: 'settings-models',
            title: 'Models & providers',
            meta: 'models',
            text: 'Models stay replaceable. Provider configuration stays local.',
            link: '/guide/',
          },
        ],
        journeyLabel: 'Read by intent',
        journeyTitle: 'Start with the question you are solving.',
        intro:
          'This is not a file dump. It is a map for locating, understanding, changing, and validating the system.',
        journeys: [
          {
            index: '01',
            label: 'ORIENT',
            title: 'Build the product model',
            text: 'Know what is shipped and what is deliberately out of scope.',
            link: '/guide/',
          },
          {
            index: '02',
            label: 'TRACE',
            title: 'Trace one request',
            text: 'Follow the path through Renderer, Electron, pi, Rust host, and SQLite.',
            link: '/spec/02-architecture/01-architecture',
          },
          {
            index: '03',
            label: 'EXTEND',
            title: 'Build a plugin',
            text: 'Move from package format to API, permissions, and lifecycle.',
            link: '/plugin-development',
          },
          {
            index: '04',
            label: 'SHIP',
            title: 'Validate a change',
            text: 'Connect the spec, implementation, E2E scenario, and delivery record.',
            link: '/spec/06-delivery/README',
          },
        ],
        mapLabel: 'System boundaries',
        mapTitle: 'Four layers of responsibility. One readable thread.',
        layers: [
          {
            name: 'Shell',
            detail: 'Electron',
            text: 'Windows, preload IPC, lifecycle, and platform capabilities.',
          },
          {
            name: 'Agent',
            detail: 'pi sidecar',
            text: 'Agent loop, tools, context, and provider-facing model work.',
          },
          {
            name: 'Host',
            detail: 'Rust core',
            text: 'Permissions, processes, filesystem, RPC, and cancellation.',
          },
          {
            name: 'State',
            detail: 'SQLite',
            text: 'Sessions, configuration, checkpoints, plugins, and ownership.',
          },
        ],
        shelfLabel: 'Spec map',
        shelfTitle: 'Go deep by topic, not by getting lost in the file tree.',
        shelves: [
          {
            title: 'Product',
            text: 'Scope, modes, and non-goals.',
            link: '/spec/01-product/README',
          },
          {
            title: 'Architecture',
            text: 'Processes, data, and structure.',
            link: '/spec/02-architecture/README',
          },
          {
            title: 'Runtime',
            text: 'Protocols, tools, host, and models.',
            link: '/spec/03-runtime/README',
          },
          {
            title: 'Experience',
            text: 'IA, internationalization, and interaction.',
            link: '/spec/04-ux/README',
          },
          {
            title: 'Security',
            text: 'Permissions, paths, and isolation.',
            link: '/spec/05-security/README',
          },
          {
            title: 'Delivery',
            text: 'Acceptance, E2E, and release.',
            link: '/spec/06-delivery/README',
          },
          {
            title: 'Plugins',
            text: 'Packages, APIs, and lifecycle.',
            link: '/spec/07-plugins/README',
          },
          {
            title: 'Decisions',
            text: 'ADRs, decisions, and open questions.',
            link: '/spec/08-meta/README',
          },
        ],
        snapshotLabel: 'Implementation snapshot',
        snapshotTitle: 'The line this documentation describes.',
        snapshot: [
          ['Application line', '0.15.2'],
          ['Host wire protocol', 'v9'],
          ['Storage schema', 'v11'],
          ['Source languages', 'EN / 中文'],
        ],
        footerTitle: 'Ready to enter the codebase?',
        footerText:
          'Build context with the guide, or open the full specification index.',
        footerPrimary: 'Start reading',
        footerSecondary: 'Open spec index',
        footerPrimaryLink: '/guide/',
        footerSecondaryLink: '/spec/README',
      }
)

function shotSrc(slug: string) {
  return `/screenshots/app/${localeFolder.value}/${slug}.webp`
}
</script>

<template>
  <div class="home-modules">
    <section class="home-block home-block--tour" aria-labelledby="home-tour-title">
      <div class="home-block__heading">
        <div>
          <p class="home-kicker">{{ copy.tourLabel }}</p>
          <h2 id="home-tour-title">{{ copy.tourTitle }}</h2>
        </div>
        <p class="home-block__intro">{{ copy.tourIntro }}</p>
      </div>
      <div class="home-tour">
        <a
          v-for="shot in copy.tour"
          :key="shot.slug"
          class="home-shot"
          :class="{ 'home-shot--feature': shot.feature }"
          :href="shot.link"
        >
          <div class="home-shot__frame">
            <img
              :src="shotSrc(shot.slug)"
              :alt="shot.title"
              width="1600"
              height="1067"
              loading="lazy"
              decoding="async"
            />
          </div>
          <figcaption>
            <span class="home-shot__title">{{ shot.title }}</span>
            <span class="home-shot__meta">{{ shot.meta }}</span>
            <span class="home-shot__text">{{ shot.text }}</span>
          </figcaption>
        </a>
      </div>
    </section>

    <section
      class="home-block home-block--journeys"
      aria-labelledby="home-journeys-title"
    >
      <div class="home-block__heading">
        <div>
          <p class="home-kicker">{{ copy.journeyLabel }}</p>
          <h2 id="home-journeys-title">{{ copy.journeyTitle }}</h2>
        </div>
        <p class="home-block__intro">{{ copy.intro }}</p>
      </div>
      <div class="home-journeys">
        <a
          v-for="journey in copy.journeys"
          :key="journey.index"
          class="home-journey"
          :href="journey.link"
        >
          <span class="home-journey__index">{{ journey.index }}</span>
          <span class="home-journey__content">
            <span class="home-journey__label">{{ journey.label }}</span>
            <strong>{{ journey.title }}</strong>
            <span>{{ journey.text }}</span>
          </span>
          <span class="home-link-arrow" aria-hidden="true">→</span>
        </a>
      </div>
    </section>

    <section class="home-block home-block--map" aria-labelledby="home-map-title">
      <div class="home-block__heading home-block__heading--compact">
        <div>
          <p class="home-kicker">{{ copy.mapLabel }}</p>
          <h2 id="home-map-title">{{ copy.mapTitle }}</h2>
        </div>
      </div>
      <div class="home-spine" role="list">
        <div
          v-for="layer in copy.layers"
          :key="layer.name"
          class="home-layer"
          role="listitem"
        >
          <div class="home-layer__head">
            <span class="home-layer__name">{{ layer.name }}</span>
            <span class="home-layer__detail">{{ layer.detail }}</span>
          </div>
          <span class="home-layer__text">{{ layer.text }}</span>
        </div>
      </div>
    </section>

    <section
      class="home-block home-block--shelf"
      aria-labelledby="home-shelf-title"
    >
      <div class="home-block__heading">
        <div>
          <p class="home-kicker">{{ copy.shelfLabel }}</p>
          <h2 id="home-shelf-title">{{ copy.shelfTitle }}</h2>
        </div>
      </div>
      <div class="home-shelf">
        <a
          v-for="(shelf, index) in copy.shelves"
          :key="shelf.title"
          class="home-shelf__item"
          :href="shelf.link"
        >
          <span class="home-shelf__number">{{
            String(index + 1).padStart(2, '0')
          }}</span>
          <strong>{{ shelf.title }}</strong>
          <span>{{ shelf.text }}</span>
          <span class="home-link-arrow" aria-hidden="true">→</span>
        </a>
      </div>
    </section>

    <section class="home-snapshot" aria-labelledby="home-snapshot-title">
      <div>
        <p class="home-kicker">{{ copy.snapshotLabel }}</p>
        <h2 id="home-snapshot-title">{{ copy.snapshotTitle }}</h2>
      </div>
      <div class="home-snapshot__grid" role="list">
        <div v-for="item in copy.snapshot" :key="item[0]" role="listitem">
          <span>{{ item[0] }}</span>
          <strong>{{ item[1] }}</strong>
        </div>
      </div>
    </section>

    <section class="home-cta" aria-labelledby="home-cta-title">
      <div>
        <p class="home-kicker">PI-Desktop</p>
        <h2 id="home-cta-title">{{ copy.footerTitle }}</h2>
        <p>{{ copy.footerText }}</p>
      </div>
      <div class="home-cta__actions">
        <a class="home-button home-button--primary" :href="copy.footerPrimaryLink">{{
          copy.footerPrimary
        }}</a>
        <a
          class="home-button home-button--secondary"
          :href="copy.footerSecondaryLink"
          >{{ copy.footerSecondary }}</a
        >
      </div>
    </section>
  </div>
</template>
