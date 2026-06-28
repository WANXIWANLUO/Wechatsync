/**
 * 文章提取器 Content Script
 * 从当前页面提取文章内容
 *
 * 提取策略:
 * 1. 特定平台提取器 (微信公众号等)
 * 2. Safari ReaderArticleFinder + Defuddle 并行竞争 (通用，择优)
 * 3. <article> 标签 (最后手段)
 *
 * 内容格式:
 * - 在页面端使用 Turndown + 原生 DOM 将 HTML 转为 Markdown
 * - Service Worker 只需处理 Markdown，无需 DOM 解析
 */

import { extractArticle as extractWithReader, ReaderResult } from '../lib/reader'
import { htmlToMarkdownNative, type PreprocessConfig } from '@wechatsync/core'
import { createLogger } from '../lib/logger'
import { preprocessContentDOM, preprocessForPlatform, backupAndSimplifyCodeBlocks, restoreCodeBlocks, type PreprocessResult } from '../lib/content-processor'


const logger = createLogger('Extractor')

interface ExtractedArticle {
  title: string
  markdown: string   // Markdown 格式（主要）
  html?: string      // 原始 HTML（可选，用于某些平台）
  summary?: string
  cover?: string
  source: {
    url: string
    platform: string
  }
}

/**
 * 提取文章内容
 */
/**
 * 判断 src 是否为占位图（小尺寸、data URI 等）
 */
function isPlaceholderSrc(src: string): boolean {
  if (!src) return true
  // data URI 小于 200 字符的通常是占位图
  if (src.startsWith('data:') && src.length < 200) return true
  // 非常短的 URL 通常是 1x1 像素等
  if (src.length < 20 && !src.startsWith('http')) return true
  return false
}

/**
 * 从图片的所有 data-* 属性中找到真正的图片 URL
 */
function findRealSrc(img: HTMLImageElement): string | null {
  // 常见的懒加载属性名
  const knownAttrs = ['data-src', 'data-original', 'data-lazy-src', 'data-url',
    'data-srcset', 'data-img', 'data-image', 'data-image-src', 'data-bg',
    'data-background', 'data-large', 'data-full', 'data-hires',
    'data-real-src', 'data-actual-src', 'data-raw-src']
  
  for (const attr of knownAttrs) {
    const val = img.getAttribute(attr)
    if (val && (val.startsWith('http') || val.startsWith('//') || val.startsWith('/'))) {
      return val
    }
  }
  
  // 遍历所有 data-* 属性查找图片 URL
  for (const name of img.getAttributeNames()) {
    if (!name.startsWith('data-')) continue
    const val = img.getAttribute(name)
    if (val && val.length > 30 && (val.startsWith('http') || val.startsWith('//'))) {
      return val
    }
  }
  
  return null
}

/**
 * 强制加载页面上所有懒加载图片
 *
 * 策略：
 * 1. 属性修改：loading="lazy"→"eager"（原生懒加载）
 * 2. 占位图替换：src 为占位图时，从 data-* 属性找真实 URL
 * 3. 逐屏滚动：限定 <article> 区域，80ms/步触发框架 IntersectionObserver
 */
async function preloadLazyImages(): Promise<void> {
  // 1. 原生懒加载 → eager
  document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach(img => {
    img.loading = 'eager'
  })

  // 2. 占位图替换：扫描所有图片，占位 src → 真实 URL
  document.querySelectorAll<HTMLImageElement>('img').forEach(img => {
    if (isPlaceholderSrc(img.src)) {
      const realSrc = findRealSrc(img)
      if (realSrc) {
        img.src = realSrc
        img.loading = 'eager'
      }
    }
  })

  // 3. 逐屏滚动文章内容区 — 触发框架 IntersectionObserver
  const article = document.querySelector('article') as HTMLElement | null
  const targetEl = article || document.body
  const scrollY = window.scrollY
  const scrollX = window.scrollX
  const rect = targetEl.getBoundingClientRect()
  const elTop = rect.top + scrollY
  const elHeight = rect.height
  const viewportHeight = window.innerHeight

  if (elHeight <= viewportHeight * 1.2) return

  for (let offset = viewportHeight; offset <= elHeight; offset += viewportHeight * 0.7) {
    window.scrollTo({ left: scrollX, top: elTop + offset, behavior: 'instant' as ScrollBehavior })
    await new Promise(r => setTimeout(r, 80))
  }
  window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' as ScrollBehavior })
  await new Promise(r => setTimeout(r, 300))
}

// 提取结果缓存：同一页面只提取一次，后续点击直接复用
let cachedArticle: ExtractedArticle | null = null
let cachedUrl: string = ''

async function extractArticle(forceRefresh = false): Promise<ExtractedArticle | null> {
  const url = window.location.href

  // 同一页面走缓存（除非强制刷新或 URL 变了）
  if (!forceRefresh && cachedArticle && cachedUrl === url) {
    return { ...cachedArticle, markdown: cachedArticle.markdown, html: cachedArticle.html }
  }

  // 提取前先移除 WeChatSync 的 UI 元素，避免按钮文字混入文章
  const uiElements = document.querySelectorAll('[data-wechatsync-ui]')
  const uiRestore: { el: Element; parent: Node; next: Node | null }[] = []
  uiElements.forEach(el => {
    const parent = el.parentNode
    const next = el.nextSibling
    if (parent) {
      uiRestore.push({ el, parent, next })
      parent.removeChild(el)
    }
  })

  // 强制触发懒加载图片
  await preloadLazyImages()

  try {
    let result: ExtractedArticle | null = null

    if (url.includes('mp.weixin.qq.com')) {
      result = extractWeixinArticle()
    } else if (window.location.hostname.endsWith('.feishu.cn') || window.location.hostname.endsWith('.larksuite.com')) {
      result = await extractFeishuArticle()
    }

    // 飞书没匹配到则继续尝试通用/站点配置
    if (!result) {
      const siteConfig = findSiteConfig(window.location.hostname)
      if (siteConfig) {
        result = extractWithSiteConfig(siteConfig)
      }
    }
    if (!result) {
      result = extractGenericArticle()
    }

    // 缓存结果
    if (result) {
      cachedArticle = result
      cachedUrl = url
    }
    return result
  } finally {
    // 恢复 WeChatSync UI 元素到原位置
    for (const { el, parent, next } of uiRestore) {
      try {
        parent.insertBefore(el, next)
      } catch { /* parent may have been removed */ }
    }
  }
}

/**
 * 提取微信公众号文章
 */
function extractWeixinArticle(): ExtractedArticle | null {
  const title = document.querySelector('#activity-name')?.textContent?.trim()
  const contentEl = document.querySelector('#js_content')
  const cover = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
  const summary = document.querySelector('meta[property="og:description"]')?.getAttribute('content')

  if (!title || !contentEl) {
    return null
  }

  // 在原始 DOM 上简化代码块（innerText 只在真实 DOM 上正确工作）
  const codeBlockBackups = backupAndSimplifyCodeBlocks(contentEl)

  try {
    // 克隆内容元素（此时代码块已经是简化后的纯文本）
    const clonedContent = contentEl.cloneNode(true) as HTMLElement

    // 恢复原始 DOM（尽早恢复，避免影响页面显示）
    restoreCodeBlocks(codeBlockBackups)

    // 预处理克隆的内容
    preprocessContentDOM(clonedContent)

    // 获取 HTML 并转换为 Markdown
    const html = clonedContent.innerHTML
    const markdown = htmlToMarkdownNative(html)

    return {
      title,
      markdown,
      html, // 保留原始 HTML，微信平台需要
      summary: summary || undefined,
      cover: cover || undefined,
      source: {
        url: window.location.href,
        platform: 'weixin',
      },
    }
  } catch (e) {
    restoreCodeBlocks(codeBlockBackups)
    throw e
  }
}

