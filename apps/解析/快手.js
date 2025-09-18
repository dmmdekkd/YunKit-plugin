import axios from "axios";

export class KuaishouParse extends plugin {
  constructor() {
    super({
      name: "KuaishouParse",
      dsc: "自动解析快手短链，发送视频或图片",
      event: "message",
      priority: 1000,
      rule: [
        { reg: "https?:\\/\\/(v\\.kuaishou\\.com|v\\.m\\.chenzhongtech\\.com)\\/[^\\s]+", fnc: "parse" }
      ]
    });
  }

  toHttps(url) {
    if (!url) return "";
    if (url.startsWith("//")) return "https:" + url;
    if (url.startsWith("http://")) return url.replace("http://", "https://");
    if (!url.startsWith("http")) return "https://" + url;
    return url;
  }

  async parseMain(url) {
    const api = "https://zhishuzhan.com/v2/parse/index";
    try {
      const res = await axios.post(api, { PageUrl: url }, {
        headers: {
          "Content-Type": "application/json;charset=UTF-8",
          "Origin": "https://zhishuzhan.com",
          "Referer": "https://zhishuzhan.com/",
          "User-Agent": "Mozilla/5.0",
          "X-Requested-With": "XMLHttpRequest",
          "Cookie": "tokens=b59309e4fca806fc0c1a4d3003614374; user_id=880897"
        },
        timeout: 10000
      });
      return res.data;
    } catch (err) {
      return null;
    }
  }

  async parseBackup(url) {
    const api = "https://api.bugpk.com/api/short_videos?url=" + encodeURIComponent(url);
    try {
      const res = await axios.get(api, { timeout: 10000 });
      return res.data;
    } catch (err) {
      return null;
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async parse(e) {
    // 匹配消息中所有快手短链
    const urlMatches = e.msg.match(/https?:\/\/(v\.kuaishou\.com|v\.m\.chenzhongtech\.com)\/[^\s]+/g);
    if (!urlMatches) return;

    for (const url of urlMatches) {
      let data = await this.parseMain(url);
      if (!data || (data.Code && data.Code !== 200)) {
        data = await this.parseBackup(url);
      }

      if (!data || (data.Code && data.Code !== 200)) {
        await e.reply(`解析失败：${url}`);
        continue;
      }

      const title = data.Data?.title || "快手视频";
      const author = data.Data?.author || "";
      const videoUrl = this.toHttps(data.Data?.encodeUrl || data.Data?.videoUrls?.[0] || "");
      const coverUrl = this.toHttps(data.Data?.coverUrls || "");
      const images = (data.Data?.pics || []).map(i => this.toHttps(i));

      const MAX_VIDEO_SIZE = 10 * 1024 * 1024; // 10MB

      // ---------------- 发送封面 + 文本 ----------------
      let text = title;
      if (author) text += `\n作者：${author}`;

      try {
        if (coverUrl.startsWith("http")) {
          await e.reply([segment.image(coverUrl), text]);
        } else {
          await e.reply(text);
        }
      } catch {
        await e.reply(text);
      }

      // ---------------- 发送视频 ----------------
      if (videoUrl.startsWith("http")) {
        try {
          const headRes = await axios.head(videoUrl);
          const size = parseInt(headRes.headers['content-length'] || '0');
          if (size > MAX_VIDEO_SIZE) {
            await e.reply(`视频较大，发送链接播放：\n${videoUrl}`);
          } else {
            await e.reply(segment.video(videoUrl));
          }
        } catch {
          await e.reply(`视频发送失败，请点击链接播放：\n${videoUrl}`);
        }
      }

      // ---------------- 发送其他图片 ----------------
      if (images.length > 0) {
        for (let i = 0; i < Math.min(images.length, 5); i++) {
          try {
            await e.reply(segment.image(images[i]));
            await this.sleep(500); // 避免发送过快
          } catch {
            await e.reply(`图片发送失败，请点击链接查看: ${images[i]}`);
          }
        }
      }
    }
  }
}
