import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitepress';

const { version } = JSON.parse(readFileSync(new URL('../packages/logline/package.json', import.meta.url), 'utf8'));

/** Publish both languages at the project Pages path; VitePress rejects broken links during build. */
export default defineConfig({
  title: 'Logline',
  description: 'Structured frontend logging for JavaScript and TypeScript.',
  base: '/logline/',
  srcDir: '.docs-site',
  cleanUrls: false,
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [{ text: `v${version}`, link: '/docs/migration-v2' }],
        sidebar: [
          {
            text: 'Guide',
            items: [
              { text: 'Getting started', link: '/' },
              { text: 'IndexedDB persistence', link: '/docs/indexeddb' },
              { text: 'Click logging', link: '/docs/click-log' },
              { text: 'Asynchronous reporting', link: '/docs/reporting' },
              { text: 'Ingestion API', link: '/docs/server-ingestion' },
              { text: 'Administration', link: '/docs/server-admin' },
              { text: 'Logs Explorer', link: '/docs/server-explorer' },
              { text: 'MCP tools', link: '/docs/server-mcp' },
              { text: 'Self-hosting and performance', link: '/docs/server-operations' },
              { text: 'Migration', link: '/docs/migration-v2' },
              { text: 'Workspace development', link: '/docs/workspace' },
              { text: 'Release flow', link: '/docs/release-flow' },
            ],
          },
        ],
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      themeConfig: {
        nav: [{ text: `v${version}`, link: '/zh/docs/migration-v2' }],
        sidebar: [
          {
            text: '指南',
            items: [
              { text: '快速开始', link: '/zh/' },
              { text: 'IndexedDB 持久化', link: '/zh/docs/indexeddb' },
              { text: '点击日志', link: '/zh/docs/click-log' },
              { text: '异步上报', link: '/zh/docs/reporting' },
              { text: '日志接收 API', link: '/zh/docs/server-ingestion' },
              { text: '管理 API', link: '/zh/docs/server-admin' },
              { text: '日志查询', link: '/zh/docs/server-explorer' },
              { text: 'MCP 工具', link: '/zh/docs/server-mcp' },
              { text: '部署和性能', link: '/zh/docs/server-operations' },
              { text: '迁移说明', link: '/zh/docs/migration-v2' },
              { text: 'Workspace 开发', link: '/zh/docs/workspace' },
              { text: '发布流程', link: '/zh/docs/release-flow' },
            ],
          },
        ],
      },
    },
  },
  themeConfig: {
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/tellok/logline' }],
  },
});
