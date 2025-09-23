import axios from 'axios';
import path from 'path';
import fs from 'fs';
import puppeteer from 'puppeteer';
import ColorThief from 'colorthief';
import Handlebars from 'handlebars';
import { segment } from 'oicq';

const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')
);

export class EpicFreeGamesScheduled extends plugin {
  constructor() {
    super({
      name: 'Epic免费游戏定时推送',
      dsc: '每周四 11:45 获取 Epic 免费游戏列表并渲染成图片推送到群',
      event: 'message',
      priority: 9999,
      rule: [
        {
          reg: '^epic倒计时$',
          fnc: 'showCountdown'
        }
      ]
    });

    this.Plugin_Name = 'YunKit-plugin';
    this.Plugin_Path = path.resolve(process.cwd(), 'plugins', this.Plugin_Name);

    this.targetGroups = ['317849294']; // 配置群号
    this.isRunning = false;   // 任务互斥

    // 本地缓存 lastRun，保证插件重启后倒计时不丢失
    this.lastRunFile = path.resolve(this.Plugin_Path, 'lastRun.json');
    if (fs.existsSync(this.lastRunFile)) {
      const data = JSON.parse(fs.readFileSync(this.lastRunFile, 'utf-8'));
      this.lastRun = data.lastRun || 0;
    } else {
      this.lastRun = 0;
    }

    // 定时任务：每周四 11:45
    this.task = {
      cron: '45 11 * * 4',  // 每周四 11:45
      name: 'Epic免费游戏推送任务',
      fnc: () => this.sendScheduledMessage(),
      log: true
    };
  }

  // 查询倒计时命令
  async showCountdown(e) {
    const now = new Date();
    const nextThursday = new Date();
    // 计算下一个周四
    nextThursday.setDate(now.getDate() + ((4 + 7 - now.getDay()) % 7));
    nextThursday.setHours(11, 45, 0, 0);  // 改为 11:45
    if (nextThursday <= now) nextThursday.setDate(nextThursday.getDate() + 7);

    const remainingMs = nextThursday - now;
    const totalHours = Math.floor(remainingMs / 3600000);
    const minutes = Math.floor((remainingMs % 3600000) / 60000);
    const seconds = Math.floor((remainingMs % 60000) / 1000);

    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;

    let countdownMsg = `[Epic 免费游戏倒计时]\n剩余时间: `;
    if (days > 0) {
      countdownMsg += `${days}天 `;
    }
    countdownMsg += `${hours.toString().padStart(2, '0')}小时 ` +
                    `${minutes.toString().padStart(2, '0')}分钟 ` +
                    `${seconds.toString().padStart(2, '0')}秒`;

    await e.reply(countdownMsg);
  }

