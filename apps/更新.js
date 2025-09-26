import fs from 'fs';
import lodash from 'lodash';
import { execSync } from 'child_process';
import { update } from '../../other/update.js';
import puppeteer from 'puppeteer';
import path from 'path';
import { getAvatarInfo } from '../utils/avatar.js'; // 通用获取头像 Base64 + 主色
import { segment } from 'oicq';

export class CryoUpdatePlugin extends plugin {
  constructor() {
    super({
      name: 'YunKit插件管理',
      dsc: 'YunKit插件管理',
      event: 'message',
      priority: 666666,
      rule: [
        { reg: /^#?(yunkit|yk)(插件)?(强制)?更新?$/i, fnc: 'updatePlugin', permission: 'master' },
        { reg: /^#?(yunkit|yk)(插件)?信息$/i, fnc: 'showInfo' }
      ]
    });

    this.Plugin_Name = 'YunKit-plugin';
    this.Plugin_Path = path.resolve(process.cwd(), 'plugins', this.Plugin_Name);
    this.TEMPLATE_PATH = path.resolve(this.Plugin_Path, 'res', '更新.html');
    this.README_path = path.resolve(this.Plugin_Path, 'README.md');
    this.CHANGELOG_path = path.resolve(this.Plugin_Path, 'CHANGELOG.md');

    this.Version = this.getVersionInfo();
  }

  /** 更新插件（带自动重启） */
  async updatePlugin() {
    const updater = new update();
    updater.e = this.e;
    updater.reply = this.reply;

    if (!updater.getPlugin(this.Plugin_Name)) return;

    try {
      // 强制重置本地改动
      if (this.e.msg.includes('强制')) {
        execSync('git reset --hard', { cwd: this.Plugin_Path });
      }

      // 保证本地 main 分支跟远程同步
      execSync(`git branch --set-upstream-to=origin/main main`, {
        cwd: this.Plugin_Path,
        stdio: 'ignore'
      });

      // 执行更新
      await updater.runUpdate(this.Plugin_Name);

      // 如果有更新，延迟重启插件
      if (updater.isUp) {
        await this.e.reply(`${this.Plugin_Name} 更新完成，准备重启插件...`);
        setTimeout(() => updater.restart(), 2000); // 延迟 2 秒安全重启
      } else {
      }
    } catch (err) {
      logger.error(`[CryoUpdatePlugin] 更新失败`, err);
      await this.e.reply('插件更新失败，请查看日志');
    }
  }

  /** 显示版本 + CHANGELOG + Git提交信息（图片） */
  async showInfo() {
    try {
      const { avatarBase64, mainColor } = await getAvatarInfo(this.e);
      const title = this.Plugin_Name;
      const topLayout = Math.random() < 0.5 ? 'top-center' : 'top-left';

      const html = await this.renderHTML(avatarBase64, mainColor, title, topLayout);

      const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
      const page = await browser.newPage();
      await page.setViewport({ width: 600, height: 900 });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const buffer = await page.screenshot({ fullPage: true });
      await browser.close();

      const base64Img = 'base64://' + buffer.toString('base64');
      await this.e.reply(segment.image(base64Img));
    } catch (err) {
      logger.error('[CryoUpdatePlugin] 渲染失败', err);
      await this.e.reply('插件信息渲染失败');
    }
  }

  /** 渲染 HTML 模板 */
  async renderHTML(avatarBase64, mainColor ,title, topLayout) {
    let template = '';
    try {
      template = fs.readFileSync(this.TEMPLATE_PATH, 'utf8');
    } catch (err) {
      logger.error('[CryoUpdatePlugin] HTML 模板读取失败', err);
      template = `
        <html><body>
        <h1>{{title}}</h1>
        <h2>YunKit 插件信息</h2>
        <p>当前版本: {{ver}}</p>
        <p>Yunzai 版本: {{yunzai}}</p>
        <p>Yunzai 名称: {{yunzainame}}</p>
        <h3>CHANGELOG:</h3>{{changelog}}
        <h3>COMMITS:</h3>{{gitlogs}}
        </body></html>
      `;
    }

    const { ver, yunzai, yunzainame, logs } = this.Version;

    // CHANGELOG
    let changelogHTML = '';
    if (logs && logs.length > 0) {
      logs.slice(0, 5).forEach(log => {
        changelogHTML += `<div class="log"><div class="log-version">🔹 ${log.version}</div>`;
        log.logs?.forEach(l => {
          changelogHTML += `<div class="log-title">- ${l.title}</div>`;
          l.logs?.forEach(sub => {
            changelogHTML += `<div class="log-sub">· ${sub}</div>`;
          });
        });
        changelogHTML += `</div>`;
      });
    } else {
      changelogHTML = '<div class="log">暂时没有更新</div>';
    }

    // Git提交信息
    let gitLogs = [];
    try {
      const stdout = execSync('git log --pretty=format:"[%ad] %s" --date=short -n 10', { cwd: this.Plugin_Path });
      gitLogs = stdout.toString().split('\n');
    } catch (e) {
      logger.error('[CryoUpdatePlugin] 获取 git 提交失败', e);
    }
    let gitLogsHTML = '';
    if (gitLogs.length > 0) {
      gitLogs.forEach(l => gitLogsHTML += `<div class="git-log">· ${l}</div>`);
    } else {
      gitLogsHTML = '<div class="git-log">没有提交</div>';
    }

    // 替换模板占位符
    template = template.replace(/{{avatar}}/g, avatarBase64)
                       .replace(/{{mainColor}}/g, mainColor)
                       .replace(/{{ver}}/g, ver || '未知')
                       .replace(/{{yunzai}}/g, yunzai || '未知')
                       .replace(/{{yunzainame}}/g, yunzainame || '未知')
                       .replace(/{{changelog}}/g, changelogHTML)
                       .replace(/{{gitlogs}}/g, gitLogsHTML)
                       .replace(/{{title}}/g, title)
                       .replace(/{{topLayout}}/g, topLayout);

    return template;
  }

  /** 获取版本信息 */
  getVersionInfo() {
    let yunzai_name = '';
    let yunzai_ver = '';
    let changelogs = [];
    let currentVersion;
    let versionCount = 10;

    try {
      const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
      yunzai_ver = packageJson.version;
      yunzai_name = packageJson.name;
    } catch {}

    const getLine = line => line.replace(/(^\s*[\*\-]|\r)/g, '').trim();

    try {
      if (fs.existsSync(this.CHANGELOG_path)) {
        const lines = fs.readFileSync(this.CHANGELOG_path, 'utf8').split('\n');
        let temp = {};
        let lastLine = {};
        lodash.forEach(lines, line => {
          if (versionCount < 1) return false;
          const versionRet = /^#\s*([0-9a-zA-Z\\.~\s]+)$/.exec(line.trim());
          if (versionRet && versionRet[1]) {
            const v = versionRet[1].trim();
            if (!currentVersion) currentVersion = v;
            else {
              changelogs.push(temp);
              versionCount--;
            }
            temp = { version: v, logs: [] };
          } else {
            if (!line.trim()) return;
            if (/^[*-]/.test(line.trim())) {
              lastLine = { title: getLine(line), logs: [] };
              if (!temp.logs) temp.logs = [];
              temp.logs.push(lastLine);
            } else if (/^\s{2,}[-*]/.test(line)) {
              lastLine.logs.push(getLine(line));
            }
          }
        });
        if (temp.version) changelogs.push(temp);
      }
    } catch (e) {
      logger.error('[CryoUpdatePlugin] CHANGELOG 读取失败', e);
    }

    try {
      if (fs.existsSync(this.README_path)) {
        const README = fs.readFileSync(this.README_path, 'utf8') || '';
        const reg = /版本：(.*)/.exec(README);
        if (reg) currentVersion = reg[1];
      }
    } catch {}

    return {
      get ver() { return currentVersion; },
      get yunzainame() { return yunzai_name; },  
      get yunzai() { return yunzai_ver; },
      get logs() { return changelogs; }
    };
  }
}
