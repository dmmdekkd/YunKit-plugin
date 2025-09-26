import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 文件操作的异步版本
const fsPromises = {
  exists: promisify(fs.existsSync),
  read: promisify(fs.readFile),
  write: promisify(fs.writeFile),
  rename: promisify(fs.rename),
  unlink: promisify(fs.unlink),
};

// 锁文件路径，用于确保文件操作的原子性
const lockFile = path.resolve(__dirname, "../../bak/stdin.lock");

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

  async fileExists(p) {
    return fsPromises.exists(p);
  }

  async readFile(p) {
    return fsPromises.read(p, "utf-8");
  }

  async writeFile(p, content) {
    return fsPromises.write(p, content, "utf-8");
  }

  async lock() {
    if (await this.fileExists(lockFile)) {
      throw new Error("文件正在被操作中，请稍后再试！");
    }
    await this.writeFile(lockFile, 'locked');
  }

  async unlock() {
    if (await this.fileExists(lockFile)) {
      await fsPromises.unlink(lockFile);
    }
  }

  // 替换命令：先备份当前 stdin.js，再替换
  async replaceStdin(e) {
    try {
      await this.lock(); // 加锁，确保操作不被并发打断

      if (!(await this.fileExists(this.backupPath))) {
        return this.replyMsg(e, "备份文件不存在: " + this.backupPath);
      }
      if (!(await this.fileExists(this.stdinPath))) {
        return this.replyMsg(e, "目标文件不存在: " + this.stdinPath);
      }

      const currentContent = await this.readFile(this.stdinPath);
      const backupContent = await this.readFile(this.backupPath);

      if (currentContent === backupContent) {
        return this.replyMsg(e, "stdin.js 已经是最新备份，无需替换！");
      }

      // 先备份当前文件到 tmp
      await this.writeFile(this.tmpBackupPath, currentContent);

      // 替换为 bak 文件
      await this.writeFile(this.stdinPath, backupContent);

      await this.replyMsg(e, `stdin.js 已成功替换为备份文件！当前文件已临时备份到 ${this.tmpBackupPath}`);
    } catch (err) {
      await this.replyMsg(e, "替换失败: " + err.message);
    } finally {
      await this.unlock(); // 解锁
    }
  }

  // 还原命令：从 bak 文件恢复到 stdin.js
  async restoreStdin(e) {
    try {
      await this.lock(); // 加锁，确保操作不被并发打断

      if (!(await this.fileExists(this.backupPath))) {
        return this.replyMsg(e, "备份文件不存在: " + this.backupPath);
      }
      if (!(await this.fileExists(this.stdinPath))) {
        return this.replyMsg(e, "目标文件不存在: " + this.stdinPath);
      }

      // 先备份当前文件到 tmp
      const currentContent = await this.readFile(this.stdinPath);
      await this.writeFile(this.tmpBackupPath, currentContent);

      // 写入 bak 文件到 stdin.js
      await this.writeFile(this.stdinPath, await this.readFile(this.backupPath));

      await this.replyMsg(e, `stdin.js 已从备份恢复，原文件已备份到 ${this.tmpBackupPath}`);
    } catch (err) {
      await this.replyMsg(e, "恢复失败: " + err.message);
    } finally {
      await this.unlock(); // 解锁
    }
  }
}