// ========== 飞书文档提取 ==========

/**
 * fetch 当前页面 HTML，从 <script> 标签中解析 clientVars。
 * 飞书在 HTML 中通过 inline script 设置 window.DATA = Object.assign({}, window.DATA, { clientVars: ... })
 * 直接用正则从 HTML 文本中提取 clientVars JSON，不受 CSP 限制。
 */
async function extractFeishuArticle(): Promise<ExtractedArticle | null> {
  try {
    const resp = await fetch(window.location.href, { credentials: 'include' })
    if (!resp.ok) return null

    const html = await resp.text()

    // 从 HTML 中找到 clientVars: Object({...}) 并提取 JSON
    const marker = 'clientVars: Object('
    const start = html.indexOf(marker)
    if (start === -1) return null

    const jsonStart = html.indexOf('{', start + marker.length)
    if (jsonStart === -1) return null

    // 用大括号计数找到匹配的闭合 }（跳过字符串内的大括号）
    let depth = 0
    let inString = false
    let escape = false
    let jsonEnd = -1
    for (let i = jsonStart; i < html.length; i++) {
      const ch = html[i]
      if (escape) { escape = false; continue }
      if (ch === '\\' && inString) { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') { depth--; if (depth === 0) { jsonEnd = i; break } }
    }
    if (jsonEnd === -1) return null

    const clientVars = JSON.parse(html.slice(jsonStart, jsonEnd + 1))
    if (!clientVars?.data) return null

    // 新版 docx: block_map
    if (clientVars.data.block_map) {
      return extractFeishuDocx(clientVars.data.block_map)
    }

    // 旧版 doc: collab_client_vars
    if (clientVars.data.collab_client_vars) {
      return extractFeishuDoc(clientVars.data.collab_client_vars)
    }

    return null
  } catch (e) {
    logger.error('飞书文档提取失败', e)
    return null
  }
}

/**
 * 从 block_map 提取飞书 docx 内容
 * 支持递归嵌套结构、富文本属性、图片、表格、多列布局等
 */
function extractFeishuDocx(blockMap: Record<string, any>): ExtractedArticle | null {
  const pageBlock = Object.values(blockMap).find((b: any) => b.data.type === 'page')
  if (!pageBlock) return null

  // 页面标题可能在 data.title 或 data.text 中
  const titleTextData = pageBlock.data.title?.initialAttributedTexts?.text
  const title = (typeof titleTextData === 'string' ? titleTextData : titleTextData?.['0'])
    || getBlockText(pageBlock) || document.title
  const hostname = window.location.hostname

  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  /**
   * 解析富文本属性，将纯文本转换为带格式的 HTML
   * attribs 格式如 "*0+1*1+2*2*3+4" 表示应用哪些属性到哪些字符
   * numToAttrib 映射属性编号到 [key, value] 对
   */
  function renderRichText(block: any): string {
    const textData = block.data.text
    if (!textData) return ''
    const rawTextData = textData.initialAttributedTexts?.text
    const rawText = typeof rawTextData === 'string' ? rawTextData : (rawTextData?.['0'] ?? '')
    if (!rawText) return ''

    const apool = textData.apool
    if (!apool?.numToAttrib) return escapeHtml(rawText)

    // attribs 可能是字符串 "*0*1+5..." 或对象 { '0': "*0*1+5..." }
    const rawAttribs = textData.initialAttributedTexts?.attribs
    let attribs = ''
    if (typeof rawAttribs === 'string') {
      attribs = rawAttribs
    } else if (rawAttribs && typeof rawAttribs === 'object') {
      attribs = rawAttribs['0'] ?? Object.values(rawAttribs)[0] ?? ''
    }
    if (!attribs) return escapeHtml(rawText)

    // 逐字符解析 attribs（Etherpad 格式，数字为 base-36 编码）:
    // *N 启用属性 N, +M 插入 M 个字符, |N+M 插入含 N 个换行的 M 个字符, =N 保持
    const b36 = /[0-9a-z]/i
    const ops: { attrs: number[]; len: number }[] = []
    let parsePos = 0
    while (parsePos < attribs.length) {
      const ch = attribs[parsePos]
      if (ch === '*') {
        // 收集所有连续的 *N 属性
        const currentAttrs: number[] = []
        while (parsePos < attribs.length && attribs[parsePos] === '*') {
          parsePos++ // skip *
          let numStr = ''
          while (parsePos < attribs.length && b36.test(attribs[parsePos])) {
            numStr += attribs[parsePos++]
          }
          if (numStr) currentAttrs.push(parseInt(numStr, 36))
        }
        // 跳过可选的 |N（换行计数修饰符）
        if (parsePos < attribs.length && attribs[parsePos] === '|') {
          parsePos++
          while (parsePos < attribs.length && b36.test(attribs[parsePos])) parsePos++
        }
        // 期望 + 或 =
        if (parsePos < attribs.length && (attribs[parsePos] === '+' || attribs[parsePos] === '=')) {
          parsePos++ // skip + or =
          let lenStr = ''
          while (parsePos < attribs.length && b36.test(attribs[parsePos])) {
            lenStr += attribs[parsePos++]
          }
          const len = parseInt(lenStr, 36) || 0
          if (len > 0) ops.push({ attrs: currentAttrs, len })
        }
      } else if (ch === '|') {
        // |N+M 无属性的换行操作
        parsePos++
        while (parsePos < attribs.length && b36.test(attribs[parsePos])) parsePos++
        if (parsePos < attribs.length && (attribs[parsePos] === '+' || attribs[parsePos] === '=')) {
          parsePos++
          let lenStr = ''
          while (parsePos < attribs.length && b36.test(attribs[parsePos])) {
            lenStr += attribs[parsePos++]
          }
          const len = parseInt(lenStr, 36) || 0
          if (len > 0) ops.push({ attrs: [], len })
        }
      } else if (ch === '+' || ch === '=') {
        // 无属性的插入/保持操作
        parsePos++
        let lenStr = ''
        while (parsePos < attribs.length && b36.test(attribs[parsePos])) {
          lenStr += attribs[parsePos++]
        }
        const len = parseInt(lenStr, 36) || 0
        if (len > 0) ops.push({ attrs: [], len })
      } else {
        parsePos++ // 跳过未知字符
      }
    }

    // 收集 link 定义（link-id -> url 映射）
    const linkMap: Record<string, string> = {}
    if (textData.links) {
      for (const [linkId, linkData] of Object.entries(textData.links as Record<string, any>)) {
        linkMap[linkId] = linkData.url || linkData.href || ''
      }
    }

    // 逐段应用属性
    let pos = 0
    const htmlFragments: string[] = []
    for (const op of ops) {
      const segment = rawText.slice(pos, pos + op.len)
      pos += op.len
      if (!segment) continue

      let html = escapeHtml(segment)

      // 收集当前段需要的样式和标签
      let isBold = false
      let isItalic = false
      let isInlineCode = false
      let isStrikethrough = false
      let isUnderline = false
      let linkUrl = ''
      let color = ''
      let bgColor = ''

      for (const attrIdx of op.attrs) {
        const attr = apool.numToAttrib[String(attrIdx)]
        if (!attr) continue
        const [key, value] = attr
        switch (key) {
          case 'bold': if (value === 'true') isBold = true; break
          case 'italic': if (value === 'true') isItalic = true; break
          case 'inlineCode': if (value === 'true') isInlineCode = true; break
          case 'strikethrough': if (value === 'true') isStrikethrough = true; break
          case 'underline': if (value === 'true') isUnderline = true; break
          case 'link-id': linkUrl = linkMap[value] || ''; break
          case 'textHighlight': bgColor = value; break
          case 'textColor': color = value; break
        }
      }

      // 应用格式（内层先应用）
      if (isInlineCode) {
        html = `<code>${html}</code>`
      } else {
        if (isBold) html = `<strong>${html}</strong>`
        if (isItalic) html = `<em>${html}</em>`
        if (isStrikethrough) html = `<del>${html}</del>`
        if (isUnderline) html = `<u>${html}</u>`
      }

      // 颜色/高亮用 span
      const styles: string[] = []
      if (color) styles.push(`color:${color}`)
      if (bgColor) styles.push(`background-color:${bgColor}`)
      if (styles.length) html = `<span style="${styles.join(';')}">${html}</span>`

      // 链接包裹在最外层
      if (linkUrl) html = `<a href="${escapeHtml(linkUrl)}">${html}</a>`

      htmlFragments.push(html)
    }

    // 如果还有剩余文本未被 attribs 覆盖
    if (pos < rawText.length) {
      htmlFragments.push(escapeHtml(rawText.slice(pos)))
    }

    return htmlFragments.join('')
  }

  /**
   * 递归渲染一个 block 为 HTML
   */
  function renderBlock(blockId: string): string {
    const block = blockMap[blockId]
    if (!block) return ''

    const type = block.data.type
    const richText = renderRichText(block)
    const children = block.data.children || []

    switch (type) {
      case 'page':
        return renderChildren(children)

      case 'text':
        if (!richText && !children.length) return ''
        if (children.length) {
          return `<p>${richText}</p>\n${renderChildren(children)}`
        }
        return `<p>${richText}</p>`

      case 'heading1': return `<h1>${richText}</h1>`
      case 'heading2': return `<h2>${richText}</h2>`
      case 'heading3': return `<h3>${richText}</h3>`
      case 'heading4': return `<h4>${richText}</h4>`
      case 'heading5': return `<h5>${richText}</h5>`
      case 'heading6': return `<h6>${richText}</h6>`

      case 'code': {
        const plainText = getBlockText(block) || ''
        return `<pre><code>${escapeHtml(plainText)}</code></pre>`
      }

      case 'quote':
      case 'callout': {
        if (children.length) {
          return `<blockquote>${richText ? `<p>${richText}</p>\n` : ''}${renderChildren(children)}</blockquote>`
        }
        return `<blockquote><p>${richText}</p></blockquote>`
      }

      case 'bullet':
      case 'bulletList': {
        const inner = children.length ? `${richText}\n${renderChildren(children)}` : richText
        return `<!--list:ul--><li>${inner}</li><!--/list:ul-->`
      }

      case 'ordered':
      case 'orderedList': {
        const inner = children.length ? `${richText}\n${renderChildren(children)}` : richText
        return `<!--list:ol--><li>${inner}</li><!--/list:ol-->`
      }

      case 'todoList': {
        const done = block.data.done === true
        const checkbox = done ? '&#9745; ' : '&#9744; '
        return `<p>${checkbox}${richText}</p>`
      }

      case 'divider':
        return '<hr>'

      case 'image': {
        const imageData = block.data.image || block.data
        const token = imageData.token || ''
        const src = imageData.url || imageData.src ||
          (token ? `https://${hostname}/space/api/box/stream/download/all/${token}/` : '')
        if (src) return `<img src="${escapeHtml(String(src))}">`
        return ''
      }

      case 'table': {
        return renderTable(block)
      }

      case 'table_cell': {
        // table_cell 的内容在 children 中
        if (children.length) return renderChildren(children)
        if (richText) return richText
        return ''
      }

      case 'grid': {
        // 多列布局: 渲染每个 grid_column 的内容
        if (children.length) {
          return `<div style="display:flex;gap:16px;">${children.map((cid: string) => renderBlock(cid)).join('')}</div>`
        }
        return ''
      }

      case 'grid_column': {
        if (children.length) {
          return `<div style="flex:1;">${renderChildren(children)}</div>`
        }
        return ''
      }

      case 'view':
      case 'file': {
        // 附件/文件块：显示文件名
        const fileName = block.data.file_name || block.data.name || '附件'
        return `<p>[${escapeHtml(String(fileName))}]</p>`
      }

      default:
        // 未知类型：尝试渲染文本和子块
        if (richText || children.length) {
          const parts: string[] = []
          if (richText) parts.push(`<p>${richText}</p>`)
          if (children.length) parts.push(renderChildren(children))
          return parts.join('\n')
        }
        return ''
    }
  }

  /**
   * 渲染一组子 block，并合并连续的列表项到同一个 <ul>/<ol> 中
   */
  function renderChildren(childIds: string[]): string {
    const rendered = childIds.map(id => renderBlock(id)).filter(Boolean)
    // 合并连续的列表标记：<!--list:ul-->...<li>...</li>...<!--/list:ul-->
    const merged: string[] = []
    let i = 0
    while (i < rendered.length) {
      const item = rendered[i]
      if (item.startsWith('<!--list:ul-->')) {
        // 收集连续的 ul 项
        const lis: string[] = []
        while (i < rendered.length && rendered[i].startsWith('<!--list:ul-->')) {
          lis.push(rendered[i].replace('<!--list:ul-->', '').replace('<!--/list:ul-->', ''))
          i++
        }
        merged.push(`<ul>${lis.join('\n')}</ul>`)
      } else if (item.startsWith('<!--list:ol-->')) {
        // 收集连续的 ol 项
        const lis: string[] = []
        while (i < rendered.length && rendered[i].startsWith('<!--list:ol-->')) {
          lis.push(rendered[i].replace('<!--list:ol-->', '').replace('<!--/list:ol-->', ''))
          i++
        }
        merged.push(`<ol>${lis.join('\n')}</ol>`)
      } else {
        merged.push(item)
        i++
      }
    }
    return merged.join('\n')
  }

  /**
   * 渲染表格 block
   * table block 有 columns_id, rows_id, cell_set 结构
   */
  function renderTable(block: any): string {
    const data = block.data
    const columnsId: string[] = data.columns_id || []
    const rowsId: string[] = data.rows_id || []
    const cellSet: Record<string, any> = data.cell_set || {}
    const children: string[] = data.children || []

    if (!columnsId.length || !rowsId.length) {
      if (children.length) return renderChildren(children)
      return ''
    }

    // 尝试找到 cell 的函数：支持多种 key 格式和数据结构
    function getCellContent(rowId: string, colId: string): string {
      // 尝试多种 cell_set key 格式
      const cell = cellSet[`${rowId}:${colId}`] || cellSet[`${rowId}${colId}`]

      if (cell) {
        // 格式1: cell 是字符串（直接就是 block ID）
        if (typeof cell === 'string' && blockMap[cell]) {
          return renderBlock(cell)
        }
        // 格式2: cell.block_id 指向 blockMap 中的 block
        if (cell.block_id && blockMap[cell.block_id]) {
          return renderBlock(cell.block_id)
        }
        // 格式3: cell.id 指向 blockMap 中的 block
        if (cell.id && blockMap[cell.id]) {
          return renderBlock(cell.id)
        }
        // 格式4: cell 自身有 children
        if (cell.children?.length) {
          return renderChildren(cell.children)
        }
        // 格式5: cell 自身有 text 数据
        if (cell.text) {
          return renderRichText({ data: cell })
        }
      }

      return ''
    }

    // 如果 cell_set 完全为空，尝试从 children（table_cell blocks）按行列顺序构建
    const cellSetEmpty = Object.keys(cellSet).length === 0
    if (cellSetEmpty && children.length) {
      const numCols = columnsId.length
      const rows: string[] = []
      for (let r = 0; r < rowsId.length; r++) {
        const cells: string[] = []
        for (let c = 0; c < numCols; c++) {
          const idx = r * numCols + c
          const cellBlockId = children[idx]
          const content = cellBlockId ? renderBlock(cellBlockId) : ''
          cells.push(`<td>${content}</td>`)
        }
        rows.push(`<tr>${cells.join('')}</tr>`)
      }
      return `<table border="1" cellpadding="4" cellspacing="0">${rows.join('\n')}</table>`
    }

    const rows: string[] = []
    for (const rowId of rowsId) {
      const cells: string[] = []
      for (const colId of columnsId) {
        cells.push(`<td>${getCellContent(rowId, colId)}</td>`)
      }
      rows.push(`<tr>${cells.join('')}</tr>`)
    }

    return `<table border="1" cellpadding="4" cellspacing="0">${rows.join('\n')}</table>`
  }

  // 渲染页面子块
  const children = pageBlock.data.children || []
  const html = renderChildren(children)
  if (!html.trim()) return null

  const markdown = htmlToMarkdownNative(html)

  return {
    title,
    markdown,
    html,
    source: {
      url: window.location.href,
      platform: 'feishu',
    },
  }
}

/**
 * 旧版 doc: 从 collab_client_vars 提取
 * texts["0"] 是主文档正文，其中 "*" 独占一行是 zone 占位符（代码块等）
 * 其他 texts key 是 zone 内容，按 apool 中 zoneId 出现顺序对应正文中的 * 位置
 */
function extractFeishuDoc(vars: {
  title?: string
  initialAttributedTexts?: { texts?: Record<string, string> }
  initialAttributedText?: { text?: string }
  apool?: { numToAttrib?: Record<string, [string, string]> }
}): ExtractedArticle | null {
  const title = vars.title || document.title
  const texts = vars.initialAttributedTexts?.texts
  const mainText = texts?.['0'] || vars.initialAttributedText?.text
  if (!mainText) return null

  // 从 apool 按 index 顺序收集 zoneId，保持出现顺序
  const zoneIds: string[] = []
  if (vars.apool?.numToAttrib) {
    const entries = Object.entries(vars.apool.numToAttrib)
      .sort(([a], [b]) => Number(a) - Number(b))
    for (const [, [key, val]] of entries) {
      if (key === 'zoneId' && !zoneIds.includes(val)) {
        zoneIds.push(val)
      }
    }
  }

  const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  // 按行处理正文，遇到 * 占位符行就插入对应的 zone 内容
  const htmlParts: string[] = []
  let zoneIndex = 0
  for (const line of mainText.split('\n')) {
    if (line.trim() === '*') {
      // zone 占位符，插入对应代码块
      if (texts && zoneIndex < zoneIds.length) {
        const zoneContent = texts[zoneIds[zoneIndex]]
        if (zoneContent?.trim()) {
          htmlParts.push(`<pre><code>${escapeHtml(zoneContent.trim())}</code></pre>`)
        }
        zoneIndex++
      }
      continue
    }
    if (!line.trim()) continue
    htmlParts.push(`<p>${escapeHtml(line)}</p>`)
  }

  const html = htmlParts.join('\n')
  if (!html.trim()) return null

  const markdown = htmlToMarkdownNative(html)

  return {
    title,
    markdown,
    html,
    source: {
      url: window.location.href,
      platform: 'feishu',
    },
  }
}

function getBlockText(block: any): string | undefined {
  const t = block.data?.text?.initialAttributedTexts?.text
  if (!t) return undefined
  return typeof t === 'string' ? t : t['0']
}

// ========== 站点特定提取配置 ==========

interface SiteExtractConfig {
  /** 匹配的域名（支持后缀匹配，如 'feishu.cn' 匹配 xxx.feishu.cn） */
  domains: string[]
  /** 平台标识 */
  platform: string
  /** 正文容器选择器 */
  contentSelector: string
  /** 标题选择器（按优先级排列，可选，回退到 h1 / og:title / document.title） */
  titleSelectors?: string[]
  /** 需要删除的元素选择器 */
  removeSelectors?: string[]
  /** 需要解包的元素选择器（将内部的 heading 提升出来替换外层容器） */
  unwrapHeadingSelectors?: string[]
}

const SITE_CONFIGS: SiteExtractConfig[] = [
  {
    domains: ['toutiao.com'],
    platform: 'toutiao',
    contentSelector: 'article',
    titleSelectors: ['h1'],
  },
  {
    domains: ['github.com'],
    platform: 'github',
    contentSelector: '.markdown-body',
    titleSelectors: ['[itemprop="name"] a', '.AppHeader-context-item-label'],
    removeSelectors: ['.anchor', 'a[aria-hidden="true"]', '[data-testid]', '.octicon', '.zeroclipboard-container', '.btn-octicon'],
    unwrapHeadingSelectors: ['.markdown-heading'],
  },
  {
    domains: ['csdn.net', 'csdn.com'],
    platform: 'csdn',
    contentSelector: 'article.baidu_pl, #content_views, .article-content',
    titleSelectors: ['.title-article', 'h1.title', '#articleContentId h1'],
    removeSelectors: [
      '.article-info-box', '.blog-tags-box', '.more-toolbox',
      '.recommend-box', '.aside-box', '.praise-box',
      '.csdn-side-toolbar', '.toolbar-box',
      '.comment-box', '.recommend-item-box',
      'pre[class*="set-code-hide"]',
    ],
  },
  // 飞书/Lark 使用虚拟滚动，由 extractFeishuArticle() 通过 fetch + clientVars 解析提取
]

function findSiteConfig(hostname: string): SiteExtractConfig | undefined {
  return SITE_CONFIGS.find(config =>
    config.domains.some(domain =>
      hostname === domain || hostname.endsWith('.' + domain)
    )
  )
}

/**
 * 基于站点配置提取文章
 */
function extractWithSiteConfig(config: SiteExtractConfig): ExtractedArticle | null {
  const contentEl = document.querySelector(config.contentSelector) as HTMLElement
  if (!contentEl) return null

  // 提取标题
  let title: string | undefined
  if (config.titleSelectors) {
    for (const sel of config.titleSelectors) {
      const el = document.querySelector(sel)
      if (el?.textContent?.trim()) {
        title = el.textContent.trim()
        break
      }
    }
  }
  if (!title) {
    const h1 = contentEl.querySelector('h1')
    title = h1?.textContent?.trim()
      || document.querySelector('meta[property="og:title"]')?.getAttribute('content')
      || document.title
  }

  const codeBlockBackups = backupAndSimplifyCodeBlocks(contentEl)

  try {
    const clonedContent = contentEl.cloneNode(true) as HTMLElement
    restoreCodeBlocks(codeBlockBackups)

    // 删除非内容元素
    if (config.removeSelectors) {
      for (const sel of config.removeSelectors) {
        clonedContent.querySelectorAll(sel).forEach(el => el.remove())
      }
    }

    // 解包标题容器
    if (config.unwrapHeadingSelectors) {
      for (const sel of config.unwrapHeadingSelectors) {
        clonedContent.querySelectorAll(sel).forEach(wrapper => {
          const heading = wrapper.querySelector('h1, h2, h3, h4, h5, h6')
          if (heading) {
            wrapper.replaceWith(heading)
          }
        })
      }
    }

    preprocessContentDOM(clonedContent)
    const html = clonedContent.innerHTML
    const markdown = htmlToMarkdownNative(html)

    const cover = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
    const summary = document.querySelector('meta[property="og:description"]')?.getAttribute('content')

    return {
      title,
      markdown,
      html,
      summary: summary || undefined,
      cover: cover || undefined,
      source: {
        url: window.location.href,
        platform: config.platform,
      },
    }
  } catch (e) {
    restoreCodeBlocks(codeBlockBackups)
    throw e
  }
}

/**
 * 通用文章提取
 * 使用 Safari ReaderArticleFinder / Defuddle 并行竞争
 */
function extractGenericArticle(): ExtractedArticle | null {
  // 使用统一的 Reader 提取器
  const result = extractWithReader()

  if (result) {
    return readerResultToArticle(result)
  }

  // 如果 Reader 提取失败，尝试简单的选择器
  return extractWithSelectors()
}

/**
 * 将 ReaderResult 转换为 ExtractedArticle
 */
function readerResultToArticle(result: ReaderResult): ExtractedArticle {
  // 创建临时 DOM 进行预处理
  const tempDiv = document.createElement('div')
  tempDiv.innerHTML = result.content
  preprocessContentDOM(tempDiv)
  const processedHtml = tempDiv.innerHTML

  // 转换为 Markdown
  const markdown = htmlToMarkdownNative(processedHtml)

  return {
    title: result.title,
    markdown,
    html: processedHtml, // 预处理后的 HTML
    summary: result.excerpt,
    cover: result.leadingImage || result.mainImage,
    source: {
      url: window.location.href,
      platform: result.extractor,
    },
  }
}

/**
 * 使用 CSS 选择器提取 (最后手段)
 */
/**
 * 从克隆的 DOM 中移除页面组件（导航、侧栏、页脚、广告、扩展自身 UI 等）
 */
function stripPageComponents(root: HTMLElement): void {
  // 先移除 WeChatSync 自身的 UI 元素，避免按钮文字混入文章
  root.querySelectorAll('[data-wechatsync-ui]').forEach(el => el.remove())

  const removeSelectors = [
    'nav', 'header', 'footer',
    '.nav', '.navbar', '.navigation',
    '.header', '.footer',
    '.sidebar', '.side-bar', '.aside',
    '.ad', '.advertisement', '.ads',
    '.comment', '.comments', '.comment-list',
    '.related', '.recommend', '.recommendation',
    '.share', '.social', '.social-share',
    '.toolbar', '.tool-bar',
    '.copyright', '.license',
    '.breadcrumb', '.breadcrumbs',
    '.catalog', '.toc', '.table-of-contents',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '#nav', '#header', '#footer', '#sidebar', '#comments',
    '.recommend-box', '.aside-box', '.article-info-box',
    '.blog-tags-box', '.more-toolbox', '.praise-box',
    '.csdn-side-toolbar', '.tool_active', '.toolbar-box',
  ]
  for (const sel of removeSelectors) {
    root.querySelectorAll(sel).forEach(el => el.remove())
  }
}

function extractWithSelectors(): ExtractedArticle | null {
  const selectors = {
    title: [
      'h1',
      'article h1',
      '.article-title',
      '.post-title',
      '[itemprop="headline"]',
    ],
    content: [
      'article',
      '.article-content',
      '.post-content',
      '.entry-content',
      '[itemprop="articleBody"]',
      'main',
    ],
  }

  let title: string | null = null
  for (const selector of selectors.title) {
    const el = document.querySelector(selector)
    if (el?.textContent?.trim()) {
      title = el.textContent.trim()
      break
    }
  }

  let html: string | null = null
  for (const selector of selectors.content) {
    const el = document.querySelector(selector)
    if (el?.innerHTML) {
      const codeBlockBackups = backupAndSimplifyCodeBlocks(el)

      try {
        const clonedContent = el.cloneNode(true) as HTMLElement

        restoreCodeBlocks(codeBlockBackups)

        // 移除页面组件
        stripPageComponents(clonedContent)

        preprocessContentDOM(clonedContent)
        html = clonedContent.innerHTML
        break
      } catch (e) {
        restoreCodeBlocks(codeBlockBackups)
        throw e
      }
    }
  }

  // 回退到 meta 标签
  if (!title) {
    title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
      || document.title
  }

  if (!title || !html) {
    return null
  }

  // 转换为 Markdown
  const markdown = htmlToMarkdownNative(html)

  const cover = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
  const summary = document.querySelector('meta[property="og:description"]')?.getAttribute('content')

  return {
    title,
    markdown,
    html, // 保留原始 HTML
    summary: summary || undefined,
    cover: cover || undefined,
    source: {
      url: window.location.href,
      platform: 'selector',
    },
  }
}

// ========== 文章检测 ==========

/**
 * 轻量级文章检测 — 判断当前页面是否包含可提取的文章
 * 返回文章标题元素和内容容器的位置参考信息
 */
interface ArticleDetection {
  titleEl: HTMLElement      // 文章标题元素
  contentEl: HTMLElement    // 文章内容容器
  platform: string          // 检测到的平台标识
}

function detectArticle(): ArticleDetection | null {
  const url = window.location.href
  const hostname = window.location.hostname

  // 不检测：微信公众号所有页面（包括文章页、编辑器、草稿箱等）
  if (hostname === 'mp.weixin.qq.com') return null

  // 不检测：编辑器/后台管理类页面（包括今日头条后台等）
  if (hostname === 'mp.toutiao.com') return null
  const backendPatterns = ['/cgi-bin/', '/admin/', '/editor/', '/dashboard/']
  if (backendPatterns.some(p => url.includes(p))) return null

  // 1. 站点特定配置
  const siteConfig = findSiteConfig(hostname)
  if (siteConfig) {
    const contentEl = document.querySelector(siteConfig.contentSelector) as HTMLElement
    if (contentEl) {
      const titleEl = (siteConfig.titleSelectors
        ? findElementBySelectors(siteConfig.titleSelectors)
        : null) || findArticleTitleGeneric(contentEl)
      if (titleEl) {
        return { titleEl, contentEl, platform: siteConfig.platform }
      }
    }
  }

  // 3. meta og:type === 'article'
  const ogType = document.querySelector('meta[property="og:type"]')?.getAttribute('content')
  if (ogType === 'article') {
    const titleEl = findArticleTitleGeneric(document.body)
    const contentEl = findArticleContentGeneric()
    if (titleEl && contentEl) {
      return { titleEl, contentEl, platform: 'generic' }
    }
  }

  // 4. 通用选择器检测
  const contentEl = findArticleContentGeneric()
  if (contentEl) {
    // 标题可能在 article 外面，搜整个页面，而不仅限 article 内部
    const titleEl = findArticleTitleGeneric(document.body)
    if (titleEl) {
      return { titleEl, contentEl, platform: 'generic' }
    }
  }

  // 5. 最后手段：检查页面文本长度是否像文章
  if (document.body.textContent && document.body.textContent.length > 1000) {
    const titleEl = document.querySelector('h1') as HTMLElement
    if (titleEl) {
      return { titleEl, contentEl: document.body, platform: 'generic' }
    }
  }

  return null
}

function findElementBySelectors(selectors: string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel) as HTMLElement
    if (el?.textContent?.trim()) return el
  }
  return null
}

