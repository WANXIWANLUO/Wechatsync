import { useState, useEffect } from 'react'
import { X, Plus, Trash2, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SettingsDrawerProps {
  open: boolean
  onClose: () => void
}

interface CMSAccount {
  id: string
  name: string
  type: string
  url: string
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const [cmsAccounts, setCmsAccounts] = useState<CMSAccount[]>([])

  // 获取状态
  useEffect(() => {
    if (!open) return

    // CMS 账户
    chrome.storage.local.get('cmsAccounts', (result) => {
      setCmsAccounts(result.cmsAccounts || [])
    })
  }, [open])

  // 删除 CMS 账户
  const deleteCmsAccount = async (id: string) => {
    // 直接从 storage 读取最新数据，避免多窗口操作时覆盖
    const storage = await chrome.storage.local.get('cmsAccounts')
    const accounts: CMSAccount[] = storage.cmsAccounts || []
    const updated = accounts.filter(a => a.id !== id)
    await chrome.storage.local.set({ cmsAccounts: updated })
    await chrome.storage.local.remove(`cms_pwd_${id}`)
    setCmsAccounts(updated)
  }

  if (!open) return null

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 bg-black/50 z-40"
        onClick={onClose}
      />

      {/* 抽屉 */}
      <div className={cn(
        'fixed inset-y-0 right-0 w-80 bg-background z-50 shadow-xl relative',
        'transform transition-transform duration-200',
        open ? 'translate-x-0' : 'translate-x-full'
      )}>
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold">设置</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 space-y-6 overflow-y-auto h-[calc(100%-57px)]">
          {/* CMS 账户 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground">自建站点</h3>
              <button
                onClick={() => {
                  onClose()
                  window.location.hash = '/add-cms'
                }}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="w-3 h-3" />
                添加
              </button>
            </div>

            {cmsAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                暂无自建站点
              </p>
            ) : (
              <div className="space-y-2">
                {cmsAccounts.map(account => (
                  <div
                    key={account.id}
                    className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{account.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{account.url}</p>
                    </div>
                    <button
                      onClick={() => deleteCmsAccount(account.id)}
                      className="p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

        </div>

        {/* 右下角关于按钮 */}
        <button
          onClick={() => {
            onClose()
            window.location.hash = '/about'
          }}
          className="absolute bottom-3 right-4 p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          title="关于"
        >
          <Info className="w-4 h-4" />
        </button>
      </div>
    </>
  )
}
