import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import yaml from '@modyfi/vite-plugin-yaml'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import baseManifest from './manifest.json'

const manifest = baseManifest

// 修复 crx-client-port：instanceof Error 在扩展上下文中不可靠，
// 且 content script 的 Error 对象与 crx-client-port 中的 Error 构造函数
// 可能来自不同的 JavaScript 上下文
function fixCrxClientPortPlugin() {
  return {
    name: 'fix-crx-client-port',
    transform(code: string, id: string) {
      if (id.includes('crx-client-port')) {
        // 1. 修复 instanceof Error 检查（跨上下文不可靠）
        code = code.replace(
          /if\s*\(error\s+instanceof\s+Error\s*&&\s*error\.message\.includes\(["']Extension context invalidated\.["']\)\)/g,
          'if (error?.message?.includes("Extension context invalidated."))'
        )
        // 2. 如果已经触发 reload，不要再 throw
        code = code.replace(
          /catch\s*\(\s*error\s*\)\s*\{\s*if\s*\(error\?\.message\?\.includes\(["']Extension context invalidated\.["']\)\)\s*\{\s*location\.reload\(\);\s*\}\s*else\s*throw\s+error;\s*\}/g,
          'catch(error){if(error?.message?.includes("Extension context invalidated.")){location.reload();return}else throw error}'
        )
        return code
      }
      return null
    },
  }
}

// 复制静态文件并修改 manifest 的插件
function copyStaticFilesPlugin() {
  return {
    name: 'copy-static-files',
    writeBundle() {

      // 复制 rules 目录
      const rulesDir = resolve(__dirname, 'rules')
      const distRulesDir = resolve(__dirname, 'dist/rules')

      if (existsSync(rulesDir)) {
        if (!existsSync(distRulesDir)) {
          mkdirSync(distRulesDir, { recursive: true })
        }

        const files = readdirSync(rulesDir)
        for (const file of files) {
          copyFileSync(
            resolve(rulesDir, file),
            resolve(distRulesDir, file)
          )
          console.log(`[copy-static] Copied rules/${file}`)
        }
      }

      // 复制 reader 脚本（避免被 vite 转换为 ES modules）
      const readerDir = resolve(__dirname, 'public/lib')
      const distDir = resolve(__dirname, 'dist')

      if (existsSync(readerDir)) {
        const readerFiles = ['reader.js', 'Readability.js']
        for (const file of readerFiles) {
          const srcPath = resolve(readerDir, file)
          const destPath = resolve(distDir, file)
          if (existsSync(srcPath)) {
            copyFileSync(srcPath, destPath)
            console.log(`[copy-static] Copied ${file} to dist/`)
          }
        }
      }

      // 修改输出的 manifest.json，添加 reader 脚本到 content_scripts
      const manifestPath = resolve(__dirname, 'dist/manifest.json')
      if (existsSync(manifestPath)) {
        const manifestContent = JSON.parse(readFileSync(manifestPath, 'utf-8'))

        const readerContentScript = {
          js: ['reader.js', 'Readability.js'],
          matches: ['http://*/*', 'https://*/*'],
          run_at: 'document_start'
        }

        manifestContent.content_scripts = [
          readerContentScript,
          ...manifestContent.content_scripts
        ]

        writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2))
        console.log('[copy-static] Updated manifest.json with reader scripts')
      }
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const isDev = mode === 'development'
  return {
    plugins: [
      react(),
      yaml(),
      crx({ manifest }),
      fixCrxClientPortPlugin(),
      copyStaticFilesPlugin(),
    ],
    define: {
      'import.meta.env.VITE_GA_MEASUREMENT_ID': JSON.stringify(env.VITE_GA_MEASUREMENT_ID || ''),
      'import.meta.env.VITE_GA_API_SECRET': JSON.stringify(env.VITE_GA_API_SECRET || ''),
      // 开发模式下覆盖 PROD 标志，让 logger 输出 debug 日志
      'import.meta.env.PROD': JSON.stringify(!isDev),
      'import.meta.env.DEV': JSON.stringify(isDev),
    },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@wechatsync/core': resolve(__dirname, '../core/src'),
    },
  },
  build: {
    // 开发模式: 不压缩，生成 sourcemap
    minify: isDev ? false : 'esbuild',
    sourcemap: isDev ? 'inline' : false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        editor: resolve(__dirname, 'src/editor/index.html'),
        'sync-dialog': resolve(__dirname, 'src/sync-dialog/index.html'),
        preprocessor: resolve(__dirname, 'src/preprocessor/index.html'),
      },
    },
  },
}})
