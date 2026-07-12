import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorView, Decoration, DecorationSet, WidgetType } from '@codemirror/view'
import { EditorState, StateField, StateEffect } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { markdownToHtml } from '@wechatsync/core'
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  Heading3,
  Quote,
  List,
  ListOrdered,
  Link2,
  Image as ImageIcon,
  Code,
  Code2,
  Minus,
  Table,
  HelpCircle,
  Pencil,
  Columns,
  Eye,
  ListTree,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// 模块级引用：图片 widget 异步加载后通过它触发 requestMeasure（比 findFromDOM 更可靠），
// 刷新行高测量，避免行号因图片高度变化而累积错位。
let activeEditorView: EditorView | null = null

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  dark?: boolean
}

type ViewMode = 'edit' | 'split' | 'preview'

interface Heading {
  level: number
  text: string
  line: number
  index: number
}

/**
 * CSDN 风格「带语法的实时格式化」：源码区在保留 Markdown 语法（#、**、[]()、![](url) 等）
 * 的同时，按预览样式实时渲染——标题大号、粗体即粗、链接有色、图片完整尺寸。
 * 通过 Lezer 语法树（@codemirror/lang-markdown 提供）识别节点，再用 decorations 叠加样式。
 * 语法标记（#、**、括号、URL 等）以暗色弱化显示，正文文本生效格式。
 */
/**
 * 独立成行的图片：以行内替换(零长度range)放在行首，CSS display:block 让视觉独占一行。
 * 不用 block:true——块装饰会在行间插入额外高度导致 CM 内置行号 gutter 与内容错位。
 * 图片异步加载会改变 widget 高度，加载后 requestMeasure 刷新点击坐标映射（避免光标偏移）。
 */
class ImageBlockWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) {
    super()
  }
  eq(o: ImageBlockWidget) {
    return o.url === this.url && o.alt === this.alt
  }
  // 关键：声明估计高度（≥ CSS 显示上限 420px + padding 12px = 432），让 CM 一开始按正确高度布局该行。
  // 注意：CSS 用 padding 而非 margin（margin 在元素盒外，CM 测不准 → 低估行高 → 后续行号累积错位）。
  // 只要 estimatedHeight ≥ 实际渲染高度，就永不漂移（略高会被首次测量纠正，仅短暂多留空隙，无累积）。
  get estimatedHeight() {
    return 460
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-img-block'
    const img = document.createElement('img')
    img.className = 'cm-img-full'
    img.src = this.url
    img.alt = this.alt || '图片'
    const remeasure = () => {
      // 用模块级引用触发重测（比 findFromDOM 更可靠，避免拿不到 view 时不重测）
      if (activeEditorView) activeEditorView.requestMeasure()
    }
    img.addEventListener('load', remeasure)
    img.addEventListener('error', () => {
      wrap.innerHTML = `<span class="cm-img-fallback">🖼 ${this.alt || this.url}</span>`
      remeasure()
    })
    wrap.appendChild(img)
    return wrap
  }
  ignoreEvent() {
    return true
  }
}

/**
 * 行内图片：保持文本流，渲染为小缩略图（不折叠）。
 */
class ImageInlineWidget extends WidgetType {
  constructor(readonly url: string, readonly alt: string) {
    super()
  }
  eq(o: ImageInlineWidget) {
    return o.url === this.url && o.alt === this.alt
  }
  get estimatedHeight() {
    return 80
  }
  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-img-inline'
    const img = document.createElement('img')
    img.className = 'cm-img-thumb'
    img.src = this.url
    img.alt = this.alt || '图片'
    const remeasure = () => {
      if (activeEditorView) activeEditorView.requestMeasure()
    }
    img.addEventListener('load', remeasure)
    img.addEventListener('error', () => {
      wrap.innerHTML = `<span class="cm-img-fallback">🖼 ${this.alt || this.url}</span>`
      remeasure()
    })
    wrap.appendChild(img)
    return wrap
  }
  ignoreEvent() {
    return true
  }
}

/**
 * 图片源码行的「收缩态」标签：未聚焦时把 `![](url)` 整段替换成紧凑标签（🖼 描述），
 * 只占一行、视觉上明确「收起」。点击/聚焦该标签 → 展开为可编辑的原始语法文本。
 * 自身 ignoreEvent 让 CM 不抢指针，但 click 监听仍生效，用来触发展开并把光标放入该行。
 */
class ImageSrcLabelWidget extends WidgetType {
  constructor(readonly alt: string, readonly lineNo: number, readonly nodeFrom: number) {
    super()
  }
  eq(o: ImageSrcLabelWidget) {
    return o.alt === this.alt && o.lineNo === this.lineNo && o.nodeFrom === this.nodeFrom
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = 'cm-img-src-label'
    el.textContent = '🖼 ' + (this.alt || '图片链接')
    el.addEventListener('click', () => {
      const view = EditorView.findFromDOM(el)
      if (!view) return
      // 展开：标记本行为聚焦态（装饰重建后恢复真实文本），并把光标放进该行供编辑
      view.dispatch({
        selection: { anchor: this.nodeFrom + 2 },
        effects: setFocusedSrc.of(this.lineNo),
      })
      view.focus()
    })
    return el
  }
  ignoreEvent() {
    return true
  }
}

