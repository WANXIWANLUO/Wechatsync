import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, ExternalLink, User, ShieldAlert, Check } from 'lucide-react'
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
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CHECK_ALL_AUTH',
          payload: { forceRefresh: true },
        })
        setPlatforms(response?.platforms || [])
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const authenticated = platforms.filter(p => p.isAuthenticated)
  const unauthenticated = platforms.filter(p => !p.isAuthenticated)

  const handleAuthorize = (platform: PlatformInfo) => {
    // 打开平台主页，用户登录后 cookie 会被自动检测
    if (platform.homepage) {
      window.open(platform.homepage, '_blank')
    }
  }

  return (
    <div className="flex flex-col h-[500px]">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center gap-3 px-4 py-2.5 border-b">
        <button
          onClick={() => navigate('/')}
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-semibold">账号列表</h1>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            加载中...
          </div>
        ) : (
          <>
            {/* 已登录 */}
            <section>
              <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-3">
                <Check className="w-3.5 h-3.5 text-green-500" />
                已登录 · {authenticated.length}
              </h2>
              {authenticated.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">
                  暂无已登录平台
                </p>
              ) : (
                <div className="space-y-2">
                  {authenticated.map(p => (
                    <div
                      key={p.id}
                      className="flex items-center gap-3 p-2.5 bg-muted/40 rounded-lg"
                    >
                      <img
                        src={p.icon}
                        alt={p.name}
                        className="w-8 h-8 rounded object-contain flex-shrink-0"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none'
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {p.username || '已认证'}
                        </p>
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
                <p className="text-xs text-muted-foreground text-center py-6">
                  全部已授权
                </p>
              ) : (
                <div className="space-y-2">
                  {unauthenticated.map(p => (
                    <div
                      key={p.id}
                      className="flex items-center gap-3 p-2.5 bg-muted/40 rounded-lg"
                    >
                      <img
                        src={p.icon}
                        alt={p.name}
                        className="w-8 h-8 rounded object-contain flex-shrink-0 opacity-50"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none'
                        }}
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{p.name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {p.homepage ? new URL(p.homepage).hostname : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => handleAuthorize(p)}
                        className={cn(
                          'flex-shrink-0 text-xs px-2.5 py-1 rounded-md font-medium transition-colors',
                          'bg-primary/10 text-primary hover:bg-primary/20',
                        )}
                      >
                        去授权
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  )
}
