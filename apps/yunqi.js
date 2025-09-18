import axios from "axios";

export class YuanQiWhiteListPlugin extends plugin {
  constructor() {
    super({
      name: "YuanQi白名单群聊",
      dsc: "只允许白名单群使用的AI聊天插件（纯文字）",
      event: "message",
      priority: 1000,
      rule: [
        {
          reg: "^(#|/)ai( |$)(.*)?",
          fnc: "chat",
        },
      ],
    });

    // 白名单群号
    this.whitelistGroups = ["1057604000", "1234567890"];

    // YuanQi 配置
    this.assistant_id = "1968311988766836608";
    this.assistant_token = "nffPuLBSAaVLIFn3iskkQ1OUWzzTvsP4";
  }

  async chat(e) {
    const groupId = e.group_id?.toString();
    if (!groupId || !this.whitelistGroups.includes(groupId)) {
      await e.reply("本群不在白名单中，无法使用AI聊天功能。");
      return true;
    }

    // 提取用户消息
    const userMsg = e.msg.replace(/^(#|\/)ai\s*/i, "").trim();
    if (!userMsg) {
      await e.reply("请发送要提问的内容，例如：#ai 今天天气如何？");
      return true;
    }

    await e.reply("正在处理，请稍候...");

    try {
      const responseText = await this.callYuanQiAPI(userMsg, e.user_id.toString());
      if (!responseText) {
        await e.reply("AI未返回有效内容，请稍后再试。");
        return true;
      }

      await e.reply(responseText);
    } catch (err) {
      console.error("YuanQi API 调用失败：", err);
      await e.reply("请求AI服务失败，请稍后再试。");
    }

    return true;
  }

  async callYuanQiAPI(content, userId) {
    try {
      const body = {
        assistant_id: this.assistant_id,
        user_id: userId,
        stream: false,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: content }],
          },
        ],
      };

      const res = await axios.post(
        "https://yuanqi.tencent.com/openapi/v1/agent/chat/completions",
        body,
        {
          headers: {
            "X-Source": "openapi",
            "Content-Type": "application/json",
            Authorization: "Bearer " + this.assistant_token,
          },
          timeout: 15000,
        }
      );

      return res.data?.choices?.[0]?.message?.content || "";
    } catch (err) {
      console.error("YuanQi API错误:", err.message);
      throw err;
    }
  }
}