function findArticleTitleGeneric(fallbackRoot: HTMLElement = document.body): HTMLElement | null {
  const titleSelectors = [
    '.article-title',
    '.post-title',
    '.entry-title',
    '[itemprop="headline"]',
  ]
  for (const sel of titleSelectors) {
    const el = fallbackRoot.querySelector(sel) as HTMLElement
    if (el?.textContent?.trim()) return el
  }

  // 获取页面标题（去掉尾部 " - 站点名" 之类）
  const pageTitleRaw = (document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title || '').trim()
  const pageTitle = pageTitleRaw.toLowerCase()
  // 用于匹配的核心部分（去掉 " - xxx" 后缀）
  const pageTitleCore = pageTitle.replace(/\s*[-|_—–]\s*\S+$/, '').trim()
  console.log('[WechatSync] findArticleTitle - pageTitle:', pageTitleRaw.substring(0, 80), 'core:', pageTitleCore.substring(0, 80))

  // 在所有标题元素中找最匹配页面标题的
  const allHeadings = fallbackRoot.querySelectorAll('h1, h2, [class*="title"], [class*="Title"], [class*="headline"], [class*="subject"]')
  let bestEl: HTMLElement | null = null
  let bestScore = -1

  for (const el of allHeadings) {
    const text = el.textContent?.trim() || ''
    if (!text || text.length < 5 || text.length > 300) continue // 太短或太长的跳过
    const lowText = text.toLowerCase()

    let score = parseFloat(getComputedStyle(el).fontSize) || 14

    if (pageTitleCore && lowText === pageTitleCore) {
      score += 100000
    } else if (pageTitleCore && pageTitleCore.includes(lowText) && lowText.length > 5) {
      score += 50000
    } else if (pageTitleCore && lowText.includes(pageTitleCore)) {
      score += 30000
    } else if (pageTitle && pageTitle.includes(lowText) && lowText.length > 5) {
      score += 20000
    }

    console.log('[WechatSync] findArticleTitle - candidate:', el.tagName, text.substring(0, 50), 'fontSize:', parseFloat(getComputedStyle(el).fontSize), 'score:', score)

    if (score > bestScore) {
      bestScore = score
      bestEl = el as HTMLElement
    }
  }

  // 没找到匹配的标题元素，回退到 h1
  if (!bestEl) {
    const allH1 = fallbackRoot.querySelectorAll('h1')
    for (const el of allH1) {
      if (el.textContent?.trim()) {
        bestEl = el as HTMLElement
        break
      }
    }
  }

  console.log('[WechatSync] findArticleTitle - selected:', bestEl?.tagName, bestEl?.textContent?.trim()?.substring(0, 50))
  return bestEl
}

