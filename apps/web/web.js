/**
 * TRSS-YunKit 实时日志服务 + 登录 token + 完整捕获
 * 依赖: npm install express ws moment fs crypto axios
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import moment from 'moment';
import axios from 'axios';
import '../../../adapter/stdin.js'; // 初始化 stdinAdapter

// ---------------- 配置 ----------------
const HTTP_PORT = 8000;
const WS_PORT = 8080;
const FRONTEND_PATH = path.join(process.cwd(), 'plugins', 'YunKit-plugin/res/frontend');
const MAX_LOG_LINES = 500;
const TOKEN_TTL = 30 * 60 * 1000; // 30分钟
const TOKEN_FILE = path.join(FRONTEND_PATH, 'tokens.json');
const USERS = [{ username:'admin' }];
const logLevels = ['trace','debug','info','warn','error','fatal','mark'];

// ---------------- 全局缓存 ----------------
let logBuffer = [];
const logIds = new Set();
let connections = new Set();
let loginTokens = new Map(); // token -> { username, expire }

// ---------------- token 持久化 ----------------
function loadTokens(){
  if(fs.existsSync(TOKEN_FILE)){
    try{
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE,'utf-8'));
      for(const [token,info] of Object.entries(data)){
        if(Date.now() < info.expire) loginTokens.set(token, info);
      }
    }catch(e){ console.error('加载 token 失败', e); }
  }
}

function saveTokens(){
  const obj = {};
  for(const [token,info] of loginTokens.entries()) obj[token] = info;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(obj,null,2), 'utf-8');
}

setInterval(()=>{
  let changed = false;
  for(const [token,info] of loginTokens.entries()){
    if(Date.now() > info.expire){
      loginTokens.delete(token);
      changed = true;
    }
  }
  if(changed) saveTokens();
}, 60*1000);

loadTokens();

function genToken(){ return crypto.randomBytes(24).toString('hex'); }
function genTokenForUser(username){
  for(const [t,info] of loginTokens.entries()){
    if(info.username===username && Date.now()<info.expire) return t;
  }
  const token = genToken();
  loginTokens.set(token, { username, expire: Date.now()+TOKEN_TTL });
  saveTokens();
  return token;
}

function verifyToken(token){
  const info = loginTokens.get(token);
  if(!info) return false;
  if(Date.now() > info.expire){ loginTokens.delete(token); saveTokens(); return false; }
  return info.username;
}

// ---------------- 日志工具 ----------------
function getLogFile(){
  const dateStr = moment().format('YYYY-MM-DD');
  return path.join(FRONTEND_PATH, `bot-${dateStr}.log`);
}

function genLogId(msg){
  return crypto.createHash('md5').update(msg).digest('hex');
}

function appendLog(level, logs){
  if(!Array.isArray(logs)) logs=[logs];
  const timestamp = moment().format('YYYY-MM-DD HH:mm:ss.SSS');
  const rawMessage = logs.join(' ');

  // 去掉颜色用于去重
  const dedupStr = rawMessage.replace(/\x1B\[[0-9;]*m/g,'');
  const logId = genLogId(dedupStr);
  if(logIds.has(logId)) return;
  logIds.add(logId);

  // 提取所有中括号部分
  const pattern = /\[([^\]]+)\]/g;
  const parts = [];
  let match;
  while((match=pattern.exec(rawMessage))!==null) parts.push(match[1]);

  // 多块化处理 content
  const ansiPattern = /(\x1B\[[0-9;]*m)?([^\x1B]+)/g;
  const blocks = {};
  let m, idx = 1;
  while ((m = ansiPattern.exec(rawMessage)) !== null) {
    const colorCode = m[1] || '';
    const text = m[2] || '';
    if(text.trim()) {
      blocks['text'+idx] = { text, color: colorCode };
      idx++;
    }
  }

  const logItem = {
    id: logId,
    level,
    timestamp,
    source: parts[0]||'',
    module: parts[1]||'',
    count: parts[2]||'',
    size: parts[3]||'',
    time: parts[4]||'',
    raw: rawMessage,
    blocks // 多块化内容
  };

  logBuffer.push(logItem);
  if(logBuffer.length > MAX_LOG_LINES){
    const removed = logBuffer.splice(0, logBuffer.length-MAX_LOG_LINES);
    removed.forEach(v=>logIds.delete(v.id));
  }


  fs.appendFileSync(getLogFile(), rawMessage+'\n','utf-8');

  const payload = JSON.stringify({ type:'logger', ...logItem });
  for(const ws of connections){
    if(ws.readyState===ws.OPEN){
      ws._sentLogs = ws._sentLogs||new Set();
      if(ws._sentLogs.has(logId)) continue;
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
(function loadTodayLogs(){
  const todayFile = getLogFile();
  if(!fs.existsSync(todayFile)) return;
  const lines = fs.readFileSync(todayFile,'utf-8').split('\n').filter(Boolean).slice(-MAX_LOG_LINES);
  for(const line of lines){
    const dedupStr = line.replace(/\x1B\[[0-9;]*m/g,'');
    const id = genLogId(dedupStr);
    if(logIds.has(id)) continue;
    const pattern = /\[([^\]]+)\]/g;
    const parts = [];
    let match;
    while((match=pattern.exec(line))!==null) parts.push(match[1]);
    logBuffer.push({
      id,
      level:'info',
      timestamp:parts[0]||moment().format('YYYY-MM-DD HH:mm:ss.SSS'),
      source:parts[0]||'',
      module:parts[1]||'',
      count:parts[2]||'',
      size:parts[3]||'',
      time:parts[4]||'',
      content: line
    });
    logIds.add(id);
  }
})();

// ---------------- HTTP 前端 ----------------
const app = express();
app.use(express.static(FRONTEND_PATH));
app.use(express.json());

app.get('/history',(req,res)=>{
  let token = req.headers['authorization']?.split(' ')[1];
  if(!token) token = req.query.token;
  if(!token || !verifyToken(token)) return res.status(401).json({ error:'token 无效或已过期' });
  res.json(logBuffer);
});

app.get('/',(req,res)=>{
  const token = req.query.token;
  if(!token || !verifyToken(token)) return res.redirect('/login.html');
  res.sendFile(path.join(FRONTEND_PATH,'index.html'));
});

app.get('/login/:username',(req,res)=>{
  const username = req.params.username;
  const user = USERS.find(u=>u.username===username);
  if(!user) return res.status(401).json({ok:false,msg:'用户不存在'});
  const token = genTokenForUser(username);
  appendLog('info', [`[登录生成 token] 用户:${username} token:${token}`]);
  res.json({
    ok:true,
    msg:`请在 ${TOKEN_TTL/60000} 分钟内使用 token 登录`,
    token,
    loginUrl:`http://localhost:${HTTP_PORT}/?token=${token}`
  });
});

app.post('/verify-token',(req,res)=>{
  const { token } = req.body;
  if(!token) return res.status(400).json({ valid:false });
  const username = verifyToken(token);
  if(!username) return res.status(401).json({ valid:false });
  res.json({ valid:true, username });
});

app.listen(HTTP_PORT,()=>console.log(`HTTP 前端已启动: http://localhost:${HTTP_PORT}`));

// ---------------- WebSocket ----------------
const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WebSocket 日志服务已启动: ws://localhost:${WS_PORT}`);

wss.on('connection',(ws,req)=>{
  const url = req.url;
  const query = new URLSearchParams(url.split('?')[1]);
  const token = query.get('token');
  const username = verifyToken(token);
  if(!username){
    ws.send(JSON.stringify({type:'auth_error', content:'token 无效或已过期'}));
    ws.close();
    return;
  }

  connections.add(ws);
  ws._sentLogs = new Set();
  appendLog('info', `[WS 已连接] 用户:${username}`);

  logBuffer.forEach(({level, content, id})=>{
    if(!ws._sentLogs.has(id)){
      ws._sentLogs.add(id);
      ws.send(JSON.stringify({ type:'logger', level, content, id }));
    }
  });

  ws.on('message', async msg=>{
    let data;
    try{ data = JSON.parse(msg.toString()); }catch{return;}

    if(data.action==='command'||data.action==='call'){
      const adapter = Bot?.stdinAdapter;
      if(!adapter){
        appendLog('warn',['Bot.stdinAdapter 未初始化，无法发送命令']);
        return;
      }
      try{
        switch(data.method){
          case 'message': await adapter.message(data.content); break;
          case 'sendMsg': await adapter.sendMsg(data.content); break;
          case 'sendFile': await adapter.sendFile(data.file,data.name); break;
          case 'recallMsg': adapter.recallMsg(data.message_id); break;
          case 'pickFriend': adapter.pickFriend(); break;
          default: await adapter.message(data.content||''); break;
        }
        appendLog('mark',[`[${username} 执行命令] ${data.method} ${JSON.stringify(data)}`]);
      }catch(e){
        appendLog('error',[`执行失败: ${e.message}`]);
        ws.send(JSON.stringify({type:'error', content:e.message}));
      }
    }
  });

  ws.on('close',()=>{ connections.delete(ws); appendLog('info', `[WS 已关闭] 用户:${username}`); });
  ws.on('error',()=>{ connections.delete(ws); appendLog('warn', `[WS 错误] 用户:${username}`); });
});

// ---------------- Yunzai v3 插件 ----------------
export class LoginLinkPlugin extends plugin{
  constructor(){
    super({
      name:'登录链接',
      dsc:'生成 TRSS-YunKit Web 前端登录链接',
      event:'message',
      priority:1000,
      rule:[{ reg:"^(#|/)?登录链接$", fnc:"handMade" }]
    });
  }

  async handMade(e){
    try{
      const username = USERS[0]?.username;
      if(!username) return e.reply('未配置用户，无法生成登录链接');

      const res = await axios.get(`http://localhost:${HTTP_PORT}/login/${username}`);
      if(!res.data?.ok) return e.reply(`生成失败: ${res.data?.msg||'未知错误'}`);

      const httpUrl = `http://localhost:${HTTP_PORT}/?token=${res.data.token}`;
      await e.reply(`登录链接已生成，请在 ${TOKEN_TTL/60000} 分钟内使用：\n${httpUrl}`);
    }catch(err){
      await e.reply(`生成登录链接失败: ${err.message}`);
    }
  }
}
