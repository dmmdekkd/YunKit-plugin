import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class StdinReplacePlugin extends plugin {
  constructor() {
    super({
      name: "Stdin替换与还原",
      dsc: "备份与还原标准输入适配器（stdin.js），替换前自动备份",
      event: "message",
      priority: 1000,
      rule: [
        { reg: "^(#|/)?替换标准$", fnc: "replaceStdin", permission: "master" },
        { reg: "^(#|/)?还原标准$", fnc: "restoreStdin", permission: "master" }
      ]
    });

    // 目标文件路径
    this.stdinPath = path.resolve(__dirname, "../../../adapter/stdin.js");
    // 备份文件路径（bak 文件）
    this.backupPath = path.resolve(__dirname, "../../bak/stdin.js.bak");
    // 临时备份路径
    this.tmpBackupPath = path.resolve(__dirname, "../../bak/stdin.js.bak.tmp");
  }

  async replyMsg(e, msg) {
    try { await e.reply(msg); } catch {}
  }

  fileExists(p) {
    return fs.existsSync(p);
  }

  readFile(p) {
    return fs.readFileSync(p, "utf-8");
  }

  writeFile(p, content) {
    fs.writeFileSync(p, content, "utf-8");
  }

  // 替换命令：先备份当前 stdin.js，再替换
  async replaceStdin(e) {
    if (!this.fileExists(this.backupPath)) return this.replyMsg(e, "备份文件不存在: " + this.backupPath);
    if (!this.fileExists(this.stdinPath)) return this.replyMsg(e, "目标文件不存在: " + this.stdinPath);

    const currentContent = this.readFile(this.stdinPath);
    const backupContent = this.readFile(this.backupPath);

    if (currentContent === backupContent) {
      return this.replyMsg(e, "stdin.js 已经是最新备份，无需替换！");
    }

    try {
      // 先备份当前文件到 tmp
      this.writeFile(this.tmpBackupPath, currentContent);

      // 替换为 bak 文件
      this.writeFile(this.stdinPath, backupContent);

      await this.replyMsg(e, `stdin.js 已成功替换为备份文件！当前文件已临时备份到 ${this.tmpBackupPath}`);
    } catch (err) {
      await this.replyMsg(e, "替换失败: " + err.message);
    }
  }

  // 还原命令：从 bak 文件恢复到 stdin.js
  async restoreStdin(e) {
    if (!this.fileExists(this.backupPath)) return this.replyMsg(e, "备份文件不存在: " + this.backupPath);
    if (!this.fileExists(this.stdinPath)) return this.replyMsg(e, "目标文件不存在: " + this.stdinPath);

    try {
      // 先备份当前文件到 tmp
      const currentContent = this.readFile(this.stdinPath);
      this.writeFile(this.tmpBackupPath, currentContent);

      // 写入 bak 文件到 stdin.js
      this.writeFile(this.stdinPath, this.readFile(this.backupPath));

      await this.replyMsg(e, `stdin.js 已从备份恢复，原文件已备份到 ${this.tmpBackupPath}`);
    } catch (err) {
      await this.replyMsg(e, "恢复失败: " + err.message);
    }
  }
}
