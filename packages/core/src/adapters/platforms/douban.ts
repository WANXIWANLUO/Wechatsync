/**
 * 豆瓣适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { DoubanImageData } from '../../lib'
import type { PublishOptions } from '../types'
import { markdownToDraft } from '../../lib'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Douban')

interface DoubanFormData {
  note_id: string
  ck: string
}

interface DoubanPostParams {
  siteCookie: {
    value: string
  }
}

export class DoubanAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douban',
    name: '豆瓣',
    icon: 'https://www.douban.com/favicon.ico',
    homepage: 'https://www.douban.com/topic/create?subtype=note',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  /** 预处理配置: 豆瓣使用 Markdown 格式 (转换为 Draft.js) */
  readonly preprocessConfig = {
    outputFormat: 'markdown' as const,
  }

  private username: string = ''
  private avatar: string = ''
  private formData: DoubanFormData | null = null
  private postParams: DoubanPostParams | null = null

  /** 豆瓣 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.douban.com/*',
      headers: {
        'Origin': 'https://www.douban.com',
        'Referer': 'https://www.douban.com',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await this.runtime.fetch(
        'https://accounts.douban.com/passport/setting',
        { method: 'GET', credentials: 'include', redirect: 'follow' }
      )

      if (!response.ok) {
        return { isAuthenticated: false }
      }

      const html = await response.text()

      const configMatch = html.match(/window\._CONFIG\s*=\s*(\{[\s\S]*?\});/)
      if (!configMatch) {
        return { isAuthenticated: false }
      }

      try {
        const config = JSON.parse(configMatch[1])
        const nick = config.nick
        const uid = config.uid || config.user_id

        if (nick && uid) {
          this.username = nick
          this.avatar = config.pic || config.large_pic || ''
          this.formData = { note_id: String(uid), ck: config.ck || '' }

          return {
            isAuthenticated: true,
            userId: String(uid),
            username: this.username,
            avatar: this.avatar,
          }
        }
      } catch (e) {
        logger.warn('Failed to parse _CONFIG:', e)
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: failed -', error)
      return { isAuthenticated: false }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.formData) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) throw new Error('请先登录豆瓣')
      }

      let content = article.markdown || ''

      // 新版：通过 URL 上传图片（无需下载 blob）
      const imageDataMap = new Map<string, DoubanImageData>()
      const uploadedIds: string[] = []

      content = await this.processImages(
        content,
        async (src) => {
          const result = await this.uploadImageByUrl(src)
          uploadedIds.push(result.imageData.id)
          imageDataMap.set(result.url, result.imageData)
          return result
        },
        {
          skipPatterns: ['doubanio.com', 'douban.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 豆瓣不支持内联样式和 HTML 标签。清理采集时保留的彩色/居中/加粗等 HTML：
      // - <span style="color:...">文字</span> → 文字
      // - <p style="text-align:center">文字</p> → 文字（还原为纯文本段落）
      content = content.replace(/<span style="[^"]*">(.*?)<\/span>/gi, '$1')
      content = content.replace(/<p style="[^"]*">(.*?)<\/p>/gi, '$1\n\n')

      // Markdown → Draft.js
      const draftContent = markdownToDraft(content, imageDataMap)
      const draftBlocks = typeof draftContent === 'string' ? JSON.parse(draftContent) : draftContent

      // 构建 draft_props
      const draftProps = JSON.stringify({
        title: article.title,
        content: draftBlocks,
        image_ids: uploadedIds,
        image_layout: 'vertical',
        subtype: 'note',
      })

      // 新版：通过 mobile API 创建草稿，body 只接受 draft_props
      const createBody = JSON.stringify({ draft_props: draftProps })

      const createRes = await this.runtime.fetch(
        'https://m.douban.com/rexxar/api/v2/dwarf/drafts',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Referer': 'https://www.douban.com/',
          },
          body: createBody,
        }
      )

      const createData = await createRes.json() as { id: number; title?: string }
      logger.debug('Draft created:', createData)

      if (!createData.id) {
        throw new Error(`创建草稿失败: ${JSON.stringify(createData)}`)
      }

      const draftUrl = `https://www.douban.com/note/create?id=${createData.id}`

      return this.createResult(true, {
        postId: String(createData.id),
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  /**
   * 上传图片到豆瓣图床：下载原图 → multipart 上传到 add_photo API → 返回豆瓣托管 URL
   */
  private async uploadImageByUrl(src: string): Promise<ImageUploadResult & { imageData: DoubanImageData }> {
    // 1. 下载原始图片（二进制）
    const imgRes = await this.runtime.fetch(src)
    if (!imgRes.ok) throw new Error(`下载图片失败: ${imgRes.status}`)
    const blob = await imgRes.blob()

    // 2. multipart 上传到豆瓣
    const formData = new FormData()
    formData.append('ck', this.formData!.ck)
    formData.append('image_file', blob)

    const uploadRes = await this.runtime.fetch(
      'https://www.douban.com/j/group/topic/add_photo',
      {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Referer': 'https://www.douban.com/',
        },
        body: formData,
      }
    )

    const data = await uploadRes.json() as {
      r: number
      photo?: {
        id: string
        url: string
        thumb: string
        width: number
        height: number
        file_name: string
        file_size: number
      }
    }

    if (data.r !== 0 || !data.photo?.url) {
      throw new Error(`图片上传失败${data.r ? ` (r=${data.r})` : ''}`)
    }

    return {
      url: data.photo.url,
      imageData: {
        id: data.photo.id,
        url: data.photo.url,
        thumb: data.photo.thumb,
        width: data.photo.width,
        height: data.photo.height,
        file_name: data.photo.file_name,
        file_size: data.photo.file_size,
      },
    }
  }

}
