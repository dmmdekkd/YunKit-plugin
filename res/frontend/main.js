// ---------------- DOM ----------------
const logDiv = document.getElementById('log');
const cmdInput = document.getElementById('cmd');
const levelFilter = document.getElementById('levelFilter');
const methodSelect = document.getElementById('methodSelect');
const fileInput = document.getElementById('fileInput');
const previewContent = document.getElementById('previewContent');
const MAX_LOG_LINES = 100;

// ---------------- 日志等级 ----------------
const levels = ['trace','debug','info','warn','error','fatal','mark'];
let currentLevel = (levelFilter && levelFilter.value) || 'trace';
const levelPriority = { trace:0, debug:1, info:2, warn:3, error:4, fatal:5, mark:6 };

// 监听等级筛选变化
if(levelFilter){
  levelFilter.addEventListener('change', ()=>{
    currentLevel = levelFilter.value || 'trace';
    renderLogs();
  });
}

// ---------------- token 验证 ----------------
let token = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('token');
if(!token) redirectLogin();
else localStorage.setItem('token', token);

function redirectLogin(){
  localStorage.removeItem('token');
  window.location.href = '/login.html';
}

// ---------------- ANSI 去除 ----------------
function stripAnsi(str){
  if(!str) return '';
  return str.replace(/\x1B\[[0-9;]*m/g,'');
}

// 简单 HTML escape（ansi_up 不存在时降级使用）
function htmlEscape(s){
  if(!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ---------------- 日志缓存 ----------------
let logs = [];
let seenIds = new Set();

// 从 blocks 构造文本内容（按 textN 顺序）
function buildContentFromBlocks(blocks){
  if(!blocks || typeof blocks !== 'object') return '';
  return Object.keys(blocks)
    .sort((a,b)=> parseInt(a.replace('text','')) - parseInt(b.replace('text','')))
    .map(k=> (typeof blocks[k] === 'string' ? blocks[k] : blocks[k].text || '') )
    .join(' ');
}

// ---------------- 添加日志 ----------------
function appendLog(logItem){
  if(!logItem) return;

  let rawContent = logItem.content || logItem.raw || buildContentFromBlocks(logItem.blocks || {});
  if(!rawContent) return;

  const cleanContent = stripAnsi(rawContent);
  if(!cleanContent) return;

  if(logItem.id && seenIds.has(logItem.id)) return;
  if(logItem.id) seenIds.add(logItem.id);

  const level = (logItem.level || 'info').toLowerCase();
  const timestamp = logItem.timestamp || (new Date()).toISOString();

  const blocks = {};
  if(logItem.blocks && typeof logItem.blocks === 'object'){
    const keys = Object.keys(logItem.blocks).sort((a,b)=> parseInt(a.replace('text','')) - parseInt(b.replace('text','')));
    keys.forEach((k,i)=>{
      const value = logItem.blocks[k];
      blocks['text'+(i+1)] = { text: (typeof value === 'string' ? value : (value.text || '')), color: (value && value.color) ? value.color : '' };
    });
  } else {
    let idx = 1;
    cleanContent.split(/\s+/).forEach(text=>{
      if(text.trim()) blocks['text'+idx] = { text }; idx++;
    });
  }

  logs.push({ id: logItem.id, level, timestamp, content: cleanContent, blocks });

  if(logs.length > MAX_LOG_LINES){
    const removed = logs.splice(0, logs.length - MAX_LOG_LINES);
    removed.forEach(v=>v.id && seenIds.delete(v.id));
  }

  renderLogs();
}

// ---------------- 创建 span ----------------
function createSpan(text, cls){
  const span = document.createElement('span');
  span.textContent = text;
  if(cls) span.classList.add(cls);
  return span;
}

// helper: 把文本转换为 innerHTML（优先 ansi_up）
function toSafeHtml(text){
  if(typeof text !== 'string') text = ''+text;
  if(window.ansi_up && typeof ansi_up.ansi_to_html === 'function'){
    try { return ansi_up.ansi_to_html(text); } catch(e){ return htmlEscape(text); }
  }
  return htmlEscape(text);
}

function setVh() {
  document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
}

window.addEventListener('resize', setVh);
window.addEventListener('orientationchange', setVh);
window.addEventListener('load', setVh);

// ---------------- 渲染日志 ----------------
function renderLogs(){
  if(!logDiv) return;
  logDiv.innerHTML = '';
  const currentPriority = levelPriority[currentLevel] ?? 0;

  logs.forEach(logItem=>{
    const { level, timestamp, blocks, content } = logItem;
    if(levelPriority[(level || 'info').toLowerCase()] < currentPriority) return;

    const lineDiv = document.createElement('div');
    lineDiv.className = `log-line ${(level || 'info').toLowerCase()}`;

    const leftSpan = document.createElement('span');
    leftSpan.className = 'log-left ' + (level || 'info').toLowerCase();
    if(timestamp) leftSpan.appendChild(createSpan(`[${timestamp}] `, 'timestamp'));
    if(level) leftSpan.appendChild(createSpan(`[${(level||'').toUpperCase()}] `, 'level'));

    const rightSpan = document.createElement('span');
    rightSpan.className = 'log-right ' + (level || 'info').toLowerCase();

    if(blocks && Object.keys(blocks).length){
      Object.keys(blocks)
        .sort((a,b)=>parseInt(a.replace('text','')) - parseInt(b.replace('text','')))
        .forEach(key=>{
          const span = document.createElement('span');
          span.innerHTML = toSafeHtml(blocks[key].text || '');
          span.className = key;
          rightSpan.appendChild(span);
        });
    } else if(content){
      const span = document.createElement('span');
      span.innerHTML = toSafeHtml(content);
      rightSpan.appendChild(span);
    }

    lineDiv.appendChild(leftSpan);
    lineDiv.appendChild(rightSpan);
    logDiv.appendChild(lineDiv);
  });

  logDiv.scrollTop = logDiv.scrollHeight;
}

// ---------------- WebSocket ----------------
let ws;
let wsReconnectTimer;

// 安全重连函数
function scheduleReconnect(){
  if(wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(()=>{
    wsReconnectTimer = null;
    connectWS();
  }, 3000);
}

function connectWS(){
  if(ws && ws.readyState === WebSocket.OPEN) return;

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/?token=${token}`;

  try {
    ws = new WebSocket(wsUrl);
  } catch(err) {
    appendLog({ level:'error', content: '[系统] 无法创建 WebSocket: '+(err.message||err) });
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    if(wsReconnectTimer){ clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    appendLog({ level: 'mark', content: '[系统] WebSocket 已连接' });
  };

  ws.onclose = () => {
    appendLog({ level: 'warn', content: '[系统] WebSocket 已断开，3秒后重连...' });
    scheduleReconnect();
  };

  ws.onerror = err => {
    const msg = (err && err.message) ? err.message : JSON.stringify(err);
    appendLog({ level: 'error', content: '[系统] WebSocket 错误: ' + msg });
    scheduleReconnect();
  };

  ws.onmessage = event => {
    let data;
    try { data = JSON.parse(event.data); } catch(e){ return appendLog({ level:'debug', content: '[系统] 收到非 JSON 消息' }); }
    if(data.type === 'auth_error') { redirectLogin(); return; }

    switch(data.type){
      case 'logger':
        appendLog({ id: data.id, level: data.level || 'info', timestamp: data.timestamp, content: data.content, raw: data.raw, blocks: data.blocks });
        break;
      case 'result':
        appendLog({ level: 'mark', content: '[调用结果] ' + (data.content || data.result || '') });
        break;
      case 'error':
        appendLog({ level: 'error', content: '[调用失败] ' + (data.content || data.message || '') });
        break;
      default:
        appendLog({ level: 'debug', content: '[未知消息] ' + JSON.stringify(data) });
    }
  };
}

// ---------------- 命令发送 ----------------
function sendCommand(){
  if(!ws || ws.readyState !== WebSocket.OPEN) {
    return appendLog({level:'warn', content:'[系统] WebSocket 未连接'});
  }

  const method = methodSelect.value || 'message';
  const payload = { action: 'call', method };

  // 处理文件发送
  if(method === 'sendFile'){
    if(!fileInput || !fileInput.files.length){
      return appendLog({level:'warn', content:'[系统] 请先选择文件'});
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = e => {
      payload.file = e.target.result; // base64 数据
      payload.name = file.name;

      ws.send(JSON.stringify(payload));
      appendLog({level:'mark', content:`[发送文件] ${file.name}`});

      // 清空输入和文件选择
      cmdInput.value = '';
      fileInput.value = '';
      const label = document.querySelector('label[for="fileInput"]');
      if(label) label.textContent = '选择文件';
    };

    reader.readAsDataURL(file);
    return; // 异步发送文件后直接 return
  }


  
  // 处理普通消息
  const cmd = cmdInput.value.trim();
  if(method === 'sendMsg'){
    payload.content = [{ type: 'text', text: cmd }];
  } else if(method === 'message' || method === 'recallMsg'){
    payload.content = cmd;
  }

  ws.send(JSON.stringify(payload));
  appendLog({level:'mark', content:`[发送] ${method} -> ${cmd}`});
  cmdInput.value = '';
}

// ---------------- 初始化 ----------------
window.addEventListener('DOMContentLoaded', () => {
  // 获取元素
  const cmdInput = document.getElementById('cmd');
  const cmdSendBtn = document.getElementById('cmdSendBtn'); // 命令输入框旁按钮
  const topSendBtn = document.getElementById('topSendBtn'); // 顶部控制区按钮
  const openPreviewBtn = document.getElementById('openPreviewBtn');

  if(fileInput){
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      const label = document.querySelector('label[for="fileInput"]');
      if(file){
        // 显示已选择文件名
        if(label) label.textContent = `已选择: ${file.name}`;
        appendLog({level:'mark', content:`[系统] 已选择文件: ${file.name}`});
      } else {
        if(label) label.textContent = '选择文件';
        appendLog({level:'mark', content:`[系统] 未选择文件`});
      }
    });
  }
  
  // 加载历史日志并连接 WS
  loadHistoryLogs().then(() => connectWS());

  // 回车发送命令
  if (cmdInput) {
    cmdInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') sendCommand();
    });
  }

  // 命令输入框旁按钮发送命令
  if (cmdSendBtn) {
    cmdSendBtn.addEventListener('click', () => sendCommand());
  }

  function handleTopSend(){
    sendCommand(); // 顶部按钮直接发送命令/文件
  }

  // 顶部按钮逻辑
  if (topSendBtn) {
    topSendBtn.addEventListener('click', () => {
      // 这里处理顶部区域发送逻辑
      handleTopSend();
    });
  }

  
  // 打开日志预览
  if (openPreviewBtn) {
    openPreviewBtn.addEventListener('click', () => {
      const contentArr = logs.map(l => l?.content || '');
      const text = contentArr.join('\n');
      if (typeof showLongText === 'function') showLongText(text);
      else alert(text.slice(0, 10000));
    });
  }
});


// ---------------- 历史日志 ----------------
async function loadHistoryLogs(){
  try{
    const res = await fetch('/history', { headers:{ 'Authorization': 'Bearer '+token } });
    if(res.status === 401 || res.status === 403) return redirectLogin();
    const historyLogs = await res.json();
    historyLogs.slice(-MAX_LOG_LINES).forEach(l => appendLog(l));
  } catch(err){
    appendLog({level:'error', content:'[系统] 获取历史日志失败: '+(err.message||err)});
  }
}