function findArticleContentGeneric(): HTMLElement | null {
  const contentSelectors = [
    'article',
    '.article-content',
    '.post-content',
    '.entry-content',
    '[itemprop="articleBody"]',
    'main',
  ]
  for (const sel of contentSelectors) {
    const el = document.querySelector(sel) as HTMLElement
    if (el?.textContent && el.textContent.length > 100) return el
  }
  return null
}

// ========== 文章标题旁行内同步按钮 ==========

let inlineSyncButton: HTMLElement | null = null

/**
 * 在文章标题旁边注入"同步文章"按钮
 */
function injectInlineSyncButton(detection: ArticleDetection) {
  // 双重检查：变量 + DOM，防止按钮重复注入
  if (inlineSyncButton || document.querySelector('#wechatsync-inline-sync')) return

  const { titleEl, platform } = detection

  const btn = document.createElement('span')
  btn.id = 'wechatsync-inline-sync'
  btn.setAttribute('data-wechatsync-ui', '')
  btn.title = '同步文章到多平台'
  btn.style.cssText = `
    display: inline !important;
    vertical-align: middle !important;
    margin-left: 8px !important;
    padding: 0 8px !important;
    border-radius: 10px !important;
    border: 1px solid rgba(128,128,128,0.35) !important;
    background: transparent !important;
    cursor: pointer !important;
    color: rgba(0,0,0,0.55) !important;
    font-size: 12px !important;
    font-weight: 400 !important;
    font-family: inherit !important;
    line-height: inherit !important;
    transition: color 0.2s, border-color 0.2s, background 0.2s !important;
    user-select: none !important;
    white-space: nowrap !important;
    box-shadow: none !important;
  `

  btn.innerHTML = `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;margin-right:3px;flex-shrink:0;opacity:0.7;" class="wcs-icon">
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/>
    </svg>
    同步
  `

  btn.addEventListener('mouseenter', () => {
    btn.style.color = '#07c160'
    btn.style.borderColor = 'rgba(7,193,96,0.6)'
    btn.style.background = 'rgba(7,193,96,0.06)'
    const icon = btn.querySelector('.wcs-icon') as SVGElement | null
    if (icon) icon.style.opacity = '1'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.color = 'rgba(0,0,0,0.55)'
    btn.style.borderColor = 'rgba(128,128,128,0.35)'
    btn.style.background = 'transparent'
    const icon = btn.querySelector('.wcs-icon') as SVGElement | null
    if (icon) icon.style.opacity = '0.7'
  })

  btn.addEventListener('click', () => {
    if (pendingLoading) return // 防止重复点击，多次加载
    pendingLoading = showLoading()
    btn.style.pointerEvents = 'none' // 禁用按钮
    chrome.runtime.sendMessage({ type: 'TRIGGER_OPEN_EDITOR' })
  })

  // 直接追加到标题末尾，作为自然 inline 元素跟随文本流
  titleEl.appendChild(btn)

  console.log('[WechatSync] Button appended inside', titleEl.tagName, 'visible:', btn.offsetParent !== null)

  inlineSyncButton = btn
}

