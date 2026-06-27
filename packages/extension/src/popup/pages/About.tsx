import { useNavigate } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

export function AboutPage() {
  const navigate = useNavigate()
  const version = chrome.runtime.getManifest().version

  return (
    <div className="flex flex-col h-[500px]">
      {/* Header */}
      <header className="flex-shrink-0 flex items-center gap-2 px-4 py-3 border-b">
        <button
          onClick={() => navigate(-1)}
          className="p-1.5 rounded-lg hover:bg-muted transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h1 className="font-semibold">关于</h1>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-8">
        {/* Logo & Title */}
        <img src="/assets/icon-128.png" alt="Logo" className="w-16 h-16 mb-3" />
        <h2 className="text-lg font-semibold">文章同步助手</h2>
        <p className="text-sm text-muted-foreground mt-1">v{version}</p>

        {/* Description */}
        <p className="text-sm text-muted-foreground text-center mt-4 leading-relaxed">
          一键将文章同步到多个平台
        </p>

        {/* Legal notice (GPL-3.0) */}
        <div className="mt-6 w-full max-w-[280px] rounded-lg border p-3 text-xs text-muted-foreground leading-relaxed space-y-1">
          <p className="font-medium text-foreground">版权声明</p>
          <p>本项目是基于开源项目 Wechatsync（GPL-3.0）的衍生作品 。原作者fun </p>
          <p>本程序不提供任何担保。详情请参阅 LICENSE 文件。</p>
        </div>
      </div>
    </div>
  )
}