// 注意：不要加 g 修饰符——.exec 会沿用 lastIndex，导致连续多张图匹配错位（部分图 url 解析为空→不显示）
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/

// 给 [from,to] 覆盖的每一行加一个行级 class（用于标题/引用/代码块的多行格式化）
type DecoRange = ReturnType<Decoration['range']>
function addLineDecoEach(state: EditorState, from: number, to: number, cls: string, builder: DecoRange[]) {
  if (to > state.doc.length) to = state.doc.length
  let pos = from
  while (pos <= to) {
    const line = state.doc.lineAt(pos)
    builder.push(Decoration.line({ class: cls }).range(line.from))
    if (line.to + 1 > to) break
    pos = line.to + 1
  }
}

function buildMarkdownDecorations(state: EditorState, focusedSrcLine: number | null): DecorationSet {
  const builder: DecoRange[] = []

  // 遍历整篇文档（StateField 无 visibleRanges，但文章体量小，全量扫描足够流畅）
  syntaxTree(state).iterate({
    from: 0,
    to: state.doc.length,
    enter: (node) => {
      const name = node.name

      // —— 标题：行级格式化，字号匹配预览 ——
      const hm = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
      if (hm) {
        const line = state.doc.lineAt(node.from)
        builder.push(Decoration.line({ class: `cm-h${hm[1]}` }).range(line.from))
        return
      }

      // —— 行内格式 ——
      if (name === 'StrongEmphasis') {
        builder.push(Decoration.mark({ class: 'cm-strong' }).range(node.from, node.to))
      } else if (name === 'Emphasis') {
        builder.push(Decoration.mark({ class: 'cm-em' }).range(node.from, node.to))
      } else if (name === 'InlineCode') {
        builder.push(Decoration.mark({ class: 'cm-code' }).range(node.from, node.to))
      } else if (name === 'Link') {
        builder.push(Decoration.mark({ class: 'cm-link' }).range(node.from, node.to))
      } else if (name === 'FencedCode' || name === 'CodeBlock') {
        addLineDecoEach(state, node.from, node.to, 'cm-codeblock', builder)
      } else if (name === 'Blockquote') {
        addLineDecoEach(state, node.from, node.to, 'cm-quote', builder)
      }
      // —— 语法标记（#、**、括号、URL 等）弱化显示 ——
      else if (
        name === 'HeaderMark' ||
        name === 'EmphasisMark' ||
        name === 'LinkMark' ||
        name === 'QuoteMark' ||
        name === 'URL' ||
        name === 'LinkTitle' ||
        name === 'ImageMark'
      ) {
        builder.push(Decoration.mark({ class: 'cm-md-mark' }).range(node.from, node.to))
      }
      // —— 图片：完整尺寸显示，源码行默认收缩为标签、聚焦展开（见 focusedSrcLineField）——
      else if (name === 'Image') {
        const line = state.doc.lineAt(node.from)
        const lineText = state.sliceDoc(line.from, line.to).trim()
        const orig = state.sliceDoc(node.from, node.to)
        const m = IMAGE_RE.exec(orig)
        const url = m ? m[2] : ''
        const alt = m ? m[1] : ''
        if (lineText === orig) {
          // 独立成行：图片作为行首行内 widget（纯插入，不替换文本），CSS display:block 视觉独占一行。
          // 不用 block:true（块装饰会使行号 gutter 错位）；不用 Decoration.replace 零长度（会触发
          // "Invalid range for replacement decoration"，因 block 缺失时 sides 组合非法）。
          builder.push(
            Decoration.widget({ widget: new ImageBlockWidget(url, alt), side: -1 }).range(line.from, line.from),
          )
          // 源码行收缩：未聚焦时用紧凑标签替换 `![alt](url)`，聚焦后恢复真实文本可编辑
          if (focusedSrcLine !== line.number) {
            builder.push(
              Decoration.replace({ widget: new ImageSrcLabelWidget(alt, line.number, node.from) }).range(node.from, node.to),
            )
          }
        } else {
          // 行内图片：小缩略图，保持文本流
          builder.push(
            Decoration.replace({ widget: new ImageInlineWidget(url, alt) }).range(node.from, node.to),
          )
        }
      }
    },
  })
  return Decoration.set(builder, true)
}

/**
 * 当前展开中的图片源码行号（null = 无，即全部收缩）。
 * 源码行（独立成行的 `![](url)`）默认收缩为紧凑标签；点击标签展开为可编辑原始文本；
 * 失焦或光标移出该行时由 imgSrcFocusListener 收回。
 */
const setFocusedSrc = StateEffect.define<number | null>()

const focusedSrcLineField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFocusedSrc)) return e.value
    }
    return value
  },
})

