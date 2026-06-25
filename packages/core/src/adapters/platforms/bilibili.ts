/**
 * B站适配器
 */
import { CodeAdapter, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../types'
import type { PublishOptions } from '../types'
import { createLogger } from '../../lib/logger'

const logger = createLogger('Bilibili')

interface BilibiliUserInfo {
  mid: number
  uname: string
  face: string
  isLogin: boolean
}

export class BilibiliAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'bilibili',
    name: '哔哩哔哩',
    icon: 'https://www.bilibili.com/favicon.ico',
    homepage: 'https://member.bilibili.com/platform/upload/text',
    capabilities: ['article', 'draft', 'image_upload', 'cover'],
  }

  /** 预处理配置: B站使用 HTML，移除外链 */
  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
  }

  private userInfo: BilibiliUserInfo | null = null
  private csrf: string = ''

  /** B站 API 需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://api.bilibili.com/*',
      headers: {
        'Origin': 'https://member.bilibili.com',
        'Referer': 'https://member.bilibili.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const res = await this.get<{
        code: number
        data?: BilibiliUserInfo
      }>('https://api.bilibili.com/x/web-interface/nav?build=0&mobi_app=web')

      logger.debug('checkAuth response:', res)

      if (res.code === 0 && res.data?.isLogin) {
        this.userInfo = res.data
        await this.fetchCsrf()

        return {
          isAuthenticated: true,
          userId: String(res.data.mid),
          username: res.data.uname,
          avatar: res.data.face,
        }
      }

      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  private async fetchCsrf(): Promise<void> {
    try {
      if (this.runtime.getCookie) {
        const value = await this.runtime.getCookie('.bilibili.com', 'bili_jct')
        this.csrf = value || ''
      }
      logger.debug('CSRF token:', this.csrf ? 'obtained' : 'not found')
    } catch (e) {
      logger.error('Failed to get CSRF:', e)
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')

      if (!this.userInfo) {
        const auth = await this.checkAuth()
        if (!auth.isAuthenticated) {
          throw new Error('请先登录B站')
        }
      }

      if (!this.csrf) {
        throw new Error('获取 CSRF token 失败，请刷新页面后重试')
      }

      // Use pre-processed HTML content directly
      let content = article.html || ''

      content = await this.processImages(
        content,
        (src) => this.uploadImageByUrl(src),
        {
          skipPatterns: ['hdslb.com', 'bilibili.com', 'biliimg.com'],
          onProgress: options?.onImageProgress,
        }
      )

      // 上传封面图
      let imageUrls = ''
      if (article.cover) {
        try {
          const coverResult = await this.uploadImageByUrl(article.cover)
          imageUrls = coverResult.url
          logger.debug('Cover uploaded:', coverResult.url)
        } catch (e) {
          logger.warn('Failed to upload cover:', e)
        }
      }

      const draftBody: Record<string, string> = {
        tid: '4',
        title: article.title,
        content: content,
        csrf: this.csrf,
        save: '0',
        pgc_id: '0',
      }
      if (imageUrls) {
        draftBody.image_urls = imageUrls
      }

      const res = await this.postForm<{
        code: number
        message?: string
        data?: { aid: number }
      }>(
        'https://api.bilibili.com/x/article/creative/draft/addupdate',
        draftBody
      )

      logger.debug('Draft response:', res)

      if (res.code !== 0 || !res.data?.aid) {
        throw new Error(res.message || '保存草稿失败')
      }

      const draftUrl = `https://member.bilibili.com/platform/upload/text/edit?aid=${res.data.aid}`

      return this.createResult(true, {
        postId: String(res.data.aid),
        postUrl: draftUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, {
      error: (error as Error).message,
    }))
  }

  // WBI 签名密钥（从 B站 nav API 获取）
  private mixinKey: string | null = null

  private async getMixinKey(): Promise<string> {
    if (this.mixinKey) return this.mixinKey
    const res = await this.get<{ data?: { wbi_img?: { img_url: string; sub_url: string } } }>(
      'https://api.bilibili.com/x/web-interface/nav'
    )
    const imgUrl = res.data?.wbi_img?.img_url || ''
    const subUrl = res.data?.wbi_img?.sub_url || ''
    const imgKey = imgUrl.substring(imgUrl.lastIndexOf('/') + 1).split('.')[0]
    const subKey = subUrl.substring(subUrl.lastIndexOf('/') + 1).split('.')[0]
    const rawKey = imgKey + subKey
    const mixinKeyChars: number[] = [46,47,6,2,53,24,9,18,56,15,33,22,23,13,3,29,41,35,8,50,7,30,37,11,51,14]
    this.mixinKey = mixinKeyChars.map(i => rawKey[i]).join('')
    return this.mixinKey
  }

  /** WBI 签名 */
  private async wbiSign(params: Record<string, string>): Promise<{ w_rid: string; wts: string }> {
    const mixinKey = await this.getMixinKey()
    const wts = String(Math.floor(Date.now() / 1000))
    const sorted = Object.entries({ ...params, wts })
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&')
    const encoder = new TextEncoder()
    const data = encoder.encode(sorted + mixinKey)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const w_rid = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
    return { w_rid, wts }
  }

  protected async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.csrf) {
      throw new Error('CSRF token 未获取')
    }

    // 使用 runtime.fetch() 自动处理 Referer 防盗链
    const imageResponse = await this.runtime.fetch(src)
    if (!imageResponse.ok) {
      throw new Error('图片下载失败: ' + src)
    }
    const imageBlob = await imageResponse.blob()

    const formData = new FormData()
    formData.append('file_up', imageBlob, 'image.jpg')
    formData.append('biz', 'new_dyn')
    formData.append('category', 'daily')
    formData.append('csrf', this.csrf)

    const { w_rid, wts } = await this.wbiSign({
      biz: 'new_dyn',
      category: 'daily',
      csrf: this.csrf,
    })

    const uploadUrl = `https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs?w_rid=${w_rid}&wts=${wts}`
    const uploadResponse = await this.runtime.fetch(uploadUrl, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Origin': 'https://member.bilibili.com',
      },
      body: formData,
    })

    const res = await uploadResponse.json() as {
      code: number
      message?: string
      data?: {
        image_url: string
        image_width?: number
        image_height?: number
      }
    }

    logger.debug('B站图片上传:', res)

    if (res.code !== 0 || !res.data?.image_url) {
      throw new Error(res.message || '图片上传失败')
    }

    // 确保使用 HTTPS
    const imageUrl = res.data.image_url.replace(/^http:/, 'https:')

    return {
      url: imageUrl,
      attrs: {
        width: res.data.image_width ? String(res.data.image_width) : '',
        height: res.data.image_height ? String(res.data.image_height) : '',
      },
    }
  }
}
