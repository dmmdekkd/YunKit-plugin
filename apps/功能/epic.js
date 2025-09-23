import axios from 'axios'
import path from 'path'
import fs from 'fs'
import puppeteer from 'puppeteer'
import ColorThief from 'colorthief'
import Handlebars from 'handlebars'
import { segment } from 'oicq'

// 读取根目录 package.json
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')
)

export class EpicFreeGames extends plugin {
  constructor() {
    super({
      name: 'Epic免费游戏HTML渲染',
      dsc: '获取 Epic 免费游戏列表并渲染成图片',
      event: 'message',
      priority: 500,
      rule: [{ reg: '^#?epic免费游戏$', fnc: 'getFreeGames' }]
    })

    this.Plugin_Name = 'YunKit-plugin'
    this.Plugin_Path = path.resolve(process.cwd(), 'plugins', this.Plugin_Name)
  }

  async getFreeGames(e) {
    this.e = e
    try {
      const url =
        'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN'

      // 加 UA，防止 Epic 拦截
      const res = await axios.get(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        }
      })

      const elements = res.data?.data?.Catalog?.searchStore?.elements || []

      // 当前免费
      const currentGames = elements
        .filter(g => g.promotions?.promotionalOffers?.length > 0)
        .map(g => this.formatGame(g, 'current'))

      // 即将免费
      const upcomingGames = elements
        .filter(g => g.promotions?.upcomingPromotionalOffers?.length > 0)
        .map(g => this.formatGame(g, 'upcoming'))

      // 随机背景图
      const allImages = [...currentGames, ...upcomingGames].flatMap(g => g.images)
      const avatar = allImages.length
        ? allImages[Math.floor(Math.random() * allImages.length)]
        : ''

      // 提取主题色（远程下载）
      let mainColor = '#ffdd57'
      if (avatar) {
        try {
          const imgRes = await axios.get(avatar, { responseType: 'arraybuffer' })
          const buffer = Buffer.from(imgRes.data, 'binary')
          const rgb = await ColorThief.getColor(buffer) // ✅ 传 Buffer
          mainColor = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
        } catch (err) {
          console.error('提取主题色失败:', err.message)
        }
      }

      // 先发链接文本
      let linkMsg = []
      if (currentGames.length) {
        linkMsg.push('当前免费:')
        currentGames.forEach(g => {
          linkMsg.push(`- ${g.title}: ${g.link}`)
        })
      }
      if (upcomingGames.length) {
        linkMsg.push('\n即将免费:')
        upcomingGames.forEach(g => {
          linkMsg.push(`- ${g.title}: ${g.link}`)
        })
      }

      if (linkMsg.length) {
        await this.e.reply(linkMsg.join('\n'))
      }

      // 再发图片
      const htmlPath = path.resolve(this.Plugin_Path, 'res', 'epic.html')
      if (!fs.existsSync(htmlPath))
        return await e.reply('HTML 模板不存在: ' + htmlPath)

      const template = fs.readFileSync(htmlPath, 'utf-8')
      const compiled = Handlebars.compile(template)

      const htmlContent = compiled({
        avatar,
        title: 'Epic 免费游戏',
        ver: 'v1.0',
        yunzainame: rootPkg.name || 'Yunzai',
        yunzai: rootPkg.version || 'v3',
        mainColor,
        currentGames,
        upcomingGames
      })

      const buffer = await this.renderHtmlToImage(htmlContent)
      const base64Img = 'base64://' + buffer.toString('base64')
      await this.e.reply(segment.image(base64Img))
    } catch (err) {
      console.error('EpicFreeGames 获取失败:', err)
      await e.reply('获取 Epic 免费游戏失败，请稍后再试')
    }
  }

  formatGame(game, type = 'current') {
    let promo
    if (type === 'current')
      promo = game.promotions.promotionalOffers[0]?.promotionalOffers[0]
    else promo = game.promotions.upcomingPromotionalOffers[0]?.promotionalOffers[0]

    const images = (game.keyImages || [])
      .map(img => img.url)
      .filter(url => /^https?:\/\//.test(url))

    return {
      title: game.title,
      description: game.description || '暂无描述',
      startDate: promo?.startDate || '',
      endDate: promo?.endDate || '',
      link: this.getGameLink(game),
      images,
      cover: images[0] || '',
      additionalImages: images.slice(1),
      categories: (game.categories || []).map(c => c.path).join(', '),
      tags: (game.tags || []).map(t => t.id).join(', '),
      price: game.price?.totalPrice?.discountPrice ?? 0,
      originalPrice: game.price?.totalPrice?.originalPrice ?? 0
    }
  }

  getGameLink(game) {
    let slug = game.productSlug || game.urlSlug
    if (slug?.includes('/')) {
      return `https://store.epicgames.com/zh-CN/${slug}`
    } else {
      return `https://store.epicgames.com/zh-CN/p/${slug}`
    }
  }

  async renderHtmlToImage(html) {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1200, height: 800 }
    })
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle2' })
    await new Promise(resolve => setTimeout(resolve, 500))
    const element = await page.$('body')
    const buffer = await element.screenshot({ type: 'png' })
    await browser.close()
    return buffer
  }
}