function removeInlineSyncButton() {
  if (inlineSyncButton) {
    inlineSyncButton.remove()
    inlineSyncButton = null
  }
}

// 预先显示的 loading（点击按钮时立即显示，避免等待 background 响应）
let pendingLoading: { remove: () => void } | null = null

// ========== 显示列表 (Display List) 匹配逻辑 ==========

interface DisplayRule {
  id: string
  pattern: string        // 如 "blog.csdn.net/*/article/details/*"
  url: string
  title: string
  createdAt: number
}

/**
 * 检查 URL 是否匹配模式（* 匹配任意字符，不跨 /）
 * *.toutiao.com/article/* 匹配 www.toutiao.com/article/123
 */
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
      // pp === '*' → matches any segment
    }
    return true
  } catch {
    return false
  }
}

/**
 * 检查当前页面是否在显示列表中
 */
function isPageInDisplayList(rules: DisplayRule[]): boolean {
  if (!rules || rules.length === 0) return false
  const url = window.location.href
  for (const rule of rules) {
    const matched = matchesDisplayRule(url, rule.pattern)
    console.log('[WechatSync] isPageInDisplayList: url=', url, 'pattern=', rule.pattern, '→ matched=', matched)
    if (matched) return true
  }
  return false
}

// 初始化：根据显示列表决定是否注入行内按钮
// 使用定时轮询，简单可靠，避免 async storage + MutationObserver 的竞态
let displayListChecked = false
let displayListPollCount = 0
const MAX_DISPLAY_POLL = 8

