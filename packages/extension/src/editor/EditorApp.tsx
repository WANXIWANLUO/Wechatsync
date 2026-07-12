import { useState, useRef, useEffect, useCallback } from 'react'
import { X, Loader2, Sun, Moon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SyncDialog } from '@/components/sync-dialog'
import type { Platform, SyncResult, PlatformProgress } from '@/components/sync-dialog/types'
import { createLogger } from '../lib/logger'
import { htmlToMarkdownNative, markdownToHtml } from '@wechatsync/core'
import { MarkdownEditor } from './MarkdownEditor'

const logger = createLogger('Editor')

interface Article {
  title: string
  content: string
  cover?: string
  url?: string
  extractor?: string
}

type SyncStatus = 'idle' | 'syncing' | 'completed'

const SELECTED_PLATFORMS_KEY = 'selectedPlatforms'

function saveSelectedPlatforms(platformIds: string[]) {
  chrome.storage.local.set({ [SELECTED_PLATFORMS_KEY]: platformIds }).catch((e) => {
    logger.error('Failed to save selected platforms:', e)
  })
}

export function EditorApp() {
  const [article, setArticle] = useState<Article | null>(null)
  const [platforms, setPlatforms] = useState<Platform[]>([])
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([])
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [results, setResults] = useState<SyncResult[]>([])
  const [error, setError] = useState<string | null>(null)
  const [rateLimitWarning, setRateLimitWarning] = useState<string | null>(null)
  const [platformProgress, setPlatformProgress] = useState<Map<string, PlatformProgress>>(new Map())
  const [currentSyncId, setCurrentSyncId] = useState<string | null>(null)
  const currentSyncIdRef = useRef<string | null>(null)
  const [showSyncDialog, setShowSyncDialog] = useState(false)

  // 仅 Markdown 模式
  const [mdContent, setMdContent] = useState('')
  const [isDark, setIsDark] = useState<boolean>(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  )
  // 封面预览弹层
  const [coverOpen, setCoverOpen] = useState(false)
  // 标题是否聚焦（聚焦时允许换行，便于编辑长标题）
  const [titleFocused, setTitleFocused] = useState(false)

  const handleToggleTheme = () => setIsDark((v) => !v)

  useEffect(() => {
    currentSyncIdRef.current = currentSyncId
  }, [currentSyncId])

  const titleRef = useRef<HTMLHeadingElement>(null)

  // Receive messages from parent window
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data

        if (data.syncId) {
          if (!currentSyncIdRef.current) {
            setCurrentSyncId(data.syncId)
          } else if (data.syncId !== currentSyncIdRef.current) {
            logger.debug('Ignoring message with different syncId:', data.syncId, 'current:', currentSyncIdRef.current)
            return
          }
        }

        logger.debug('Received message:', data)

        if (data.type === 'ARTICLE_DATA') {
          setArticle(data.article)
          // 仅 Markdown：把原始 HTML 内容转成 Markdown 源码初始化编辑器
          setMdContent(htmlToMarkdownNative(data.article.content || ''))
        } else if (data.type === 'PLATFORMS_DATA') {
          setPlatforms(data.platforms)
          if (data.selectedPlatformIds && data.selectedPlatformIds.length > 0) {
            setSelectedPlatforms(data.selectedPlatformIds)
            saveSelectedPlatforms(data.selectedPlatformIds)
          } else {
            chrome.storage.local.get(SELECTED_PLATFORMS_KEY).then((result) => {
              const storedPlatforms = result[SELECTED_PLATFORMS_KEY] as string[] | undefined
              const authenticated = data.platforms.filter((p: Platform) => p.isAuthenticated)
              const authenticatedIds = authenticated.map((p: Platform) => p.id)
              const authenticatedSet = new Set(authenticatedIds)

              const selected = storedPlatforms
                ? storedPlatforms.filter(id => authenticatedSet.has(id))
                : []
              setSelectedPlatforms(selected)
            }).catch((e) => {
              logger.error('Failed to load selected platforms:', e)
              setSelectedPlatforms([])
            })
          }
        } else if (data.type === 'SYNC_PROGRESS') {
          if (data.result) {
            setResults(prev => {
              const next = [...prev, data.result]
              // Auto-transition to completed when all platforms are done
              // (handles case where editor stays open throughout sync)
              return next
            })
          }
        } else if (data.type === 'SYNC_DETAIL_PROGRESS') {
          const progress = data.progress
          if (progress?.platform) {
            setPlatformProgress(prev => {
              const next = new Map(prev)
              next.set(progress.platform, progress)
              return next
            })
          }
        } else if (data.type === 'SYNC_COMPLETE') {
          setStatus('completed')
          if (data.rateLimitWarning) {
            setRateLimitWarning(data.rateLimitWarning)
            setTimeout(() => setRateLimitWarning(null), 8000)
          }
        } else if (data.type === 'SYNC_ERROR') {
          setError(data.error)
          setStatus('idle')
        }
      } catch (e) {
        logger.error('Failed to parse message:', e)
      }
    }

    window.addEventListener('message', handleMessage)
    window.parent.postMessage(JSON.stringify({ type: 'EDITOR_READY' }), '*')
    return () => window.removeEventListener('message', handleMessage)
  }, [])

  // Auto-detect completion from results
  useEffect(() => {
    if (status === 'syncing' && results.length > 0 && results.length >= selectedPlatforms.length) {
      setStatus('completed')
    }
  }, [results.length, selectedPlatforms.length, status])

  const handleClose = useCallback(() => {
    window.parent.postMessage(JSON.stringify({ type: 'CLOSE_EDITOR' }), '*')
  }, [])

  // Get edited article content
  const getEditedArticle = useCallback(() => {
    if (!article) return null
    const title = titleRef.current?.innerText || article.title
    // 仅 Markdown：content 用 html 形式（供 HTML 平台），
    // markdown 保留原始源码（供 Markdown 平台，避免 md→html→md 往返损耗）
    return {
      ...article,
      title,
      content: markdownToHtml(mdContent),
      markdown: mdContent,
    }
  }, [article, mdContent])

  // ── SyncDialog action handlers ──

  const handleTogglePlatform = (id: string) => {
    setSelectedPlatforms(prev => {
      const set = new Set(prev)
      if (set.has(id)) set.delete(id)
      else set.add(id)
      const next = Array.from(set)
      saveSelectedPlatforms(next)
      return next
    })
  }

  const handleSelectAll = () => {
    const allIds = platforms.filter(p => p.isAuthenticated).map(p => p.id)
    setSelectedPlatforms(allIds)
    saveSelectedPlatforms(allIds)
  }

  const handleDeselectAll = () => {
    setSelectedPlatforms([])
    saveSelectedPlatforms([])
  }

  const handleStartSync = () => {
    const editedArticle = getEditedArticle()
    if (!editedArticle || selectedPlatforms.length === 0) return

    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    setCurrentSyncId(syncId)
    setStatus('syncing')
    setResults([])
    setError(null)
    setPlatformProgress(new Map())

    window.parent.postMessage(JSON.stringify({
      type: 'START_SYNC',
      article: editedArticle,
      platforms: selectedPlatforms,
      syncId,
    }), '*')
  }

  const handleRetryFailed = () => {
    const failedPlatforms = results.filter(r => !r.success).map(r => r.platform)
    if (failedPlatforms.length === 0) return

    const editedArticle = getEditedArticle()
    if (!editedArticle) return

    const syncId = `sync_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    setCurrentSyncId(syncId)
    setStatus('syncing')
    setResults(prev => prev.filter(r => r.success))
    setPlatformProgress(new Map())

    window.parent.postMessage(JSON.stringify({
      type: 'START_SYNC',
      article: editedArticle,
      platforms: failedPlatforms,
      syncId,
    }), '*')
  }

  const handleReset = () => {
    setStatus('idle')
    setResults([])
    setError(null)
    setPlatformProgress(new Map())
    setCurrentSyncId(null)
    setShowSyncDialog(false)
  }

  if (!article) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400 mx-auto" />
          <p className="mt-2 text-gray-500">加载文章中...</p>
        </div>
      </div>
    )
  }

  const authenticatedCount = platforms.filter(p => p.isAuthenticated).length

  return (
    <div className={cn('h-screen flex flex-col bg-gray-50 transition-colors', isDark && 'dark')}>
      {/* Toolbar — inner width follows article content */}
      <header className={cn('shrink-0 border-b shadow-sm z-50 transition-colors', isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-gray-200')}>
        <div className="max-w-[1400px] w-full mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            {/* 封面缩略图：点击展开大图 */}
            {article?.cover && (
              <button
                type="button"
                onClick={() => setCoverOpen(true)}
                title="查看封面大图"
                className={cn(
                  'w-8 h-8 rounded-md overflow-hidden border shrink-0 transition-transform hover:scale-105',
                  isDark ? 'border-slate-700' : 'border-gray-200',
                )}
              >
                <img src={article.cover} alt="封面缩略图" className="w-full h-full object-cover" />
              </button>
            )}
            {/* 标题放在 header，点选即可编辑 */}
            <div
              ref={titleRef}
              contentEditable
              suppressContentEditableWarning
              onFocus={() => setTitleFocused(true)}
              onBlur={() => setTitleFocused(false)}
              title="点击编辑标题"
              className={cn(
                'flex-1 min-w-0 text-sm font-medium rounded px-2 py-1 outline-none transition-colors cursor-text',
                titleFocused ? 'whitespace-normal' : 'truncate',
                isDark ? 'text-slate-100 hover:bg-slate-800/60 focus:bg-slate-800/60' : 'text-gray-800 hover:bg-gray-100 focus:bg-blue-50',
              )}
            >
              {article.title}
            </div>
            {article?.extractor && (
              <span className="px-2 py-0.5 text-xs font-mono bg-gray-100 text-gray-500 rounded opacity-0 hover:opacity-100 transition-opacity shrink-0" title="Content extractor used">
                {article.extractor}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleToggleTheme}
              className={cn('p-2 rounded-lg transition-colors shrink-0', isDark ? 'hover:bg-slate-800 text-slate-300' : 'hover:bg-gray-100 text-gray-500')}
              title={isDark ? '切换为浅色' : '切换为深色'}
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={() => setShowSyncDialog(true)}
              className={cn(
                'px-4 py-2 rounded-lg font-medium transition-colors shrink-0',
                authenticatedCount > 0
                  ? 'bg-blue-500 text-white hover:bg-blue-600'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              )}
              disabled={authenticatedCount === 0}
            >
              同步{selectedPlatforms.length > 0 ? ` (${selectedPlatforms.length})` : ''}
            </button>

            <button
              onClick={handleClose}
              className={cn('p-2 rounded-lg transition-colors shrink-0', isDark ? 'hover:bg-slate-800' : 'hover:bg-gray-100')}
              title="关闭"
            >
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>
      </header>

      {/* 封面大图弹层 */}
      {coverOpen && article?.cover && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-8"
          onClick={() => setCoverOpen(false)}
        >
          <button
            type="button"
            onClick={() => setCoverOpen(false)}
            className="absolute right-4 top-4 p-2 rounded-lg bg-white/10 text-white hover:bg-white/20 transition-colors"
            title="关闭"
          >
            <X className="w-5 h-5" />
          </button>
          <img
            src={article.cover}
            alt="封面大图"
            className="max-w-full max-h-full rounded-xl shadow-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {/* Rate limit warning */}
      {rateLimitWarning && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[60] animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 shadow-lg flex items-center gap-2 max-w-md">
            <span className="text-lg flex-shrink-0">⚠️</span>
            <p className="text-sm text-yellow-800 flex-1">{rateLimitWarning}</p>
            <button
              onClick={() => setRateLimitWarning(null)}
              className="text-yellow-600 hover:text-yellow-800 flex-shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Article content area — 占满 header 以下全部空间 */}
      <main className={cn('flex-1 min-h-0 flex flex-col py-3', isDark ? 'bg-slate-950' : 'bg-gray-50')}>
        <div className="flex flex-1 min-h-0 max-w-[1400px] w-full mx-auto px-4">
          <MarkdownEditor value={mdContent} onChange={setMdContent} dark={isDark} />
        </div>

        <style>{`
          .article-content p { margin-bottom: 1em; }
          .article-content h1 { font-size: 2em; font-weight: bold; margin: 1em 0 0.5em; }
          .article-content h2 { font-size: 1.5em; font-weight: bold; margin: 1em 0 0.5em; }
          .article-content h3 { font-size: 1.25em; font-weight: 600; margin: 0.8em 0 0.4em; }
          .article-content img { width: 100% !important; max-width: 100% !important; height: auto !important; margin: 1em 0; display: block; }
          .article-content pre { background: #f5f5f5; padding: 1em; border-radius: 6px; overflow-x: auto; margin: 1em 0; font-size: 14px; }
          .article-content code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
          .article-content pre code { background: none; padding: 0; }
          .article-content blockquote { border-left: 4px solid #ddd; padding-left: 1em; margin: 1em 0; color: #666; font-style: italic; }
          .article-content ul { list-style: disc; padding-left: 2em; margin: 1em 0; }
          .article-content ol { list-style: decimal; padding-left: 2em; margin: 1em 0; }
          .article-content li { margin-bottom: 0.5em; }
          .article-content a { color: #2563eb; text-decoration: underline; }
          .article-content table { border-collapse: collapse; width: 100%; margin: 1em 0; }
          .article-content th, .article-content td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
          .article-content th { background: #f5f5f5; font-weight: 600; }
          .article-content hr { border: none; border-top: 1px solid #ddd; margin: 2em 0; }
          .article-content strong { font-weight: 600; }
          .article-content em { font-style: italic; }
          /* 深色模式 */
          .dark .article-content { color: #e2e8f0; }
          .dark .article-content pre { background: #1e293b; }
          .dark .article-content code { background: #334155; }
          .dark .article-content blockquote { border-left-color: #475569; color: #94a3b8; }
          .dark .article-content a { color: #60a5fa; }
          .dark .article-content th, .dark .article-content td { border-color: #475569; }
          .dark .article-content th { background: #1e293b; }
          .dark .article-content hr { border-top-color: #475569; }
        `}</style>
      </main>

      {/* Sync Dialog overlay */}
      {showSyncDialog && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => {
              if (status === 'idle') setShowSyncDialog(false)
            }}
          />
          {/* Dialog */}
          <div className="relative bg-white rounded-xl shadow-2xl w-[400px] max-h-[520px] overflow-hidden">
            {/* Dialog header */}
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="font-semibold text-gray-900">文章同步</span>
              <button
                onClick={() => {
                  if (status !== 'syncing') {
                    handleReset()
                  }
                }}
                className="p-1 rounded hover:bg-gray-100 transition-colors"
              >
                <X className="w-4 h-4 text-gray-500" />
              </button>
            </div>

            <SyncDialog
              article={article}
              platforms={platforms}
              status={status === 'idle' ? 'idle' : status === 'syncing' ? 'syncing' : 'completed'}
              selectedPlatforms={selectedPlatforms}
              results={results}
              platformProgress={platformProgress}
              error={error}
              onTogglePlatform={handleTogglePlatform}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
              onStartSync={handleStartSync}
              onRetryFailed={handleRetryFailed}
              onReset={handleReset}
              onCancel={handleReset}
              className="max-h-[460px]"
              hideArticleCard
            />
          </div>
        </div>
      )}

      {/* Error toast */}
      {error && !showSyncDialog && (
        <div className="fixed bottom-4 left-4 bg-red-50 border border-red-200 rounded-lg p-4 max-w-sm z-50">
          <p className="text-red-700 text-sm">{error}</p>
          <button
            onClick={() => setError(null)}
            className="mt-2 text-red-500 hover:underline text-sm"
          >
            关闭
          </button>
        </div>
      )}
    </div>
  )
}
