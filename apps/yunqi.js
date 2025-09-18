import axios from "axios";
import fs from "fs";
import path from "path";

export class YuanQiWhiteListPlugin extends plugin {
  constructor() {
    super({
      name: "YuanQi",
      dsc: "AI 白名单群内用户聊天，支持概率回复",
      event: "message",
      priority: 999999999,
      rule: [
        {
          reg: ".*",
          fnc: "chat",
          log: true,
        },
      ],
    });

    // JSON 配置路径
    this.configPath = path.resolve(
      process.cwd(),
      "./plugins/YunKit-plugin/data/yuankqi.json"
    );

    // 默认配置
    this.config = {
      whitelistGroupUsers: {},
      assistant_id: "",
      assistant_token: "",
      replyProbability: 0.75, // 默认 75% 概率回复
    };

    // 尝试读取配置文件
    this.loadConfig();
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const json = JSON.parse(raw);

        this.config.whitelistGroupUsers = json.whitelistGroupUsers || {};
        this.config.assistant_id = json.assistant_id || "";
        this.config.assistant_token = json.assistant_token || "";
        this.config.replyProbability =
          typeof json.replyProbability === "number"
            ? json.replyProbability
            : this.config.replyProbability;
      } else {
        console.warn("[YuanQi插件] 配置文件不存在，将使用默认空配置。");
      }
    } catch (err) {
      console.error("[YuanQi插件] 读取配置文件失败:", err);
    }
  }

  async chat(e) {
    const userId = e.user_id?.toString();
    const groupId = e.group_id?.toString();

    const allowedUsers = this.config.whitelistGroupUsers[groupId];
    if (!allowedUsers) return false; // 非指定群不处理

    if (!allowedUsers.includes(userId)) {
      return true; // 群内非白名单用户不处理
    }

    // 根据配置概率决定是否回复
    if (Math.random() > this.config.replyProbability) return true;

    try {
      const userMsg = e.raw_message?.trim();
      if (!userMsg) return true;

      const responseText = await this.callYuanQiAPI(userMsg, userId);
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
        assistant_id: this.config.assistant_id,
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
            Authorization: "Bearer " + this.config.assistant_token,
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
