import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Settings, Users, Clock, X, Download, Eye, FileText, Check, Pencil } from 'lucide-react'
import { useSyncStore } from '../stores/sync'
import { SettingsDrawer } from '../components/SettingsDrawer'
import { cn } from '@/lib/utils'
import { trackPageView } from '../../lib/analytics'
import { createLogger } from '../../lib/logger'
import { getCachedUpdateInfo, dismissUpdate, type UpdateCheckResult } from '../../lib/version-check'

const logger = createLogger('HomeNew')

// ========== 显示规则相关 ==========

interface DisplayRule {
  id: string
  pattern: string    // e.g. blog.csdn.net/*/article/details/*
  url: string
  title: string
  createdAt: number
}

const DISPLAY_LIST_KEY = 'syncButtonDisplayList'

/**
 * 从 URL 中提取匹配模式，变量段替换为 *
 * e.g. csdn.net/username/article/details/id → csdn.net / star / article / details / star
 */
function extractUrlPattern(url: string): string {
  try {
    const parsed = new URL(url)
    const parts = [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)]
    const patternParts = parts.map(part => isVariableSegment(part) ? '*' : part)
    return patternParts.join('/')
  } catch {
    return ''
  }
}

/** 判断路径段是否为变量（用户ID、文章ID、slug 等） */
function isVariableSegment(segment: string): boolean {
  if (/^\d+$/.test(segment)) return true
  if (/^[a-f0-9]{8,}$/i.test(segment)) return true
  if (/^[a-z0-9]+(-[a-z0-9]+){1,}$/i.test(segment)) return true
  if (/^[a-z]+\d+$/.test(segment) && segment.length > 6) return true
  return false
}

/**
 * 检查 URL 是否匹配模式（* 匹配任意字符，不跨 /）
 * *.toutiao.com/article/* 匹配 www.toutiao.com/article/123
 */
function urlMatchesPattern(url: string, pattern: string): boolean {
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
        // 含 * 的 glob 模式，如 *.toutiao.com
        const regex = new RegExp('^' + pp.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$')
        if (!regex.test(urlParts[i])) return false
      }
      // pp === '*' → 匹配任意段，不检查
    }
    return true
  } catch {
    return false
  }
}

