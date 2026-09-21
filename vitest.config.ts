import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// DOM 组件测试套件（happy-dom 环境）。
// 命名约定 *.domtest.tsx：bun test 的发现模式 (*.test.* / *.spec.* / *_test.*)
// 不会匹配该后缀，保证 `bun test tests/` 主门禁与 vitest DOM 套件互不干扰。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/dom/**/*.domtest.{ts,tsx}']
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@agent': resolve(__dirname, 'src/main/agent'),
      // 与 electron.vite.config.ts 的 packageAliases 保持一致（1:1），
      // 否则 word 编辑器组件测试无法解析 @genoffice/* 导入
      '@genoffice/docx-engine': resolve(__dirname, 'src/packages/docx-engine'),
      '@genoffice/font-metrics': resolve(__dirname, 'src/packages/font-metrics'),
      '@genoffice/i18n': resolve(__dirname, 'src/packages/i18n'),
      '@genoffice/ui': resolve(__dirname, 'src/packages/ui'),
      '@genoffice/electron-utils': resolve(__dirname, 'src/packages/electron-utils'),
      '@genoffice/agent-core': resolve(__dirname, 'src/packages/agent-core'),
      '@genoffice/ai-provider': resolve(__dirname, 'src/packages/ai-provider')
    }
  }
})