function tryInjectFromDisplayList() {
  if (displayListChecked) return
  displayListPollCount++

  console.log('[WechatSync] tryInjectFromDisplayList attempt', displayListPollCount, 'url:', window.location.href)

  try {
    chrome.storage.local.get('syncButtonDisplayList', (result) => {
      if (chrome.runtime.lastError) {
        console.log('[WechatSync] storage get error:', chrome.runtime.lastError)
        return
      }
      if (displayListChecked) return
      const rules: DisplayRule[] = result.syncButtonDisplayList || []
      console.log('[WechatSync] got rules:', rules.length, 'rules:', JSON.stringify(rules.map(r => r.pattern)))
      if (rules.length > 0 && isPageInDisplayList(rules)) {
        displayListChecked = true
        console.log('[WechatSync] page MATCHED display list')
        try {
          const detection = detectArticle()
          console.log('[WechatSync] detectArticle result:', detection ? 'found article, platform=' + detection.platform : 'null')
          if (detection) {
            injectInlineSyncButton(detection)
            console.log('[WechatSync] inline button injected!')
          }
        } catch (e) { console.log('[WechatSync] DOM query error:', e) }
      } else {
        console.log('[WechatSync] page NOT in display list (rules:', rules.length, 'displayListPollCount:', displayListPollCount, ')')
        if (displayListPollCount >= MAX_DISPLAY_POLL) {
          displayListChecked = true
          console.log('[WechatSync] display list check exhausted after', MAX_DISPLAY_POLL, 'polls')
        }
      }
    })
  } catch (e) {
    console.log('[WechatSync] Extension context invalidated:', e)
    displayListChecked = true
  }
}

