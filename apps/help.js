import puppeteer from 'puppeteer'
import path from 'path'
import fs from 'fs'
import axios from 'axios'
import ColorThief from 'colorthief'

export class helpyunzai extends plugin {
  constructor() {
    super({
      name: 'helpyunzai',
      dsc: 'Yunzai插件帮助菜单（图片版）',
      event: 'message',
      priority: -99,
      rule: [
        {
          reg: /^(\/|#)?(帮助|命令|菜单|help|功能|指令)$/i,
          fnc: 'showHelp'
        }
      ]
    })
  }

  async downloadAvatar(url) {
    try {
      const res = await axios.get(url, { responseType: 'arraybuffer' })
      const ext = url.endsWith('.png') ? 'png' : 'jpg'
      const filePath = path.resolve('./plugins/YunKit-plugin/data/avatar.' + ext)
      fs.writeFileSync(filePath, res.data)
      return filePath
    } catch {
      return ''
    }
  }

  rgbToHex(rgb) {
    return '#' + rgb.map(x => x.toString(16).padStart(2, '0')).join('')
  }

  /** 获取版本信息 */
  getVersionInfo() {
    let yunzai_name = ''
    let yunzai_ver = ''
    let ver = ''

    try {
      // 读取 package.json
      const pkgPath = path.resolve('./package.json')
      if (fs.existsSync(pkgPath)) {
        const packageJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
        yunzai_name = packageJson.name || yunzai_name
        yunzai_ver = packageJson.version || yunzai_ver
      }

      // 读取 CHANGELOG.md 只取最新一行版本号
      const logPath = path.resolve('./plugins/YunKit-plugin/CHANGELOG.md')
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, 'utf-8')
        const match = logContent.match(/^#+\s*\[?v?([\d.]+)\]?/m)
        if (match) ver = match[1]
      }
    } catch (err) {
      logger.warn('[helpyunzai] 读取版本信息失败', err)
    }

    return { yunzai_name, yunzai_ver, ver }
  }

  async showHelp(e) {
    try {
      const htmlPath = path.resolve('./plugins/YunKit-plugin/res/help.html')
      const jsonPath = path.resolve('./plugins/YunKit-plugin/data/commands.json')

      if (!fs.existsSync(htmlPath) || !fs.existsSync(jsonPath)) {
        await e.reply('帮助HTML模板或JSON文件不存在')
        return
      }

      let htmlContent = fs.readFileSync(htmlPath, 'utf-8')
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))

      const isQQbot = e.bot?.version?.name === 'QQBot'
      const openid = e.raw?.author?.user_openid || e.raw?.sender?.user_openid || e.user_id
      const avatarUrl = isQQbot
        ? `https://thirdqq.qlogo.cn/qqapp/102808311/${openid}/640`
        : `http://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640`

      const avatarPath = await this.downloadAvatar(avatarUrl)

      let mainColor = '#ffdd57'
      let avatarBase64 = ''
      if (avatarPath) {
        avatarBase64 = `data:image/png;base64,${fs.readFileSync(avatarPath).toString('base64')}`
        try {
          const rgb = await ColorThief.getColor(avatarPath)
          mainColor = this.rgbToHex(rgb)
        } catch {}
      }

      const titleText = e.isMaster
        ? (data.titles?.master || 'BotDashboard')
        : (data.titles?.normal || 'BotHelp')

      const filteredSections = (data.sections || []).filter(sec => !sec.isAdmin || e.isMaster)

      // === 获取版本信息 ===
      const { yunzai_name, yunzai_ver, ver } = this.getVersionInfo()

      const commandsData = {
        ...data,
        title: titleText,
        avatar: avatarBase64,
        isMaster: e.isMaster,
        sections: filteredSections,
        mainColor,
        yunzai_name,
        yunzai_ver,
        ver
      }

      htmlContent = htmlContent.replace(
        '</body>',
        `<script>window.commandsData = ${JSON.stringify(commandsData)};</script>
         <script>
           document.addEventListener('DOMContentLoaded', () => {
             if(typeof renderCommands==='function'){ renderCommands() }
           })
         </script>
        </body>`
      )

      const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] })
      const page = await browser.newPage()
      await page.setViewport({ width: 600, height: 900 })
      await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 0 })

      await page.waitForFunction(() => {
        const grids = document.querySelectorAll('.command-grid')
        return grids.length > 0 && Array.from(grids).every(g => g.children.length > 0)
      }, { timeout: 10000 })

      const element = await page.$('body')
      const buffer = await element.screenshot({ type: 'png' })
      await browser.close()

      const base64Img = 'base64://' + buffer.toString('base64')
      await e.reply(segment.image(base64Img))
    } catch (err) {
      logger.error('生成帮助图片失败：', err)
      await e.reply('生成帮助图片失败')
    }
  }
}
