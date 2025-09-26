import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import moment from 'moment';
import axios from 'axios';
import os from 'os';
import '../../../adapter/stdin.js'; // 初始化 stdinAdapter

// ---------------- 配置 ----------------
const HTTP_PORT = 2799;
const FRONTEND_PATH = path.join(process.cwd(), 'plugins', 'YunKit-plugin/res/frontend');
const MAX_LOG_LINES = 500;
const TOKEN_TTL = 30 * 60 * 1000; // 30分钟
const TOKEN_FILE = path.join(FRONTEND_PATH, 'tokens.json');
const USERS = [{ username: 'admin' }];
const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'mark'];
const LOG_RETENTION_DAYS = 2;

// ---------------- 全局缓存 ----------------
let logBuffer = [];
const logIds = new Set();
let connections = new Set();
let loginTokens = new Map(); // token -> { username, expire }

function cleanOldLogs() {
  if (!fs.existsSync(FRONTEND_PATH)) return;
  const files = fs.readdirSync(FRONTEND_PATH);
  const now = Date.now();

  files.forEach(file => {
    if (!/^bot-\d{4}-\d{2}-\d{2}\.log$/.test(file)) return; // 只处理 bot-YYYY-MM-DD.log
    const filePath = path.join(FRONTEND_PATH, file);
    const match = file.match(/^bot-(\d{4}-\d{2}-\d{2})\.log$/);
    if (!match) return;
    const fileDate = new Date(match[1]);
    if ((now - fileDate.getTime()) > LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
      fs.unlink(filePath, err => { if(!err) appendLog('info', `删除过期日志: ${file}`); });
    }
  });
}
// ---------------- token 持久化 ----------------
function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      for (const [token, info] of Object.entries(data)) {
        if (Date.now() < info.expire) loginTokens.set(token, info);
      }
    } catch (e) { console.error('加载 token 失败', e); }
  }
}

function saveTokens() {
  const obj = {};
  for (const [token, info] of loginTokens.entries()) obj[token] = info;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj, null, 2), 'utf-8');
}

setInterval(() => {
  let changed = false;
  for (const [token, info] of loginTokens.entries()) {
    if (Date.now() > info.expire) {
      loginTokens.delete(token);
      changed = true;
    }
  }
  if (changed) saveTokens();
}, 60 * 1000);

loadTokens();

function genToken() { return crypto.randomBytes(24).toString('hex'); }
function genTokenForUser(username) {
  for (const [t, info] of loginTokens.entries()) {
    if (info.username === username && Date.now() < info.expire) return t;
  }
  const token = genToken();
  loginTokens.set(token, { username, expire: Date.now() + TOKEN_TTL });
  saveTokens();
  return token;
}

function verifyToken(token) {
  const info = loginTokens.get(token);
  if (!info) return false;
  if (Date.now() > info.expire) { loginTokens.delete(token); saveTokens(); return false; }
  return info.username;
}

// ---------------- 日志工具 ----------------
function getLogFile() {
  const dateStr = moment().format('YYYY-MM-DD');
  return path.join(FRONTEND_PATH, `bot-${dateStr}.log`);
}

function genLogId(msg) {
  return crypto.createHash('md5').update(msg).digest('hex');
}

function appendLog(level, logs) {
  if (!Array.isArray(logs)) logs = [logs];
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss.SSS');
  const rawMessage = logs.join(' ');

  // 不再去重，直接生成每条日志唯一 ID
  const logId = crypto.randomBytes(12).toString('hex');

  const logItem = { id: logId, level, timestamp, raw: rawMessage };
  logBuffer.push(logItem);

  // 保持 logBuffer 不超过最大行数
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  }


  fs.appendFileSync(getLogFile(), rawMessage + '\n', 'utf-8');

  const payload = JSON.stringify({ type: 'logger', ...logItem });
  for (const ws of connections) {
    if (ws.readyState === ws.OPEN) {
      ws._sentLogs = ws._sentLogs || new Set();
      if (ws._sentLogs.has(logId)) continue;
      ws._sentLogs.add(logId);
      ws.send(payload);
    }
  }
}

// ---------------- 代理全局 logger ----------------
function proxyLogger(){
  if(global.logger?.logger){
    global.logger.logger = new Proxy(global.logger.logger,{
      get(target,p){
        if(typeof p==='string' && logLevels.includes(p)){
          return (...args)=>{ appendLog(p,args); return target[p](...args); }
        }
        return target[p];
      }
    });
  }else if(global.logger){
    global.logger = new Proxy(global.logger,{
      get(target,p){
        if(typeof p==='string' && logLevels.includes(p)){
          return (...args)=>{ appendLog(p,args); return target[p](...args); }
        }
        return target[p];
      }
    });
  }else console.warn('未找到全局 logger 对象');
}
proxyLogger();