// 首次检测：DOM 就绪后开始轮询
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(tryInjectFromDisplayList, 800)
  })
} else {
  setTimeout(tryInjectFromDisplayList, 800)
}

// 每隔 1.5s 重试，最多 MAX_DISPLAY_POLL 次
const displayPollTimer = setInterval(() => {
  tryInjectFromDisplayList()
  if (displayListChecked) clearInterval(displayPollTimer)
}, 1500)

// 15 秒后强制停止
setTimeout(() => {
  clearInterval(displayPollTimer)
  if (!displayListChecked) displayListChecked = true
}, 15000)

// 监听设置变化，实时响应
chrome.storage.onChanged.addListener((changes) => {
  try {
    if (changes.syncButtonDisplayList) {
      const newRules: DisplayRule[] = changes.syncButtonDisplayList.newValue || []
      if (isPageInDisplayList(newRules)) {
        displayListChecked = true
        const detection = detectArticle()
        if (detection) {
          injectInlineSyncButton(detection)
        }
      } else {
        removeInlineSyncButton()
      }
    }
  } catch { /* extension context invalidated */ }
})

// ========== Loading 提示 ==========

function showLoading(): { remove: () => void } {
  const overlay = document.createElement('div')
  overlay.setAttribute('data-wechatsync-ui', '')
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.3); z-index: 2147483646;
    display: flex; align-items: center; justify-content: center;
  `
  overlay.innerHTML = `
    <div style="background:white;padding:20px 32px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:flex;align-items:center;gap:12px;">
      <div style="width:20px;height:20px;border:3px solid #e5e5e5;border-top-color:#07c160;border-radius:50%;animation:wcs-spin 0.8s linear infinite;"></div>
      <span style="font-size:14px;color:#333;">正在提取文章内容...</span>
    </div>
    <style>@keyframes wcs-spin { to { transform: rotate(360deg); } }</style>
  `
  document.body.appendChild(overlay)
  return { remove: () => overlay.remove() }
}

// ========== 编辑器注入 ==========

let editorIframe: HTMLIFrameElement | null = null
let editorContainer: HTMLDivElement | null = null

/**
 * 打开编辑器
 */
function openEditor(article: ExtractedArticle, platforms: any[], selectedPlatformIds?: string[]) {
  if (editorContainer) {
    // 已经打开，重新发送数据
    sendDataToEditor(article, platforms, selectedPlatformIds)
    return
  }

  // 创建全屏容器
  editorContainer = document.createElement('div')
  editorContainer.id = 'wechatsync-editor-container'
  editorContainer.setAttribute('data-wechatsync-ui', '')
  editorContainer.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    z-index: 2147483647 !important;
    background: white !important;
    margin: 0 !important;
    padding: 0 !important;
  `

  // 创建 iframe
  editorIframe = document.createElement('iframe')
  editorIframe.src = chrome.runtime.getURL('src/editor/index.html')
  editorIframe.style.cssText = `
    width: 100vw !important;
    height: 100vh !important;
    border: none !important;
    margin: 0 !important;
    padding: 0 !important;
    display: block !important;
  `

  editorContainer.appendChild(editorIframe)
  document.body.appendChild(editorContainer)

  // 禁止页面滚动
  document.body.style.overflow = 'hidden'

  // 等待 iframe 准备好后发送数据
  const handleEditorReady = (event: MessageEvent) => {
    try {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      if (data.type === 'EDITOR_READY') {
        sendDataToEditor(article, platforms, selectedPlatformIds)
        window.removeEventListener('message', handleEditorReady)
      }
    } catch (e) {
      // ignore
    }
  }
  window.addEventListener('message', handleEditorReady)
}

/**
 * 发送数据到编辑器
 */
function sendDataToEditor(article: ExtractedArticle, platforms: any[], selectedPlatformIds?: string[]) {
  if (!editorIframe?.contentWindow) return

  // 发送文章数据
  editorIframe.contentWindow.postMessage(JSON.stringify({
    type: 'ARTICLE_DATA',
    article: {
      title: article.title,
      content: article.html || article.markdown,
      cover: article.cover,
      url: article.source.url,
      extractor: article.source.platform,
    },
  }), '*')

  // 发送平台数据（包含已选中的平台）
  editorIframe.contentWindow.postMessage(JSON.stringify({
    type: 'PLATFORMS_DATA',
    platforms,
    selectedPlatformIds, // 传递已选中的平台 ID
  }), '*')
}

/**
 * 关闭编辑器
 */
function closeEditor() {
  if (editorContainer) {
    editorContainer.remove()
    editorContainer = null
    editorIframe = null
    document.body.style.overflow = ''
  }
}

/**
 * 为多个平台预处理内容
 * @param rawHtml 原始 HTML
 * @param platformIds 平台 ID 列表
 * @param configs 各平台的预处理配置
 * @returns 各平台的预处理结果
 */
