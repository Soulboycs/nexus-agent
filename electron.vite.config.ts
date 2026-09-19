import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const packageAliases = {
  '@genoffice/docx-engine': resolve('src/packages/docx-engine'),
  '@genoffice/font-metrics': resolve('src/packages/font-metrics'),
  '@genoffice/i18n': resolve('src/packages/i18n'),
  '@genoffice/ui': resolve('src/packages/ui'),
  '@genoffice/electron-utils': resolve('src/packages/electron-utils'),
  '@genoffice/agent-core': resolve('src/packages/agent-core'),
  '@genoffice/ai-provider': resolve('src/packages/ai-provider')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
        '@agent': resolve('src/main/agent'),
        ...packageAliases
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@preload': resolve('src/preload'),
        ...packageAliases
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        ...packageAliases
      }
    },
    plugins: [react()]
  }
})