// 收缩/展开驱动：展开只由「点击标签」显式触发（见 ImageSrcLabelWidget）；
// 此处仅负责「收回」——当编辑器失焦或光标移出图片源码行时，把聚焦行置空。
// 若本次事务已显式设置过聚焦行（点击标签展开），直接跳过，避免竞态把它又收回去。
const imgSrcFocusListener = EditorView.updateListener.of((u) => {
  // 每次更新都刷新模块级 view 引用，保证图片加载回调能可靠触发 requestMeasure
  activeEditorView = u.view
  for (const tr of u.transactions) {
    for (const e of tr.effects) {
      if (e.is(setFocusedSrc)) return
    }
  }
  const view = u.view
  const current = view.state.field(focusedSrcLineField)
  let keep = current
  if (view.hasFocus) {
    const headLine = view.state.doc.lineAt(view.state.selection.main.head)
    if (!IMAGE_RE.test(headLine.text.trim())) keep = null
  } else {
    keep = null
  }
  if (keep !== current) view.dispatch({ effects: setFocusedSrc.of(keep) })
})

/**
 * CSDN 式「带语法实时格式化」的 decoration 来源。
 * 图片块改用行内替换 + CSS display:block（不用 block:true），避免行号 gutter 错位。
 * 必须用 StateField 经 EditorView.decorations.from() 提供（CM6 规范要求）。
 * 装饰还需随 focusedSrcLineField 变化重算（源码行 收缩↔展开）。
 */
