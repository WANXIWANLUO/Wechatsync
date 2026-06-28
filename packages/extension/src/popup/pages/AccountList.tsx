import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ExternalLink, ShieldAlert, Check, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PlatformInfo {
  id: string
  name: string
  icon: string
  homepage: string
  isAuthenticated: boolean
  username?: string
  sourceType: 'dsl' | 'cms'
}

export function AccountListPage() {
  const navigate = useNavigate()
  const [platforms, setPlatforms] = useState<PlatformInfo[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [firstLoad, setFirstLoad] = useState(true)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CHECK_ALL_AUTH',
        payload: { forceRefresh: true },
      })
      if (response?.platforms?.length) {
        setPlatforms(response.platforms.filter((p: PlatformInfo) => p.id !== 'zip-download'))
      }
    } catch { /* ignore */ }
    setRefreshing(false)
    setFirstLoad(false)
  }, [])

  useEffect(() => {
    chrome.storage.local.get('platformListCache').then(cached => {
      if (cached.platformListCache?.length) {
        setPlatforms(cached.platformListCache.filter((p: PlatformInfo) => p.id !== 'zip-download'))
        setFirstLoad(false)
      }
    }).catch(() => {})
  }, [])

  const authenticated = platforms.filter(p => p.isAuthenticated)
  const unauthenticated = platforms.filter(p => !p.isAuthenticated)

  const handleAuthorize = (platform: PlatformInfo) => {
    if (platform.homepage) {
      chrome.tabs.create({ url: platform.homepage, active: true })
    }
  }

  // 首次进入且缓存为空：显示加载
  if (firstLoad && platforms.length === 0 && !refreshing) {
    return (
      <div className="flex flex-col h-[500px]">
        <header className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-b">
          <button onClick={() => navigate('/')} className="p-1 rounded hover:bg-muted transition-colors">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <h1 className="font-semibold flex-1">账号列表</h1>
        </header>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground text-sm gap-3">
          <RefreshCw className="w-5 h-5 animate-spin" />
          <p>正在加载平台列表…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[500px]">
      <header className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-b">
        <button onClick={() => navigate('/')} className="p-1 rounded hover:bg-muted transition-colors">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-semibold flex-1">账号列表</h1>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="p-1 rounded hover:bg-muted transition-colors"
          title="刷新认证状态"
        >
          <RefreshCw className={cn('w-4 h-4', refreshing && 'animate-spin')} />
        </button>
      </header>

      {refreshing && (
        <div className="flex-shrink-0 flex items-center justify-center gap-2 text-xs text-muted-foreground py-1 border-b">
          <RefreshCw className="w-3 h-3 animate-spin" />
          检查平台状态中…
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* 已登录 */}
        <section>
          <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-3">
            <Check className="w-3.5 h-3.5 text-green-500" />
            已登录 · {authenticated.length}
          </h2>
          {authenticated.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">暂无已登录平台</p>
          ) : (
            <div className="space-y-2">
              {authenticated.map(p => (
                <div key={p.id} className="flex items-center gap-3 p-2.5 bg-muted/40 rounded-lg">
                  <img
                    src={p.icon}
                    alt={p.name}
                    className="w-8 h-8 rounded object-contain flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{p.username || '已认证'}</p>
                  </div>
                  <a
                    href={p.homepage}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-shrink-0 p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                    title="访问主页"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 未登录 */}
        <section>
          <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-3">
            <ShieldAlert className="w-3.5 h-3.5 text-orange-500" />
            未授权 · {unauthenticated.length}
          </h2>
          {unauthenticated.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-6">全部已授权</p>
          ) : (
            <div className="space-y-2">
              {unauthenticated.map(p => (
                <div key={p.id} className="flex items-center gap-3 p-2.5 bg-muted/40 rounded-lg">
                  <img
                    src={p.icon}
                    alt={p.name}
                    className="w-8 h-8 rounded object-contain flex-shrink-0 opacity-50"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {p.homepage ? new URL(p.homepage).hostname : ''}
                        </p>
                  </div>
                  <button
                    onClick={() => handleAuthorize(p)}
                    className="flex-shrink-0 text-xs px-2.5 py-1 rounded-md font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  >
                    去授权
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