  // 核心任务：获取免费游戏并发送
  async sendScheduledMessage() {
    if (this.isRunning) {
      logger.mark('[定时任务] 上一次任务未完成，跳过本次执行');
      return;
    }
    this.isRunning = true;
    const startTime = Date.now();
    logger.mark('[定时任务] 开始执行 Epic 免费游戏推送');

    try {
      const url =
        'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
      
      let res;
      for (let i = 0; i < 3; i++) { // 请求重试3次
        try {
          res = await axios.get(url, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 30000
          });
          break;
        } catch (err) {
          logger.warn(`[定时任务] 第${i+1}次获取Epic免费游戏失败: ${err.message}`);
          if (i === 2) throw err;
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      const elements = res.data?.data?.Catalog?.searchStore?.elements || [];
      logger.mark(`[定时任务] 获取到 ${elements.length} 个游戏元素`);

      const currentGames = elements
        .filter(g => g.promotions?.promotionalOffers?.length > 0)
        .map(g => this.formatGame(g, 'current'));

      const upcomingGames = elements
        .filter(g => g.promotions?.upcomingPromotionalOffers?.length > 0)
        .map(g => this.formatGame(g, 'upcoming'));

      logger.mark(`[定时任务] 当前免费游戏 ${currentGames.length} 个，即将免费游戏 ${upcomingGames.length} 个`);

      // 构建文本消息
      let textMsg = [];
      if (currentGames.length) {
        textMsg.push('[当前免费游戏]');
        currentGames.forEach(g => textMsg.push(`- ${g.title}: ${g.link}`));
      }
      if (upcomingGames.length) {
        textMsg.push('[即将免费游戏]');
        upcomingGames.forEach(g => textMsg.push(`- ${g.title}: ${g.link}`));
      }

      const endTime = Date.now();
      const elapsed = ((endTime - startTime) / 1000).toFixed(1);
      textMsg.push(`\n[本次任务耗时: ${elapsed}秒]`);
      const textContent = textMsg.join('\n');

      // HTML 渲染
      const htmlPath = path.resolve(this.Plugin_Path, 'res', 'epic.html');
      let base64Img = '';
      if (fs.existsSync(htmlPath) && fs.readFileSync(htmlPath, 'utf-8').trim() !== '') {
        const allImages = [...currentGames, ...upcomingGames].flatMap(g => g.images);
        const avatar = allImages.length
          ? allImages[Math.floor(Math.random() * allImages.length)]
          : '';

        let mainColor = '#ffdd57';
        if (avatar) {
          try {
            const imgRes = await axios.get(avatar, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(imgRes.data, 'binary');
            const rgb = await ColorThief.getColor(buffer);
            mainColor = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
            logger.mark(`[定时任务] 提取主题色成功: ${mainColor}`);
          } catch (err) {
            logger.warn(`[定时任务] 提取主题色失败: ${err.message}`);
          }
        }

        try {
          const template = Handlebars.compile(fs.readFileSync(htmlPath, 'utf-8'));
          const htmlContent = template({
            avatar,
            title: 'Epic 免费游戏',
            ver: 'v1.0',
            yunzainame: rootPkg.name || 'Yunzai',
            yunzai: rootPkg.version || 'v3',
            mainColor,
            currentGames,
            upcomingGames
          });

          try {
            const buffer = await this.renderHtmlToImage(htmlContent, 3);
            base64Img = 'base64://' + buffer.toString('base64');
            logger.mark('[定时任务] HTML 渲染成功，准备发送图片');
          } catch (err) {
            logger.warn(`[定时任务] Puppeteer 渲染失败，将只发送文本消息: ${err.message}`);
          }
        } catch (err) {
          logger.warn(`[定时任务] Handlebars渲染失败，将只发送文本消息: ${err.message}`);
        }
      } else {
        logger.warn('[定时任务] HTML 模板不存在或为空，将只发送文本消息');
      }

      // 发送消息
      for (const group of this.targetGroups) {
        let sendTextSuccess = false;
        let sendImageSuccess = false;

        try {
          await Bot.pickGroup(group).sendMsg(textContent);
          sendTextSuccess = true;
          logger.mark(`[定时任务] 群 ${group} 文本消息发送成功`);
        } catch (err) {
          logger.error(`[定时任务] 群 ${group} 文本消息发送失败: ${err.message}`);
        }

        if (base64Img) {
          try {
            await Bot.pickGroup(group).sendMsg([segment.image(base64Img)]);
            sendImageSuccess = true;
            logger.mark(`[定时任务] 群 ${group} 图片消息发送成功`);
          } catch (err) {
            logger.error(`[定时任务] 群 ${group} 图片消息发送失败: ${err.message}`);
          }
        }

        logger.mark(`[定时任务] 群 ${group} 推送完成 | 文本: ${sendTextSuccess ? '成功' : '失败'} | 图片: ${base64Img ? (sendImageSuccess ? '成功' : '失败') : '无'}`);
      }

      // 更新 lastRun 并保存
      this.lastRun = Date.now();
      fs.writeFileSync(this.lastRunFile, JSON.stringify({ lastRun: this.lastRun }));

      logger.mark('[定时任务] Epic 免费游戏推送任务全部完成');
    } catch (err) {
      logger.error(`[定时任务] EpicFreeGames 获取失败: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  // 改造 formatGame，适配 PowerShell 命令逻辑
  formatGame(game, type = 'current') {
    let promo;
    if (type === 'current') promo = game.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
    else promo = game.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers?.[0];

    const images = (game.keyImages || []).map(img => img.url).filter(url => /^https?:\/\//.test(url));

    return {
      title: game.title || '未知游戏',
      description: game.description || '暂无描述',
      startDate: promo?.startDate || '',
      endDate: promo?.endDate || '',
      link: this.getEpicLink(game),
      images,
      cover: images[0] || '',
      additionalImages: images.slice(1)
    };
  }

  // 新方法：严格按照 PowerShell 命令逻辑生成链接
  getEpicLink(game) {
    let slug = '';

    if (game.offerMappings && game.offerMappings.length > 0 && game.offerMappings[0].pageSlug) {
      slug = game.offerMappings[0].pageSlug;
    }

    if (!slug && game.mappings && game.mappings.length > 0 && game.mappings[0].pageSlug) {
      slug = game.mappings[0].pageSlug;
    }

    if (!slug && game.productSlug) {
      slug = game.productSlug;
    }

    if (!slug) return ''; 

    return `https://www.epicgames.com/store/zh-CN/p/${slug}`;
  }

  async renderHtmlToImage(html, retryCount = 3) {
    let attempt = 0;
    while (attempt < retryCount) {
      attempt++;
      try {
        const browser = await puppeteer.launch({
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
          defaultViewport: { width: 1200, height: 800 }
        });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(resolve => setTimeout(resolve, 1500));
        const element = await page.$('body');
        const buffer = await element.screenshot({ type: 'png' });
        await browser.close();
        return buffer;
      } catch (err) {
        logger.warn(`[定时任务] Puppeteer 渲染尝试 ${attempt} 失败: ${err.message}`);
        if (attempt >= retryCount) throw err;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
}