function proxyBotLogs() {
  if (!global.Bot) return;

  function createLoggerProxy(target) {
    return new Proxy(target, {
      get(t, p) {
        const orig = t[p];

        // 如果是 logLevels 内的方法，拦截
        if (typeof p === 'string' && logLevels.includes(p) && typeof orig === 'function') {
          return (...args) => {
            appendLog(p, args);
            return orig.apply(t, args);
          };
        }

        // 如果是函数但不在 logLevels 内，直接绑定返回
        if (typeof orig === 'function') return orig.bind(t);

        // 非函数属性直接返回
        return orig;
      }
    });
  }

  // 代理 Bot.logger
  if (global.Bot.logger) {
    const target = global.Bot.logger.logger || global.Bot.logger;
    global.Bot.logger = createLoggerProxy(target);
  }

  // 捕获 Bot.makeLog
  if (global.Bot.makeLog) {
    const original = global.Bot.makeLog.bind(global.Bot);
    global.Bot.makeLog = (level, msg, ...args) => {
      appendLog(level || 'info', msg);
      return original(level, msg, ...args);
    };
  }



  // 捕获 Bot.makeLog
  if (global.Bot.makeLog) {
    const original = global.Bot.makeLog.bind(global.Bot);
    global.Bot.makeLog = (level, msg, ...args) => {
      appendLog(level || 'info', msg);
      return original(level, msg, ...args);
    };
  }
}
proxyBotLogs();

// ---------------- 捕获 console ----------------
['log','info','warn','error','debug'].forEach(method=>{
  const original = console[method];
  console[method] = (...args)=>{
    appendLog(method==='log'?'info':method,args);
    original.apply(console,args);
  };
});

// ---------------- 捕获 stdinAdapter ----------------
function captureStdinAdapter(){
  if(globalThis.Bot?.stdinAdapter){
    const adapter = globalThis.Bot.stdinAdapter;
    ['message','sendMsg','sendFile','recallMsg','pickFriend'].forEach(fn=>{
      if(adapter[fn]){
        const original = adapter[fn].bind(adapter);
        adapter[fn] = async (...args)=>{
          appendLog('mark',[`[stdinAdapter] ${fn} ${JSON.stringify(args)}`]);
          return original(...args);
        };
      }
    });
  }
}
captureStdinAdapter();

// ---------------- 加载当天日志 ----------------
(function loadTodayLogs() {
  const todayFile = getLogFile();
  if (!fs.existsSync(todayFile)) return;
  const lines = fs.readFileSync(todayFile, 'utf-8').split('\n').filter(Boolean).slice(-MAX_LOG_LINES);
  for (const line of lines) {
    const id = genLogId(line.replace(/\x1B\[[0-9;]*m/g, ''));
    if (logIds.has(id)) continue;
    logBuffer.push({ id, level: 'info', timestamp: moment().format('YYYY-MM-DD HH:mm:ss.SSS'), raw: line });
    logIds.add(id);
  }
})();

// ---------------- IP 获取 ----------------
function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

async function getPublicIP() {
  if (global.publicIP) return global.publicIP;
  const urls = [
    { api: 'https://v4.ip.zxinc.org/info.php?type=json', key: 'data.myip' },
    { api: 'https://ipinfo.io/json', key: 'ip' }
  ];
  for (const u of urls) {
    try {
      const res = await axios.get(u.api, { timeout: 3000 });
      const parts = u.key.split('.');
      let ip = res.data;
      for (const p of parts) ip = ip?.[p];
      if (ip) { global.publicIP = ip; return ip; }
    } catch { }
  }
  return null;
}

async function getServerIPs() {
  return { local: getLocalIPs(), public: await getPublicIP() };
}

// ---------------- HTTP 前端 ----------------
const app = express();
app.use(express.static(FRONTEND_PATH));
app.use(express.json());

app.get('/history', (req, res) => {
  let token = req.headers['authorization']?.split(' ')[1] || req.query.token;
  if (!token || !verifyToken(token)) return res.status(401).json({ error: 'token 无效或已过期' });
  res.json(logBuffer);
});

app.get('/', (req, res) => {
  const token = req.query.token;
  if (!token || !verifyToken(token)) return res.redirect('/login.html');
  res.sendFile(path.join(FRONTEND_PATH, 'index.html'));
});

app.get('/login/:username', (req, res) => {
  res.status(403).json({ ok: false, msg: '此接口已禁用，请通过插件生成 token' });
});

app.post('/verify-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ valid: false });
  const username = verifyToken(token);
  if (!username) return res.status(401).json({ valid: false });
  res.json({ valid: true, username });
});

// ---------------- 启动 HTTP+WS ----------------
const rawLogger = global.logger?.info || console.info;

const server = app.listen(HTTP_PORT, '0.0.0.0', async () => {
  const ips = await getServerIPs();
  rawLogger('HTTP+WS 服务已启动');
  ips.local.forEach(ip => rawLogger(`  内网: http://${ip}:${HTTP_PORT}`));
  if (ips.public) rawLogger(`  公网: http://${ips.public}:${HTTP_PORT}`);
});



// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const url = req.url;
  const query = new URLSearchParams(url.split('?')[1]);
  const token = query.get('token');
  const username = verifyToken(token);
  if (!username) {
    ws.send(JSON.stringify({ type: 'auth_error', content: 'token 无效或已过期' }));
    ws.close();
    return;
  }

  connections.add(ws);
  ws._sentLogs = new Set();  // 用于追踪已发送的日志 ID
  
  // 发送尚未发送过的日志
  logBuffer.forEach(({ id, level, timestamp, content }) => {
    if (!ws._sentLogs.has(id)) {
      ws._sentLogs.add(id);  // 记录已发送的日志 ID
      ws.send(JSON.stringify({ type: 'logger', level, timestamp, content, id }));
    }
  });
  //ws.send(JSON.stringify({ type: 'auth_success', content: `欢迎 ${username} 登录` }));

  ws.on('message', async msg => {
    let data;
    try { data = JSON.parse(msg.toString()); } catch { return; }
    const adapter = Bot?.stdinAdapter;
    if (!adapter) return appendLog('warn', ['Bot.stdinAdapter 未初始化，无法发送命令']);

    try {
      switch (data.method) {
        case 'message': await adapter.message(data.content); break;
        case 'sendMsg': await adapter.sendMsg(data.content); break;
        case 'sendFile': await adapter.sendFile(data.file, data.name); break;
        case 'recallMsg': adapter.recallMsg(data.message_id); break;
        case 'pickFriend': adapter.pickFriend(); break;
        default: await adapter.message(data.content || ''); break;
      }
      appendLog('mark', [`[${username} 执行命令] ${data.method} ${JSON.stringify(data)}`]);
    } catch (e) {
      appendLog('error', [`执行失败: ${e.message}`]);
      ws.send(JSON.stringify({ type: 'error', content: e.message }));
    }
  });

  ws.on('close', () => { connections.delete(ws);  });
  ws.on('error', () => { connections.delete(ws);  });
});

// 启动时清理一次
cleanOldLogs();
// 每天凌晨自动清理一次
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000);
// ---------------- Yunzai v3 插件 ----------------
export class LoginLinkPlugin extends plugin {
  constructor() {
    super({
      name: '登录链接',
      dsc: '生成 TRSS-YunKit Web 前端登录链接（支持内外网和单独 token）',
      event: 'message',
      priority: -9999999,
      rule: [{ reg: "^(#|/)?登录链接$", fnc: "handMade", permission: "master" }] 
    });
  }

  // 获取内网 IP
  getLocalIPs() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
      }
    }
    return ips;
  }

  // 获取公网 IP
  async getPublicIP() {
    if (global.publicIP) return global.publicIP;
    const urls = [
      { api: 'https://v4.ip.zxinc.org/info.php?type=json', key: 'data.myip' },
      { api: 'https://ipinfo.io/json', key: 'ip' }
    ];
    for (const u of urls) {
      try {
        const res = await axios.get(u.api, { timeout: 3000 });
        let ip = res.data;
        for (const p of u.key.split('.')) ip = ip?.[p];
        if (ip) { global.publicIP = ip; return ip; }
      } catch {}
    }
    return null;
  }

  async handMade(e) {
    try {
      const username = USERS[0]?.username;
      if (!username) return e.reply('未配置用户，无法生成登录链接');

      // 获取已有有效 token 或生成新 token
      let token = null;
      let expire = null;
      for (const [t, info] of loginTokens.entries()) {
        if (info.username === username && Date.now() < info.expire) {
          token = t;
          expire = info.expire;
          break;
        }
      }
      if (!token) {
        token = genTokenForUser(username);
        expire = Date.now() + TOKEN_TTL;
      }

      const remainingMinutes = Math.ceil((expire - Date.now()) / 60000);

      // 获取 IP
      const localIPs = this.getLocalIPs();
      const publicIP = await this.getPublicIP();

      // 构建 URL 列表
const urls = [];
localIPs.forEach(ip => {
  urls.push({
    url: `http://${ip}:${HTTP_PORT}/?token=${token}`,
    label: '内网'
  });
});
if (publicIP) {
  urls.push({
    url: `http://${publicIP}:${HTTP_PORT}/?token=${token}`,
    label: '公网'
  });
}

// 构建提示信息
let msg = `登录链接已生成，剩余有效时间：${remainingMinutes} 分钟\n`;
msg += `token: ${token}\n`;
msg += `可访问链接：\n`;

urls.forEach(u => msg += `  ${u.label}: ${u.url}\n`);

await e.reply(msg);
    } catch (e) {
      await e.reply(`登录链接生成失败，错误信息：${e}`);
    }
  }
}


