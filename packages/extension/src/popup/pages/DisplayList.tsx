import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Trash2, Eye, Globe, ExternalLink } from 'lucide-react'
import { Button } from '../components/ui/Button'

interface DisplayRule {
  id: string
  hostname: string
  pathPrefix: string
  url: string
  title: string
  createdAt: number
}

const STORAGE_KEY = 'syncButtonDisplayList'

export function DisplayListPage() {
  const navigate = useNavigate()
  const [rules, setRules] = useState<DisplayRule[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadRules()
  }, [])

  const loadRules = async () => {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY)
      setRules(result[STORAGE_KEY] || [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  const deleteRule = async (id: string) => {
    const updated = rules.filter(r => r.id !== id)
    await chrome.storage.local.set({ [STORAGE_KEY]: updated })
    setRules(updated)
  }

  const clearAll = async () => {
    await chrome.storage.local.remove(STORAGE_KEY)
    setRules([])
  }

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleDateString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatPattern = (rule: DisplayRule): string => {
    if (!rule.pathPrefix || rule.pathPrefix === '/') {
      return rule.hostname + '/*'
    }
    return rule.hostname + rule.pathPrefix + '*'
  }

  const hasActiveRule = (hostname: string): string | undefined => {
    // Identify what platform the hostname might belong to
    if (hostname.includes('csdn')) return 'CSDN'
    if (hostname.includes('github')) return 'GitHub'
    if (hostname.includes('juejin')) return '掘金'
    if (hostname.includes('zhihu')) return '知乎'
    if (hostname.includes('segmentfault')) return '思否'
    if (hostname.includes('jianshu')) return '简书'
    if (hostname.includes('medium')) return 'Medium'
    if (hostname.includes('dev.to')) return 'dev.to'
    if (hostname.includes('blog')) return '博客'
    return undefined
  }

  if (loading) {
    return (
      <div className="p-4 h-full flex flex-col">
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
          加载中...
        </div>
      </div>
    )
  }

  return (
    <div className="p-4 h-full flex flex-col">
      {/* 返回按钮 */}
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="w-4 h-4" />
        返回
      </button>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground">
          {rules.length === 0 ? '显示列表' : `已保存 ${rules.length} 条规则`}
        </h2>
        {rules.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearAll}
            className="text-xs text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="w-3.5 h-3.5 mr-1" />
            清空
          </Button>
        )}
      </div>

      {rules.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <Eye className="w-12 h-12 mb-4 opacity-50" />
          <p className="text-sm">暂无显示规则</p>
          <p className="text-xs mt-1 opacity-70">
            在主页打开文章页面后，点击"显示同步按钮"添加规则
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto space-y-2">
          {rules.map(rule => (
            <div
              key={rule.id}
              className="p-3 rounded-lg border border-border bg-card hover:bg-muted/30 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  {/* URL 匹配模式 */}
                  <div className="flex items-center gap-1.5 mb-1">
                    <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded truncate block">
                      {formatPattern(rule)}
                    </code>
                    {hasActiveRule(rule.hostname) && (
                      <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded flex-shrink-0">
                        {hasActiveRule(rule.hostname)}
                      </span>
                    )}
                  </div>

                  {/* 添加时的页面标题 */}
                  {rule.title && (
                    <p className="text-xs text-muted-foreground truncate mb-1">
                      添加自: {rule.title}
                    </p>
                  )}

                  {/* 时间和操作 */}
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[10px] text-muted-foreground">
                      {formatTime(rule.createdAt)}
                    </span>
                    <div className="flex items-center gap-2">
                      {rule.url && (
                        <a
                          href={rule.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          title="打开原始页面"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <button
                        onClick={() => deleteRule(rule.id)}
                        className="text-muted-foreground hover:text-destructive transition-colors"
                        title="删除此规则，下次不再自动显示同步按钮"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 底部提示 */}
      {rules.length > 0 && (
        <div className="flex-shrink-0 mt-3 pt-3 border-t">
          <p className="text-[10px] text-muted-foreground text-center">
            删除规则后，对应页面将不再自动显示同步按钮
          </p>
        </div>
      )}
    </div>
  )
}
