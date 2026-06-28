/**
 * 微信公众号文章页 Content Script
 * 标题旁行内按钮 + 响应 popup 的提取请求
 */

import { htmlToMarkdownNative, type PreprocessConfig } from '@wechatsync/core'
import { preprocessContentDOM, preprocessForPlatform, backupAndSimplifyCodeBlocks, restoreCodeBlocks } from '../lib/content-processor'

;(() => {

function injectSyncButton() {
  const titleEl = document.querySelector('#activity-name') as HTMLElement | null
  if (!titleEl) return
  if (document.querySelector('#wechatsync-inline-weixin')) return

  const btn = document.createElement('span')
  btn.id = 'wechatsync-inline-weixin'
  btn.setAttribute('data-wechatsync-ui', '')
  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="margin-right:3px;flex-shrink:0;vertical-align:middle;opacity:0.55;" class="wcs-icon">
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
    </svg>
    同步
  `
  btn.title = '同步文章到多平台'
  btn.style.cssText = `
    display: inline-flex !important;
    align-items: center !important;
    margin-left: 12px !important;
    padding: 2px 10px !important;
    border-radius: 12px !important;
    border: 1px solid rgba(128,128,128,0.25) !important;
    background: transparent !important;
    cursor: pointer !important;
    color: rgba(0,0,0,0.35) !important;
    font-size: 12px !important;
    font-weight: 400 !important;
    font-family: inherit !important;
    vertical-align: middle !important;
    line-height: 1.5 !important;
    transition: color 0.2s, border-color 0.2s, background 0.2s !important;
    user-select: none !important;
    white-space: nowrap !important;
    position: relative !important;
    z-index: 9999 !important;
    box-shadow: none !important;
  `

  btn.addEventListener('mouseenter', () => {
    btn.style.color = '#07c160'
    btn.style.borderColor = 'rgba(7,193,96,0.4)'
    btn.style.background = 'rgba(7,193,96,0.05)'
    const icon = btn.querySelector('.wcs-icon') as SVGElement | null
    if (icon) icon.style.opacity = '1'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.color = 'rgba(0,0,0,0.35)'
    btn.style.borderColor = 'rgba(128,128,128,0.25)'
    btn.style.background = 'transparent'
    const icon = btn.querySelector('.wcs-icon') as SVGElement | null
    if (icon) icon.style.opacity = '0.55'
  })

  let clicked = false
  btn.addEventListener('click', () => {
    if (clicked) return // 防止重复点击
    clicked = true
    btn.style.pointerEvents = 'none'
    chrome.runtime.sendMessage({ type: 'TRIGGER_OPEN_EDITOR' }).catch(() => {
      clicked = false
      btn.style.pointerEvents = ''
    })
  })

  titleEl.appendChild(btn)
}

// 提取文章（only used by popup's EXTRACT_ARTICLE）
function extractWeixinArticle() {
  // 提取前移除同步按钮（避免读取到按钮文字"同步"）
  const syncBtn = document.querySelector('#wechatsync-inline-weixin') as HTMLElement | null
  const syncBtnParent = syncBtn?.parentNode ?? null
  const syncBtnNext = syncBtn?.nextSibling ?? null
  if (syncBtn && syncBtnParent) syncBtnParent.removeChild(syncBtn)

  const title = document.querySelector('#activity-name')?.textContent?.trim()
  const contentEl = document.querySelector('#js_content')
  const cover = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
  const summary = document.querySelector('meta[property="og:description"]')?.getAttribute('content')

  // 恢复按钮
  if (syncBtn && syncBtnParent) {
    try { syncBtnParent.insertBefore(syncBtn, syncBtnNext) } catch { /* ignore */ }
  }

  if (!title || !contentEl) return null

  const rawHtml = contentEl.innerHTML
  const codeBlockBackups = backupAndSimplifyCodeBlocks(contentEl)

  try {
    const clonedContent = contentEl.cloneNode(true) as HTMLElement
    restoreCodeBlocks(codeBlockBackups)
    preprocessContentDOM(clonedContent)

    const htmlContent = clonedContent.innerHTML
    const markdown = htmlToMarkdownNative(htmlContent)

    return {
      title,
      html: htmlContent,
      content: htmlContent,
      rawHtml,
      markdown,
      summary: summary || undefined,
      cover: cover || undefined,
      source: { url: window.location.href, platform: 'weixin' },
    }
  } catch (e) {
    restoreCodeBlocks(codeBlockBackups)
    throw e
  }
}

// ========== 显示列表匹配 ==========

interface DisplayRule {
  id: string
  pattern: string
  url: string
  title: string
  createdAt: number
}

function isPageInDisplayList(): boolean {
  return (window as any).__wcs_displayMatched === true
}

// 响应消息
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DETECT_ARTICLE') {
    const titleEl = document.querySelector('#activity-name')
    const isArticle = !!(titleEl && document.querySelector('#js_content'))
    if (isArticle) {
      const title = titleEl!.textContent?.trim() || document.title
      const cover = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || undefined
      const summary = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || undefined
      sendResponse({ article: { title, cover, summary, content: '' } })
    } else {
      sendResponse({ article: null })
    }
    return true
  }
  if (message.type === 'EXTRACT_ARTICLE') {
    const article = extractWeixinArticle()
    sendResponse({ article })
    return true
  }
  return false
})

function tryInject() {
  if (!isPageInDisplayList()) return false
  if (document.querySelector('#activity-name') && document.querySelector('#js_content')) {
    injectSyncButton()
    return true
  }
  return false
}

function matchesDisplayRule(url: string, pattern: string): boolean {
  try {
    const parsed = new URL(url)
    const urlParts = [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)]
    const patternParts = pattern.split('/')
    if (urlParts.length !== patternParts.length) return false
    for (let i = 0; i < patternParts.length; i++) {
      const pp = patternParts[i]
      if (!pp.includes('*')) {
        if (pp !== urlParts[i]) return false
      } else if (pp !== '*') {
        const regex = new RegExp('^' + pp.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$')
        if (!regex.test(urlParts[i])) return false
      }
    }
    return true
  } catch { return false }
}

function checkDisplayList() {
  try {
    chrome.storage.local.get('syncButtonDisplayList', (result) => {
      if (chrome.runtime.lastError) return
      const rules: DisplayRule[] = result.syncButtonDisplayList || []
      const url = window.location.href
      const matched = rules.some(rule => matchesDisplayRule(url, rule.pattern))
      ;(window as any).__wcs_displayMatched = matched
      if (matched) tryInject()
    })
  } catch { /* extension context invalidated */ }
}
checkDisplayList()

chrome.storage.onChanged.addListener((changes) => {
  try {
    if (changes.syncButtonDisplayList) {
      checkDisplayList()
    }
  } catch { /* extension context invalidated */ }
})

// 首次尝试
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(tryInject, 300))
} else {
  setTimeout(tryInject, 300)
}

// 兜底 MutationObserver
let weixinObserver: MutationObserver | null = null
let weixinRetries = 0
setTimeout(() => {
  if (tryInject()) return

  weixinObserver = new MutationObserver(() => {
    weixinRetries++
    if (tryInject() || weixinRetries >= 10) {
      weixinObserver?.disconnect()
      weixinObserver = null
    }
  })
  weixinObserver.observe(document.body || document.documentElement, { childList: true, subtree: true })
  setTimeout(() => {
    weixinObserver?.disconnect()
    weixinObserver = null
  }, 15000)
}, 1000)
})()
