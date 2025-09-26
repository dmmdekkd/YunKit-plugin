import axios from "axios";

export class HandMadePlugin extends plugin {
  constructor() {
    super({
      name: "手办化",
      dsc: "手办化",
      event: "message",
      priority: 1000,
      rule: [
        { reg: "^(#|/)?手办化$", fnc: "handMade" }
      ]
    });

    this.apiKey = "610e4161c9f12c238bc0456069ad5d40";
    this.apiUrl = "https://jl.xiaoapi.cn/i/web/hand_made.php";
    this.tokenApiUrl = `https://jl.xiaoapi.cn/i/token/api.php?key=${this.apiKey}&type=get_info`;
  }

  async handMade(e) {
    let imgUrl = "";

    // ---------------- 引用消息图片优先 ----------------
    if (e.source?.reply?.message) {
      const quoteImg = e.source.reply.message.find(msg => msg.type === "image");
      if (quoteImg) imgUrl = quoteImg.url;
    }

    // ---------------- 消息自身图片 ----------------
    if (!imgUrl && e.message) {
      const msgImg = e.message.find(msg => msg.type === "image");
      if (msgImg) imgUrl = msgImg.url;
    }

    // ---------------- 头像 ----------------
    if (!imgUrl) {
      const isQQbot = e.bot?.version?.name === "QQBot";
      const openid = e.raw?.author?.user_openid || e.raw?.sender?.user_openid || e.user_id;
      imgUrl = isQQbot
        ? `https://thirdqq.qlogo.cn/qqapp/102808311/${openid}/640`
        : `https://q.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640`;
    }

    if (!imgUrl) {
      await e.reply("未找到可处理的图片。");
      return;
    }

    // ---------------- 检测 GIF ----------------
    if (imgUrl.toLowerCase().endsWith(".gif")) {
      const tokenInfo = await this.getTokenInfo();
      await e.reply(`GIF图片暂不支持手办化。\n剩余积分：${tokenInfo.Integral}\n已用积分：${tokenInfo.cost}`);
      return;
    }

    try {
      const startTime = Date.now();
      await e.reply("正在生成手办化头像，请稍候...", true);

      // 使用 encodeURIComponent 保证 URL 安全
      const apiUrl = `${this.apiUrl}?key=${this.apiKey}&url=${encodeURIComponent(imgUrl)}&_r=${Date.now()}`;
      const res = await axios.get(apiUrl, { timeout: 200000 });
      const data = res.data;

      if (data.code === 200 && data.image) {
        const imgRes = await axios.get(data.image, { responseType: "arraybuffer" });
        const endTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const tokenInfo = await this.getTokenInfo();

        await e.reply([
          segment.image(Buffer.from(imgRes.data)),
          `生成耗时：${endTime}s\n剩余积分：${tokenInfo.Integral}\n已用积分：${tokenInfo.cost}`
        ]);
      } else {
        await e.reply(`手办化生成失败：${data.msg || JSON.stringify(data)}`, true);
      }
    } catch (err) {
      console.error("手办化请求失败:", err);
      await e.reply("手办化请求失败，请稍后再试。", true);
    }
  }

  async getTokenInfo() {
    try {
      const res = await axios.get(this.tokenApiUrl, { timeout: 10000 });
      if (res.data && res.data.code === 200) {
        return { Integral: res.data.Integral, cost: res.data.cost };
      }
      return { Integral: 0, cost: 0 };
    } catch (err) {
      console.error("查询积分失败:", err);
      return { Integral: 0, cost: 0 };
    }
  }
}