export function HomeNew() {
  const navigate = useNavigate()
  const {
    article,
    loadArticle,
  } = useSyncStore()

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [allPlatforms, setAllPlatforms] = useState<any[]>([])

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)

  // Display list states
  const [displayList, setDisplayList] = useState<DisplayRule[]>([])
  const [currentPageDisplayed, setCurrentPageDisplayed] = useState(false)
  const [currentTabUrl, setCurrentTabUrl] = useState('')
  const [currentTabTitle, setCurrentTabTitle] = useState('')
  const [addingToDisplayList, setAddingToDisplayList] = useState(false)
  const [loading, setLoading] = useState(true)

  // Load data
  useEffect(() => {
    const init = async () => {
      loadArticle()
      loadPlatformsForEditor()

      // Get current tab info
      let tabUrl = ''
      let tabTitle = ''
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (tab?.url) {
          tabUrl = tab.url
          tabTitle = tab.title || ''
          setCurrentTabUrl(tabUrl)
          setCurrentTabTitle(tabTitle)
        }
      } catch {}

      // Load display list and check match
      await loadDisplayList(tabUrl)

      const cached = await getCachedUpdateInfo()
      if (cached?.hasUpdate && cached.info) {
        setUpdateInfo(cached)
      }

      setLoading(false)
    }
    init()
    trackPageView('home').catch(() => {})
  }, [])

  const loadDisplayList = async (tabUrl?: string) => {
    try {
      const result = await chrome.storage.local.get(DISPLAY_LIST_KEY)
      const rules: DisplayRule[] = result[DISPLAY_LIST_KEY] || []
      setDisplayList(rules)

      const url = tabUrl || currentTabUrl
      if (url && rules.some(r => urlMatchesPattern(url, r.pattern))) {
        setCurrentPageDisplayed(true)
      }
    } catch {
      // ignore
    }
  }

  const loadPlatformsForEditor = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH', payload: { forceRefresh: false } })
      const mapped = (response?.platforms || []).map((p: any) => ({
        id: p.id, name: p.name, icon: p.icon,
        isAuthenticated: p.isAuthenticated, username: p.username,
        homepage: p.homepage,
      }))
      setAllPlatforms(mapped)
    } catch {
      // ignore, editor can still open
    }
  }

  const handleAddToDisplayList = async () => {
    if (!currentTabUrl || addingToDisplayList) return
    setAddingToDisplayList(true)

    try {
      const pattern = extractUrlPattern(currentTabUrl)
      const newRule: DisplayRule = {
        id: `rule_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        pattern,
        url: currentTabUrl,
        title: currentTabTitle || '',
        createdAt: Date.now(),
      }

      const storage = await chrome.storage.local.get(DISPLAY_LIST_KEY)
      const existing: DisplayRule[] = storage[DISPLAY_LIST_KEY] || []
      const updated = [...existing, newRule]
      await chrome.storage.local.set({ [DISPLAY_LIST_KEY]: updated })

      setDisplayList(updated)
      setCurrentPageDisplayed(true)
    } catch (e) {
      logger.error('Failed to add to display list:', e)
    } finally {
      setAddingToDisplayList(false)
    }
  }

  // Open editor for article preview & sync
  const handleOpenEditor = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'OPEN_EDITOR',
        platforms: allPlatforms,
      })
      window.close()
    }
  }

  return (
    <div className="flex flex-col h-[500px] relative">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center justify-between px-4 py-2.5 border-b">
        <div className="flex items-center gap-2">
          <img src="/assets/icon-48.png" alt="Logo" className="w-6 h-6" />
          <h1 className="font-semibold">文章同步助手</h1>
        </div>
        <nav className="flex items-center gap-0.5">
          <button
            onClick={() => navigate('/account-list')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Users className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">账号列表</span>
          </button>
          <button
            onClick={() => navigate('/history')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Clock className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">历史</span>
          </button>
          <button
            onClick={() => navigate('/display-list')}
            className="flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg hover:bg-muted transition-colors"
          >
            <Eye className="w-3.5 h-3.5" />
            <span className="text-[10px] text-muted-foreground leading-none">按钮规则</span>
          </button>
        </nav>
      </header>

      {/* Version update banner */}
      {updateInfo?.hasUpdate && updateInfo.info && (
        <div className="px-4 pt-3">
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-lg p-3 text-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
                <Download className="w-4 h-4" />
                <span>新版本 v{updateInfo.info.version} 可用</span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={updateInfo.info.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
                >
                  下载
                </a>
                <button
                  onClick={async () => {
                    if (updateInfo.info) {
                      await dismissUpdate(updateInfo.info.version)
                      chrome.runtime.sendMessage({ type: 'CLEAR_UPDATE_BADGE' }).catch(() => {})
                      setUpdateInfo(null)
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground"
                  title="忽略此版本"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {updateInfo.info.releaseNotes && (
              <p className="text-xs text-muted-foreground mt-1">{updateInfo.info.releaseNotes}</p>
            )}
          </div>
        </div>
      )}

      {/* 同步按钮显示切换区域 — 仅在已检测到文章时显示 */}
      {article && currentTabUrl && (
        <div className="px-4 pt-3 pb-1">
          <div className={cn(
            'rounded-lg p-2.5 border',
            currentPageDisplayed
              ? 'bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-900'
              : 'bg-muted/40 border-border'
          )}>
            {currentPageDisplayed ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Eye className="w-4 h-4 text-green-600 dark:text-green-400" />
                  <div>
                    <span className="text-xs font-medium text-green-700 dark:text-green-400">
                      已显示同步按钮
                    </span>
                    <span className="text-[10px] text-green-600 dark:text-green-500 ml-1.5">
                      下次自动显示
                    </span>
                  </div>
                </div>
                <button
                  disabled
                  className="text-[10px] px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 opacity-60 cursor-not-allowed"
                >
                  已启用
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Eye className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <span className="text-xs font-medium">
                      显示同步按钮
                    </span>
                    <span className="text-[10px] text-muted-foreground ml-1">
                      智能分析当前链接并自动匹配
                    </span>
                  </div>
                </div>
                <button
                  onClick={handleAddToDisplayList}
                  disabled={addingToDisplayList}
                  className={cn(
                    'text-[10px] px-2 py-0.5 rounded font-medium transition-colors',
                    addingToDisplayList
                      ? 'bg-muted text-muted-foreground cursor-not-allowed'
                      : 'bg-primary/10 text-primary hover:bg-primary/20'
                  )}
                >
                  {addingToDisplayList ? '分析中...' : '点击启用'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 文章检测 + 操作区 */}
      <div className="flex-1 p-4 flex flex-col">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            加载中...
          </div>
        ) : article ? (
          /* 已检测到文章 */
          <div className="flex-1 flex flex-col">
            <div className="rounded-lg p-3 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-900">
              <div className="flex items-center gap-1.5 mb-2">
                <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                <span className="text-xs font-medium text-green-700 dark:text-green-400">
                  已识别文章
                </span>
              </div>
              <div className="flex gap-3">
                {article.cover && (
                  <img
                    src={article.cover}
                    alt=""
                    className="w-16 h-16 rounded object-cover flex-shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  <h2 className="font-medium text-sm line-clamp-2">{article.title}</h2>
                  {article.summary && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                      {article.summary}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* 前往调整并同步按钮 */}
            <div className="mt-auto">
              <button
                onClick={handleOpenEditor}
                className="w-full py-2.5 rounded-lg font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
              >
                <Pencil className="w-4 h-4" />
                调整并同步
              </button>
              <p className="text-[10px] text-muted-foreground text-center mt-2">
                点击后进入编辑器预览和调整内容，选择平台后同步
              </p>
            </div>
          </div>
        ) : (
          /* 未检测到文章 */
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
            <FileText className="w-10 h-10 mb-3 opacity-40" />
            <p className="text-sm">当前页面未检测到文章</p>
            <p className="text-xs mt-1 opacity-60">
              请在文章页面打开此插件
            </p>
          </div>
        )}
      </div>

      {/* 左下角设置按钮 */}
      <button
        onClick={() => setSettingsOpen(true)}
        className="absolute bottom-2 left-2 p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        title="设置"
      >
        <Settings className="w-4 h-4" />
      </button>

      {/* Settings drawer */}
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  )
}