function preprocessForMultiplePlatformsLocal(
  rawHtml: string,
  platformIds: string[],
  configs: Record<string, PreprocessConfig>
): Record<string, PreprocessResult> {
  const results: Record<string, PreprocessResult> = {}

  for (const platformId of platformIds) {
    const config = configs[platformId]
    if (config) {
      results[platformId] = preprocessForPlatform(rawHtml, config)
    } else {
      // 没有配置的平台使用默认处理
      const tempDiv = document.createElement('div')
      tempDiv.innerHTML = rawHtml
      preprocessContentDOM(tempDiv)
      const html = tempDiv.innerHTML
      results[platformId] = {
        html,
        markdown: htmlToMarkdownNative(html),
      }
    }
  }

  return results
}

/**
 * 监听编辑器消息
 */
window.addEventListener('message', async (event) => {
  // 仅处理对象类型或有效 JSON 字符串的消息，忽略页面的其他 postMessage
  let data: any
  if (typeof event.data === 'object' && event.data !== null) {
    data = event.data
  } else if (typeof event.data === 'string') {
    try {
      data = JSON.parse(event.data)
    } catch {
      return // 不是有效 JSON，不是我们的消息，静默忽略
    }
  } else {
    return
  }

  // 只处理我们定义的消息类型
  if (!data.type) return

  try {
    if (data.type === 'CLOSE_EDITOR') {
      closeEditor()
    } else if (data.type === 'START_SYNC') {
      // 只处理来自编辑器的 START_SYNC，忽略来自 sync-dialog 的
      if (!editorIframe) return
      // 转发同步请求到 background
      // 编辑器传来的是 HTML content
      const rawHtml = data.article?.content || ''
      const platforms: string[] = data.platforms || []

      // 从 background 获取各平台的预处理配置
      const configResponse = await chrome.runtime.sendMessage({
        type: 'GET_PREPROCESS_CONFIGS',
        platforms,
      })

      const configs: Record<string, PreprocessConfig> = configResponse?.configs || {}

      // 为每个平台分别预处理
      const platformContents = preprocessForMultiplePlatformsLocal(rawHtml, platforms, configs)

      logger.debug('Preprocessed contents for platforms:', Object.keys(platformContents))

      chrome.runtime.sendMessage({
        type: 'START_SYNC_FROM_EDITOR',
        article: {
          ...data.article,
          // 保留一份默认内容（兼容）
          html: rawHtml,
          markdown: htmlToMarkdownNative(rawHtml),
          // 各平台专属预处理内容
          platformContents,
        },
        platforms,
        syncId: data.syncId,  // 转发 syncId
      })
    }
  } catch (e) {
    // 只对我们自己的消息类型才记录，避免页面其他 postMessage 污染日志
    logger.warn('Editor message handler error:', e)
  }
})

/**
 * 监听 background 消息，转发同步进度到编辑器
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'DETECT_ARTICLE') {
    // 轻量检测：仅判断是否为文章页，不提取完整内容、不滚动页面
    try {
      const detection = detectArticle()
      if (detection) {
        const title = detection.titleEl?.textContent?.trim() || document.title
        const cover = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || undefined
        const summary = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || undefined

        // 顺便检查显示列表：如果页面匹配但按钮尚未注入，补注入
        if (!inlineSyncButton) {
          try {
            chrome.storage.local.get('syncButtonDisplayList', (result) => {
              if (chrome.runtime.lastError) return
              const rules: DisplayRule[] = result.syncButtonDisplayList || []
              if (rules.length > 0 && isPageInDisplayList(rules)) {
                displayListChecked = true
                injectInlineSyncButton(detection)
              }
            })
          } catch { /* extension context invalidated */ }
        }

        sendResponse({
          article: {
            title,
            cover,
            summary,
            content: '', // popup 不需要完整内容
          }
        })
      } else {
        sendResponse({ article: null })
      }
    } catch {
      sendResponse({ article: null })
    }
    return true
  } else if (message.type === 'EXTRACT_ARTICLE') {
    // 微信页面有专用 content script 处理提取，避免竞争
    const url = window.location.href
    if (url.includes('mp.weixin.qq.com/cgi-bin/appmsg') || url.includes('mp.weixin.qq.com/s')) {
      return false // 不处理，交给 weixin.ts
    }
    const loading = showLoading()
    extractArticle().then(article => {
      loading.remove()
      sendResponse({ article })
    }).catch(() => { loading.remove(); sendResponse({ article: null }) })
    return true
  } else if (message.type === 'OPEN_EDITOR') {
    // 防止重复提取卡死页面
    if (editorContainer) {
      sendResponse({ success: true }) // 编辑器已打开，忽略
      return true
    }
    if (pendingLoading) {
      // 已有加载中，忽略重复请求
      return true
    }
    const loading = showLoading()
    // 强制刷新，绕过缓存（避免读到含按钮文字的旧标题）
    extractArticle(true).then(article => {
      loading.remove()
      // 恢复内联按钮可点击状态
      if (inlineSyncButton) {
        inlineSyncButton.style.pointerEvents = ''
      }
      if (article) {
        openEditor(article, message.platforms || [], message.selectedPlatforms || [])
        sendResponse({ success: true })
      } else {
        sendResponse({ success: false, error: '无法提取文章内容' })
      }
    }).catch(() => {
      loading.remove()
      if (inlineSyncButton) inlineSyncButton.style.pointerEvents = ''
      sendResponse({ success: false, error: '提取失败' })
    })
    return true
  } else if (message.type === 'PREPROCESS_FOR_PLATFORMS') {
    // 为多个平台预处理内容（由 background 调用）
    const { rawHtml, platforms, configs } = message.payload as {
      rawHtml: string
      platforms: string[]
      configs: Record<string, PreprocessConfig>
    }
    const platformContents = preprocessForMultiplePlatformsLocal(rawHtml, platforms, configs)
    sendResponse({ platformContents })
  } else if (message.type === 'SYNC_PROGRESS') {
    // 转发同步进度到编辑器（带上 syncId）
    editorIframe?.contentWindow?.postMessage(JSON.stringify({
      type: 'SYNC_PROGRESS',
      result: message.result,
      syncId: message.syncId,
    }), '*')
  } else if (message.type === 'SYNC_DETAIL_PROGRESS') {
    // 转发详细进度到编辑器（带上 syncId）
    // 兼容两种格式：message.payload (from SYNC_ARTICLE) 或直接展开 (from START_SYNC_FROM_EDITOR)
    const progress = message.payload || {
      platform: message.platform,
      platformName: message.platformName,
      stage: message.stage,
      imageProgress: message.imageProgress,
      result: message.result,
      error: message.error,
    }
    editorIframe?.contentWindow?.postMessage(JSON.stringify({
      type: 'SYNC_DETAIL_PROGRESS',
      progress,
      syncId: message.syncId,
    }), '*')
  } else if (message.type === 'SYNC_COMPLETE') {
    // 同步完成（带上 syncId）
    editorIframe?.contentWindow?.postMessage(JSON.stringify({
      type: 'SYNC_COMPLETE',
      rateLimitWarning: message.rateLimitWarning,
      syncId: message.syncId,
    }), '*')
  } else if (message.type === 'SYNC_ERROR') {
    // 同步错误（带上 syncId）
    editorIframe?.contentWindow?.postMessage(JSON.stringify({
      type: 'SYNC_ERROR',
      error: message.error,
      syncId: message.syncId,
    }), '*')
  }
  return true
})