function markdownLivePreview() {
  return StateField.define<DecorationSet>({
    create(state) {
      return buildMarkdownDecorations(state, state.field(focusedSrcLineField))
    },
    update(deco, tr) {
      // 文档变化，或语法树异步解析完成（会派发无 docChanged 的事务）时重算装饰，
      // 否则初始加载/编辑后装饰可能缺失或滞后。
      const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state)
      // 聚焦的图片源码行变化（收缩↔展开）也需重算装饰
      const focusedChanged =
        tr.startState.field(focusedSrcLineField) !== tr.state.field(focusedSrcLineField)
      if (tr.docChanged || treeChanged || focusedChanged) {
        return buildMarkdownDecorations(tr.state, tr.state.field(focusedSrcLineField))
      }
      return deco
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}

/**
 * Markdown 编辑器（CSDN 风格）：
 * - 顶部格式化工具栏：不懂语法也能一键插入/包裹 Markdown 语法
 * - 视图模式：编辑 / 分屏(源码+预览) / 预览
 * - 目录(TOC)：从源码解析标题，点击跳转
 * - 预览区只读，点击任意位置自动定位到源码对应行（编辑走源码、预览自动同步）
 * 预览使用与发布管线同一套 markdownToHtml(marked)，保证「所见即所得」。
 */
export function MarkdownEditor({ value, onChange, dark }: MarkdownEditorProps) {
  const cmRef = useRef<ReactCodeMirrorRef>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const syncingRef = useRef(false)
  // 目录跳转期间为 true，临时屏蔽滚动同步，避免与跳转动画互相打架
  const jumpingRef = useRef(false)
  // 用 onCreateEditor 拿到的 view 驱动滚动同步，避免 effect 早于 CM 初始化导致取不到 scrollDOM
  const [editorView, setEditorView] = useState<EditorView | null>(null)
  const [view, setView] = useState<ViewMode>('split')
  const [showToc, setShowToc] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showColorPicker, setShowColorPicker] = useState(false)

  const extensions = useMemo(
    () => [markdown({ base: markdownLanguage }), EditorView.lineWrapping, focusedSrcLineField, imgSrcFocusListener, markdownLivePreview()],
    [],
  )

  const html = useMemo(() => {
    try {
      return markdownToHtml(value || '')
    } catch {
      return ''
    }
  }, [value])

  // 解析标题，用于目录
  const headings = useMemo<Heading[]>(() => {
    const lines = (value || '').split('\n')
    const res: Omit<Heading, 'index'>[] = []
    let inFence = false
    lines.forEach((line, i) => {
      const fence = line.trim().startsWith('```')
      if (fence) {
        inFence = !inFence
        return
      }
      if (inFence) return
      const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
      if (m) res.push({ level: m[1].length, text: m[2], line: i })
    })
    return res.map((h, index) => ({ ...h, index }))
  }, [value])

  // —— 预览区渲染：始终从 md 实时渲染 HTML（预览只读，编辑走源码）——
  // 依赖加入 view：切到「只编辑」再切回时预览 div 会重新挂载，
  // 必须在 view 变化时强制重填 innerHTML，否则会显示空白。
  useEffect(() => {
    const el = previewRef.current
    if (!el) return
    const prevScroll = el.scrollTop
    el.innerHTML = html
    el.scrollTop = prevScroll
  }, [html, view])

  // —— 分屏模式：源码区与预览区按比例同步滚动 ——
  // 依赖 editorView：确保 CodeMirror 初始化完成、scrollDOM 可用后才挂载监听
  useEffect(() => {
    if (view !== 'split' || !editorView) return
    const edScroll = editorView.scrollDOM
    const pv = previewRef.current
    if (!pv) return

    const sync = (from: HTMLElement, to: HTMLElement) => {
      if (jumpingRef.current || syncingRef.current) return
      const fromMax = from.scrollHeight - from.clientHeight
      const toMax = to.scrollHeight - to.clientHeight
      if (fromMax <= 0 && toMax <= 0) return
      // 某侧不可滚动时，按可滚动侧的滚动比例驱动另一侧（至少一侧能滚即可）
      if (fromMax <= 0) {
        // 源不可滚：直接用目标比例清零（保持顶部）
        syncingRef.current = true
        to.scrollTop = 0
      } else {
        syncingRef.current = true
        to.scrollTop = (from.scrollTop / fromMax) * toMax
      }
      requestAnimationFrame(() => { syncingRef.current = false })
    }

    const onEdScroll = () => sync(edScroll, pv)
    const onPvScroll = () => sync(pv, edScroll)
    edScroll.addEventListener('scroll', onEdScroll, { passive: true })
    pv.addEventListener('scroll', onPvScroll, { passive: true })
    return () => {
      edScroll.removeEventListener('scroll', onEdScroll)
      pv.removeEventListener('scroll', onPvScroll)
    }
  }, [view, editorView])

  // 预览区点击：定位到源码对应行，光标跳过去，编辑走源码、预览自动同步。
  // 先在标题中精确匹配；非标题元素做模糊文本搜索（取前 30 个可见字符）。
  const handlePreviewClick = useCallback(
    (e: React.MouseEvent) => {
      const cmView = cmRef.current?.view
      if (!cmView) return

      const target = e.target as HTMLElement
      const heading = target.closest('h1,h2,h3,h4,h5,h6') as HTMLElement | null

      if (heading) {
        const tag = heading.tagName.toLowerCase()
        const level = parseInt(tag[1], 10)
        const hText = (heading.textContent || '').trim()
        // 匹配源码中的标题行
        const prefix = '#'.repeat(level) + ' '
        for (let i = 0; i < headings.length; i++) {
          if (headings[i].text === hText && headings[i].level === level) {
            jumpTo(headings[i])
            return
          }
        }
        // fallback：按前缀 + 文本逐行搜索
        const lines = (value || '').split('\n')
        for (let i = 0; i < lines.length; i++) {
          const clean = lines[i].replace(/\s*#+$/, '').trim()
          if (clean.startsWith(prefix)) {
            const body = clean.slice(prefix.length).trim()
            if (body === hText) {
              const line = cmView.state.doc.line(i + 1)
              cmView.dispatch({ selection: { anchor: line.from } })
              cmView.focus()
              return
            }
          }
        }
        return
      }

      // 非标题：取点击元素文本前 30 个字符，在源码中搜索匹配行
      const text = (target.textContent || '').trim().slice(0, 60)
      if (text.length < 3) return
      const lines = (value || '').split('\n')
      for (let i = 0; i < lines.length; i++) {
        const clean = lines[i].replace(/^[#>*-]+\s*/, '').trim()
        if (clean.length > 0 && clean.includes(text.slice(0, 30))) {
          const lineObj = cmView.state.doc.line(i + 1)
          cmView.dispatch({ selection: { anchor: lineObj.from } })
          // 精确定位到顶部（和目录跳转一致）
          const coords = cmView.coordsAtPos(lineObj.from)
          if (coords) {
            const editorTop = cmView.scrollDOM.getBoundingClientRect().top
            cmView.scrollDOM.scrollTop += coords.top - editorTop - 8
          }
          cmView.focus()
          return
        }
      }
    },
    [value, headings],
  )

  // —— 工具栏操作的底层原语（操作 CodeMirror view）——
  const wrap = (before: string, after: string, placeholder = '文本') => {
    const view = cmRef.current?.view
    if (!view) return
    const { from, to } = view.state.selection.main
    const selected = view.state.sliceDoc(from, to)
    const text = selected || placeholder
    view.dispatch({
      changes: { from, to, insert: before + text + after },
      selection: selected
        ? { anchor: from + before.length, head: from + before.length + text.length }
        : { anchor: from + before.length, head: from + before.length + placeholder.length },
    })
    view.focus()
  }

  const prefixLines = (prefix: string) => {
    const view = cmRef.current?.view
    if (!view) return
    const { state } = view
    const sel = state.selection.main
    const startLine = state.doc.lineAt(sel.from)
    const endLine = state.doc.lineAt(sel.to)
    const changes: { from: number; insert: string }[] = []
    for (let n = startLine.number; n <= endLine.number; n++) {
      changes.push({ from: state.doc.line(n).from, insert: prefix })
    }
    view.dispatch({ changes })
    view.focus()
  }

  const insertBlock = (text: string) => {
    const view = cmRef.current?.view
    if (!view) return
    const { from, to } = view.state.selection.main
    const prev = from > 0 ? view.state.sliceDoc(from - 1, from) : ''
    const next = view.state.sliceDoc(to, to + 1)
    const lead = prev && prev !== '\n' ? '\n' : ''
    const trail = next && next !== '\n' ? '\n' : ''
    const insert = lead + text + trail
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + lead.length + text.length },
    })
    view.focus()
  }

  // 彩色文字：包裹 <span style="color:#xxx">文字</span>（Markdown 透传 HTML）
  const insertColor = (color: string) => {
    const view = cmRef.current?.view
    if (!view) return
    const { from, to } = view.state.selection.main
    const selected = view.state.sliceDoc(from, to)
    const text = selected || '彩色文字'
    const prefix = `<span style="color:${color}">`
    const suffix = '</span>'
    view.dispatch({
      changes: { from, to, insert: prefix + text + suffix },
      selection: selected
        ? { anchor: from + prefix.length, head: from + prefix.length + text.length }
        : { anchor: from + prefix.length, head: from + prefix.length + text.length },
    })
    view.focus()
    setShowColorPicker(false)
  }

  const jumpTo = (h: Heading) => {
    // 临时屏蔽滚动同步：本次跳转由我们显式控制两侧滚动，避免与同步监听互拉
    jumpingRef.current = true

    const cmView = cmRef.current?.view
    if (cmView && (view === 'edit' || view === 'split')) {
      const lineNo = Math.min(h.line + 1, cmView.state.doc.lines)
      const line = cmView.state.doc.line(lineNo)
      // 先设光标到目标行
      cmView.dispatch({ selection: { anchor: line.from } })
      // 手动精确定位：目标行显示在编辑器最顶部（和预览区对齐），不用 scrollIntoView:true
      // —— scrollIntoView 只保证"可见"（常把目标行推到底部），导致预览在顶部、源码在底部的不对称。
      const coords = cmView.coordsAtPos(line.from)
      if (coords) {
        const editorTop = cmView.scrollDOM.getBoundingClientRect().top
        cmView.scrollDOM.scrollTop += coords.top - editorTop - 8
      }
      cmView.focus()
    }

    const pv = previewRef.current
    if (pv && (view === 'split' || view === 'preview')) {
      const hs = pv.querySelectorAll('h1,h2,h3,h4,h5,h6')
      const el = hs[h.index] as HTMLElement | undefined
      if (el) {
        // 直接按标题在预览内容中的实际位置定位（贴近顶部），不用 smooth scrollIntoView
        // 否则会冒泡触发同步监听、与比例同步互拉，导致必须点两次才到位
        const target = el.getBoundingClientRect().top - pv.getBoundingClientRect().top + pv.scrollTop - 8
        pv.scrollTop = target
      }
    }

    // 平滑滚动/重排结束后再恢复同步（覆盖编辑器 scrollIntoView 的动画时长）
    window.setTimeout(() => {
      jumpingRef.current = false
    }, 450)
  }

  const btn = 'p-1.5 rounded-md transition-colors shrink-0'
  const btnColor = dark
    ? 'text-slate-300 hover:bg-slate-700 hover:text-white'
    : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
  const segActive = dark ? 'bg-slate-600 text-white' : 'bg-white text-gray-900 shadow-sm'
  const segIdle = dark ? 'text-slate-400 hover:text-slate-200' : 'text-gray-500 hover:text-gray-700'

  const groups: { icon: typeof Bold; label: string; act: () => void }[][] = [
    [
      { icon: Bold, label: '加粗', act: () => wrap('**', '**', '粗体文本') },
      { icon: Italic, label: '斜体', act: () => wrap('*', '*', '斜体文本') },
      { icon: Code, label: '行内代码', act: () => wrap('`', '`', '代码') },
    ],
    [
      { icon: Heading1, label: '一级标题', act: () => prefixLines('# ') },
      { icon: Heading2, label: '二级标题', act: () => prefixLines('## ') },
      { icon: Heading3, label: '三级标题', act: () => prefixLines('### ') },
    ],
    [
      { icon: List, label: '无序列表', act: () => prefixLines('- ') },
      { icon: ListOrdered, label: '有序列表', act: () => prefixLines('1. ') },
      { icon: Quote, label: '引用', act: () => prefixLines('> ') },
    ],
    [
      { icon: Link2, label: '链接', act: () => wrap('[', '](https://)', '链接文字') },
      { icon: ImageIcon, label: '图片', act: () => wrap('![', '](https://)', '图片描述') },
      { icon: Code2, label: '代码块', act: () => insertBlock('```js\n// 在此粘贴代码\n```') },
      { icon: Table, label: '表格', act: () => insertBlock('| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |') },
      { icon: Minus, label: '分割线', act: () => insertBlock('---') },
    ],
  ]

  const viewOptions: { mode: ViewMode; icon: typeof Pencil; label: string }[] = [
    { mode: 'edit', icon: Pencil, label: '只编辑' },
    { mode: 'split', icon: Columns, label: '分屏' },
    { mode: 'preview', icon: Eye, label: '只预览' },
  ]

  const showEditor = view === 'edit' || view === 'split'
  const showPreview = view === 'split' || view === 'preview'

  return (
    <div
      className={cn(
        'flex flex-1 min-h-0 flex-col rounded-xl border overflow-hidden shadow-sm',
        dark ? 'border-slate-700 bg-slate-900' : 'border-gray-200 bg-white',
      )}
    >
      <style>{`
        /* 图片：独立成行时始终完整尺寸显示（CSDN 风格），不折叠。
           关键：不能用 margin 做间距——margin 在元素盒外，CM 测不准高度，导致后续行号累积错位。
           改用 padding（盒内），CM 一定能正确测量。estimatedHeight 需同步加回 padding 值。 */
        .cm-img-block { display: block; line-height: 1.2; padding: 6px 0; }
        .cm-img-full {
          display: block;
          max-width: 100%;
          max-height: 420px;
          border-radius: 6px;
          border: 1px solid rgba(128,128,128,0.3);
        }
        .cm-img-inline { display: inline-block; vertical-align: middle; line-height: 0; }
        .cm-img-thumb {
          max-height: 80px;
          max-width: 100%;
          border-radius: 4px;
          border: 1px solid rgba(128,128,128,0.3);
          vertical-align: middle;
          margin: 0 2px;
        }
        .cm-img-fallback {
          display: inline-block;
          font-size: 12px;
          color: #94a3b8;
          background: rgba(128,128,128,0.12);
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
        }
        /* 图片源码行收缩态标签：未聚焦时替代图片语法文本，点击/聚焦展开为可编辑文本 */
        .cm-img-src-label {
          display: inline-block;
          font-size: 12px;
          color: #6b7280;
          background: rgba(127,127,127,0.10);
          border: 1px solid rgba(128,128,128,0.25);
          border-radius: 999px;
          padding: 1px 10px;
          margin: 1px 0;
          cursor: pointer;
          user-select: none;
          vertical-align: middle;
          max-width: 90%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cm-img-src-label:hover { border-color: rgba(128,128,128,0.5); color: #374151; }

        /* 标题：字号匹配预览（.article-content h1..h6） */
        .cm-h1 { font-size: 1.9em; font-weight: 700; line-height: 1.35; }
        .cm-h2 { font-size: 1.55em; font-weight: 700; line-height: 1.35; }
        .cm-h3 { font-size: 1.3em; font-weight: 600; line-height: 1.4; }
        .cm-h4 { font-size: 1.15em; font-weight: 600; }
        .cm-h5 { font-size: 1.05em; font-weight: 600; }
        .cm-h6 { font-size: 1em; font-weight: 600; color: #6b7280; }

        /* 行内格式 */
        .cm-strong { font-weight: 700; }
        .cm-em { font-style: italic; }
        .cm-code {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 0.92em;
          background: rgba(127,127,127,0.16);
          padding: 0 4px;
          border-radius: 4px;
        }
        .cm-link { color: #2563eb; }
        .cm-codeblock {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 0.92em;
          background: rgba(127,127,127,0.12);
        }
        .cm-quote {
          border-left: 3px solid #d1d5db;
          padding-left: 12px;
          color: #6b7280;
        }

        /* 语法标记弱化（#、**、括号、URL 等）：放在 .cm-link 之后，URL 等才能以灰显 */
        .cm-md-mark { color: #9ca3af; }

        ${dark ? `
        .cm-h6 { color: #94a3b8; }
        .cm-link { color: #60a5fa; }
        .cm-quote { border-left-color: #475569; color: #94a3b8; }
        .cm-code, .cm-codeblock { background: rgba(148,163,184,0.18); }
        .cm-md-mark { color: #64748b; }
        .cm-img-src-label { color: #94a3b8; background: rgba(148,163,184,0.14); border-color: #475569; }
        .cm-img-src-label:hover { color: #cbd5e1; border-color: #64748b; }
        .cm-img-fallback { color: #94a3b8; background: rgba(148,163,184,0.18); }
        ` : ''}

        /* ===== 精致滚动条（源码区 / 预览区 / 目录区） ===== */
        .cm-scroller::-webkit-scrollbar,
        .article-content::-webkit-scrollbar,
        .overflow-auto::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .cm-scroller::-webkit-scrollbar-track,
        .article-content::-webkit-scrollbar-track,
        .overflow-auto::-webkit-scrollbar-track {
          background: transparent;
        }
        .cm-scroller::-webkit-scrollbar-thumb,
        .article-content::-webkit-scrollbar-thumb,
        .overflow-auto::-webkit-scrollbar-thumb {
          background: rgba(127,127,127,0.22);
          border-radius: 999px;
          transition: background 0.2s;
        }
        .cm-scroller::-webkit-scrollbar-thumb:hover,
        .article-content::-webkit-scrollbar-thumb:hover,
        .overflow-auto::-webkit-scrollbar-thumb:hover {
          background: rgba(127,127,127,0.40);
        }
        .cm-scroller::-webkit-scrollbar-corner,
        .article-content::-webkit-scrollbar-corner,
        .overflow-auto::-webkit-scrollbar-corner {
          background: transparent;
        }

        ${dark ? `
        .cm-scroller::-webkit-scrollbar-thumb,
        .article-content::-webkit-scrollbar-thumb,
        .overflow-auto::-webkit-scrollbar-thumb {
          background: rgba(148,163,184,0.25);
        }
        .cm-scroller::-webkit-scrollbar-thumb:hover,
        .article-content::-webkit-scrollbar-thumb:hover,
        .overflow-auto::-webkit-scrollbar-thumb:hover {
          background: rgba(148,163,184,0.45);
        }
        ` : ''}
      `}</style>
      {/* 工具栏第一行：格式化 */}
      <div
        className={cn(
          'relative flex items-center gap-1 px-2 py-1.5 border-b shrink-0 flex-wrap',
          dark ? 'border-slate-700 bg-slate-800/50' : 'border-gray-100 bg-gray-50',
        )}
      >
        {groups.map((g, gi) => (
          <Fragment key={gi}>
            {gi > 0 && (
              <div className={cn('w-px h-5 mx-1 shrink-0', dark ? 'bg-slate-700' : 'bg-gray-200')} />
            )}
            {g.map((b) => (
              <button
                key={b.label}
                type="button"
                title={b.label}
                onMouseDown={(e) => e.preventDefault()}
                onClick={b.act}
                className={cn(btn, btnColor)}
              >
                <b.icon className="w-4 h-4" />
              </button>
            ))}
          </Fragment>
        ))}

        {/* 彩色文字选择器 */}
        <div className={cn('w-px h-5 mx-1 shrink-0', dark ? 'bg-slate-700' : 'bg-gray-200')} />
        <div className="relative shrink-0">
          <button
            type="button"
            title="彩色文字"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowColorPicker((v) => !v)}
            className={cn(btn, btnColor, showColorPicker && (dark ? 'bg-slate-700 text-white' : 'bg-gray-200 text-gray-900'))}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" />
            </svg>
          </button>
          {showColorPicker && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowColorPicker(false)} />
              <div
                className={cn(
                  'absolute left-0 top-full mt-1 z-20 rounded-xl border shadow-xl p-2 flex gap-1.5',
                  dark ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white',
                )}
              >
                {[
                  { color: '#ef4444', label: '红色' },
                  { color: '#f97316', label: '橙色' },
                  { color: '#eab308', label: '黄色' },
                  { color: '#22c55e', label: '绿色' },
                  { color: '#3b82f6', label: '蓝色' },
                  { color: '#a855f7', label: '紫色' },
                  { color: '#ec4899', label: '粉色' },
                  { color: '#6b7280', label: '灰色' },
                ].map((c) => (
                  <button
                    key={c.color}
                    type="button"
                    title={c.label}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertColor(c.color)}
                    className="w-6 h-6 rounded-full border-2 border-transparent hover:scale-125 transition-transform shadow-sm"
                    style={{ backgroundColor: c.color }}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex-1" />

        <button
          type="button"
          title="Markdown 语法速查"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShowHelp((v) => !v)}
          className={cn(btn, btnColor, showHelp && (dark ? 'bg-slate-700 text-white' : 'bg-gray-200 text-gray-900'))}
        >
          <HelpCircle className="w-4 h-4" />
        </button>

        {showHelp && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setShowHelp(false)} />
            <div
              className={cn(
                'absolute right-2 top-full mt-2 z-20 w-72 rounded-xl border shadow-xl p-3 text-sm',
                dark ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-white',
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <span className={cn('font-medium', dark ? 'text-slate-100' : 'text-gray-800')}>Markdown 语法速查</span>
                <button
                  type="button"
                  onClick={() => setShowHelp(false)}
                  className={cn('p-1 rounded hover:bg-black/5', dark ? 'text-slate-400 hover:bg-white/10' : 'text-gray-400')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {[
                ['# 标题', '一级标题（# 越多字越小）'],
                ['**粗体**', '加粗文字'],
                ['*斜体*', '倾斜文字'],
                ['- 列表项', '无序列表，每行一个'],
                ['> 引用', '引用块'],
                ['`代码`', '行内代码'],
                ['[文字](链接)', '超链接'],
                ['![说明](图链)', '插入图片'],
              ].map(([syn, desc]) => (
                <div key={syn} className="flex items-center justify-between gap-3 mb-1">
                  <code
                    className={cn(
                      'px-1.5 py-0.5 rounded font-mono text-xs',
                      dark ? 'bg-slate-900 text-emerald-300' : 'bg-gray-100 text-emerald-700',
                    )}
                  >
                    {syn}
                  </code>
                  <span className={cn('text-xs text-right', dark ? 'text-slate-400' : 'text-gray-500')}>{desc}</span>
                </div>
              ))}
              <p className={cn('mt-2 text-xs leading-relaxed', dark ? 'text-slate-500' : 'text-gray-400')}>
                点上方按钮自动插入；右侧预览只读，点击任意位置定位到源码对应行编辑。
              </p>
            </div>
          </>
        )}
      </div>

      {/* 工具栏第二行：视图模式 + 目录 */}
      <div
        className={cn(
          'flex items-center gap-2 px-2 py-1 border-b shrink-0',
          dark ? 'border-slate-700 bg-slate-800/30' : 'border-gray-100 bg-gray-50/60',
        )}
      >
        <div className={cn('flex items-center rounded-lg p-0.5 border', dark ? 'border-slate-700 bg-slate-800' : 'border-gray-200 bg-gray-100')}>
          {viewOptions.map((v) => (
            <button
              key={v.mode}
              type="button"
              title={v.label}
              onClick={() => setView(v.mode)}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors',
                view === v.mode ? segActive : segIdle,
              )}
            >
              <v.icon className="w-3.5 h-3.5" />
              {v.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          title="显示目录"
          onClick={() => setShowToc((v) => !v)}
          className={cn(
            'flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors',
            showToc ? segActive : segIdle,
          )}
        >
          <ListTree className="w-3.5 h-3.5" />
          目录
        </button>

        <div className="flex-1" />
        <span className={cn('text-xs', dark ? 'text-slate-500' : 'text-gray-400')}>
          {view === 'edit' ? '仅源码编辑' : view === 'split' ? '源码编辑 + 实时预览' : '实时预览（点击定位源码）'}
        </span>
      </div>

      {/* 主体：目录 + 编辑 + 预览 */}
      <div className="flex flex-1 min-h-0">
        {showToc && (
          <div
            className={cn(
              'w-56 shrink-0 min-w-0 flex flex-col border-r',
              dark ? 'border-slate-700 bg-slate-800/30' : 'border-gray-100 bg-gray-50/50',
            )}
          >
            <div className={cn('px-3 py-1.5 text-xs font-medium border-b shrink-0', dark ? 'border-slate-700 text-slate-400' : 'border-gray-100 text-gray-400')}>
              目录
            </div>
            <div className="flex-1 min-h-0 overflow-auto px-2 py-2">
              {headings.length === 0 && (
                <p className={cn('px-1 text-xs', dark ? 'text-slate-500' : 'text-gray-400')}>暂无标题</p>
              )}
              {headings.map((h) => (
                <button
                  key={`${h.line}-${h.text}`}
                  type="button"
                  onClick={() => jumpTo(h)}
                  className={cn(
                    'block w-full text-left truncate rounded px-2 py-1 text-xs transition-colors',
                    dark ? 'text-slate-300 hover:bg-slate-700' : 'text-gray-600 hover:bg-gray-100',
                  )}
                  style={{ paddingLeft: `${(h.level - 1) * 12 + 8}px` }}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {showEditor && (
          <div className="flex-1 min-w-0 flex flex-col">
            <div
              className={cn(
                'px-3 py-1.5 text-xs font-medium border-b shrink-0 flex items-center gap-1.5',
                dark ? 'border-slate-700 text-slate-400 bg-slate-800/60' : 'border-gray-100 text-gray-400 bg-gray-50',
              )}
            >
              <Pencil className="w-3.5 h-3.5" />
              Markdown 源码
            </div>
            <div className="flex-1 min-h-0">
              <CodeMirror
                ref={cmRef}
                value={value}
                onChange={onChange}
                onCreateEditor={(v) => setEditorView(v)}
                extensions={extensions}
                theme={dark ? 'dark' : 'light'}
                height="100%"
                style={{ height: '100%', fontSize: '14px' }}
                className="h-full"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  highlightActiveLine: true,
                  autocompletion: false,
                  searchKeymap: false,
                }}
              />
            </div>
          </div>
        )}

        {showEditor && showPreview && (
          <div className={cn('w-px shrink-0', dark ? 'bg-slate-700' : 'bg-gray-200')} />
        )}

        {showPreview && (
          <div className="flex-1 min-w-0 flex flex-col">
            <div
              className={cn(
                'px-3 py-1.5 text-xs font-medium border-b shrink-0 flex items-center gap-1.5',
                dark ? 'border-slate-700 text-slate-400 bg-slate-800/60' : 'border-gray-100 text-gray-400 bg-gray-50',
              )}
            >
              <Eye className="w-3.5 h-3.5" />
              实时预览（点击定位源码）
            </div>
            <div
              ref={previewRef}
              onClick={handlePreviewClick}
              className={cn(
                'flex-1 min-h-0 overflow-auto px-6 py-6 article-content cursor-pointer max-w-3xl mx-auto w-full',
                dark ? 'text-slate-200' : 'text-gray-800',
              )}
              style={{ fontSize: '16px', lineHeight: '1.8' }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
