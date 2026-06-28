import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, Trash2, Eye, Pencil, Check, X } from 'lucide-react'
import { Button } from '../components/ui/Button'

interface DisplayRule {
  id: string
  pattern: string
  tag?: string
  url: string
  title: string
  createdAt: number
}

const STORAGE_KEY = 'syncButtonDisplayList'

const TAG_MAP: Record<string, string> = {
  'mp.weixin.qq.com': '公众号',
  'weixin': '公众号',
  'toutiao': '头条',
  'csdn': 'CSDN',
  'github': 'GitHub',
  'juejin': '掘金',
  'zhihu': '知乎',
  'segmentfault': '思否',
  'jianshu': '简书',
  'medium': 'Medium',
  'dev.to': 'dev.to',
}

function getTag(hostname: string): string | undefined {
  for (const [key, label] of Object.entries(TAG_MAP)) {
    if (hostname.includes(key)) return label
  }
  if (hostname.includes('blog')) return '博客'
  return undefined
}

export function DisplayListPage() {
  const navigate = useNavigate()
  const [rules, setRules] = useState<DisplayRule[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editPattern, setEditPattern] = useState('')
  const [editTag, setEditTag] = useState('')

  useEffect(() => { loadRules() }, [])

  const loadRules = async () => {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY)
      setRules(result[STORAGE_KEY] || [])
    } catch { } finally { setLoading(false) }
  }

  const saveRules = async (updated: DisplayRule[]) => {
    await chrome.storage.local.set({ [STORAGE_KEY]: updated })
    setRules(updated)
  }

  const deleteRule = async (id: string) => {
    await saveRules(rules.filter(r => r.id !== id))
  }

  const clearAll = async () => {
    await chrome.storage.local.remove(STORAGE_KEY)
    setRules([])
  }

  const startEdit = (rule: DisplayRule) => {
    setEditingId(rule.id)
    setEditPattern(rule.pattern)
    setEditTag(rule.tag || getTag(rule.pattern.split('/')[0]) || '')
  }

  const cancelEdit = () => { setEditingId(null); setEditPattern(''); setEditTag('') }

  const saveEdit = async () => {
    if (!editingId || !editPattern.trim()) return
    const tag = editTag.trim() || undefined
    await saveRules(rules.map(r => r.id === editingId ? { ...r, pattern: editPattern.trim(), tag } : r))
    cancelEdit()
  }

  if (loading) {
    return (
      <div className="p-4 h-full flex flex-col">
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">加载中...</div>
      </div>
    )
  }

  return (
    <div className="p-4 h-full flex flex-col">
      <button onClick={() => navigate('/')} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-4">
        <ArrowLeft className="w-4 h-4" />返回
      </button>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-medium text-muted-foreground">
          {rules.length === 0 ? '显示列表' : `已保存 ${rules.length} 条规则`}
        </h2>
        {rules.length > 0 && (
          <Button variant="ghost" size="sm" onClick={clearAll} className="text-xs text-muted-foreground hover:text-destructive">
            <Trash2 className="w-3.5 h-3.5 mr-1" />清空
          </Button>
        )}
      </div>

      {rules.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <Eye className="w-12 h-12 mb-4 opacity-50" />
          <p className="text-sm">暂无显示规则</p>
          <p className="text-xs mt-1 opacity-70">在主页打开文章页面后，点击"显示同步按钮"添加规则</p>
        </div>
      ) : (
        <div className="flex-1 overflow-auto space-y-2">
          {rules.map(rule => (
            <div key={rule.id} className="p-2.5 rounded-lg border border-border bg-card">
              {editingId === rule.id ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={editTag}
                      onChange={e => setEditTag(e.target.value)}
                      className="w-12 text-[10px] text-center bg-muted px-1 py-1 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary flex-shrink-0"
                      placeholder="标签"
                    />
                    <input
                      type="text"
                      value={editPattern}
                      onChange={e => setEditPattern(e.target.value)}
                      className="flex-1 text-xs font-mono bg-muted px-2 py-1.5 rounded border border-border focus:outline-none focus:ring-1 focus:ring-primary"
                      placeholder="blog.csdn.net/*/article/details/*"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={saveEdit} className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20">
                      <Check className="w-3 h-3" />保存
                    </button>
                    <button onClick={cancelEdit} className="flex items-center gap-1 text-[10px] px-2 py-1 rounded bg-muted text-muted-foreground hover:bg-muted/80">
                      <X className="w-3 h-3" />取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {(rule.tag || getTag(rule.pattern.split('/')[0])) && (
                    <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded flex-shrink-0">
                      {rule.tag || getTag(rule.pattern.split('/')[0])}
                    </span>
                  )}
                  <code className="flex-1 text-[11px] font-mono bg-muted px-1.5 py-0.5 rounded truncate">
                    {rule.pattern}
                  </code>
                  <button onClick={() => startEdit(rule)} className="text-muted-foreground hover:text-primary transition-colors flex-shrink-0" title="编辑">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => deleteRule(rule.id)} className="text-muted-foreground hover:text-destructive transition-colors flex-shrink-0" title="删除">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {rules.length > 0 && (
        <div className="flex-shrink-0 mt-3 pt-3 border-t">
          <p className="text-[10px] text-muted-foreground text-center">* 匹配任意一个路径段，编辑或删除后刷新页面生效</p>
        </div>
      )}
    </div>
  )
}
