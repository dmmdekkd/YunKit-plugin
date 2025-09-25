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
let currentLevel = levelFilter.value;
const levelPriority = { trace:0, debug:1, info:2, warn:3, error:4, fatal:5, mark:6 };

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

// ---------------- 日志缓存 ----------------
let logs = [];
let seenIds = new Set();

// ---------------- 添加日志 ----------------
function appendLog(logItem){
  if(!logItem || !logItem.content) return;

  const cleanContent = stripAnsi(logItem.content); // 去掉 ANSI
  if(!cleanContent) return;

  if(logItem.id && seenIds.has(logItem.id)) return;
  if(logItem.id) seenIds.add(logItem.id);

  if(!logItem.level) logItem.level = 'info';
  if(!logItem.timestamp) logItem.timestamp = (new Date()).toISOString();

  // 生成 blocks 对象
  const blocks = {};
  let idx = 1;
  cleanContent.split(/\s+/).forEach(text=>{
    if(text.trim()) blocks['text'+idx] = { text };
    idx++;
  });

  logs.push({
    id: logItem.id,
    level: logItem.level,
    timestamp: logItem.timestamp,
    content: cleanContent,
    blocks
  });

  if(logs.length > MAX_LOG_LINES){
    const removed = logs.splice(0, logs.length - MAX_LOG_LINES);
    removed.forEach(v => v.id && seenIds.delete(v.id));
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

// ---------------- 渲染日志 ----------------
function renderLogs(){
  logDiv.innerHTML = '';
  const currentPriority = levelPriority[currentLevel];

  logs.forEach(logItem=>{
    const { level, timestamp, blocks, content } = logItem;
    if(levelPriority[level?.toLowerCase()] < currentPriority) return;

    const lineDiv = document.createElement('div');
    lineDiv.className = `log-line ${level.toLowerCase()}`;

    // 左侧：时间 + 等级
    const leftSpan = document.createElement('span');
    leftSpan.className = 'log-left ' + level.toLowerCase();
    if(timestamp) leftSpan.appendChild(createSpan(`[${timestamp}] `, 'timestamp'));
    if(level) leftSpan.appendChild(createSpan(`[${level.toUpperCase()}] `, 'level'));

    // 右侧：blocks 或 fallback content
    const rightSpan = document.createElement('span');
    rightSpan.className = 'log-right ' + level.toLowerCase();

    if(blocks && typeof blocks === 'object'){
      Object.keys(blocks)
        .sort((a,b)=>parseInt(a.replace('text','')) - parseInt(b.replace('text','')))
        .forEach(key=>{
          const span = document.createElement('span');
          span.innerHTML = ansi_up.ansi_to_html(blocks[key].text || '');
          span.className = key;
          rightSpan.appendChild(span);
        });
    } else if(content){
      const span = document.createElement('span');
      span.innerHTML = ansi_up.ansi_to_html(content);
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

function connectWS(){
  if(ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket(`ws://localhost:8080?token=${token}`);

  ws.onopen = ()=> appendLog({level:'mark', content:'[系统] WebSocket 已连接'});
  ws.onclose = ()=> { 
    appendLog({level:'warn', content:'[系统] WebSocket 已断开，3秒后重连...'}); 
    wsReconnectTimer = setTimeout(connectWS, 3000); 
  };
  ws.onerror = err => appendLog({level:'error', content:'[系统] WebSocket 错误: '+err.message});

  ws.onmessage = event => {
    let data;
    try { data = JSON.parse(event.data); } catch{return;}
    if(data.type === 'auth_error') { redirectLogin(); return; }

    switch(data.type){
      case 'logger':
        appendLog({
          id: data.id,
          level: data.level || 'info',
          content: data.content
        });
        break;
      case 'result': appendLog({level:'mark', content:'[调用结果] '+data.content}); break;
      case 'error': appendLog({level:'error', content:'[调用失败] '+data.content}); break;
      default: appendLog({level:'debug', content:'[未知消息] '+JSON.stringify(data)});
    }
  };
}

// ---------------- 命令发送 ----------------
function sendCommand(){
  if(!ws || ws.readyState!==WebSocket.OPEN) return appendLog({level:'warn', content:'[系统] WebSocket 未连接'});
  const cmd = cmdInput.value.trim();
  const method = methodSelect.value || 'message';
  const payload = {action:'call', method};

  if(method==='sendFile'){
    if(fileInput?.files.length){
      const file=fileInput.files[0];
      const reader=new FileReader();
      reader.onload=e=>{
        payload.file=e.target.result; payload.name=file.name;
        ws.send(JSON.stringify(payload));
        appendLog({level:'mark', content:`[发送文件] ${file.name}`});
      };
      reader.readAsDataURL(file); cmdInput.value=''; return;
    } else return appendLog({level:'warn', content:'[系统] 请先选择文件'});
  } else if(method==='sendMsg'){ payload.content=[{type:'text', text:cmd}]; }
  else if(method==='message'||method==='recallMsg'){ payload.content=cmd; }

  ws.send(JSON.stringify(payload));
  appendLog({level:'mark', content:`[发送] ${method} -> ${cmd}`});
  cmdInput.value='';
}

// ---------------- 初始化 ----------------
window.addEventListener('DOMContentLoaded', ()=>{
  loadHistoryLogs().then(connectWS);
  cmdInput.addEventListener('keydown', e=>{ if(e.key==='Enter') sendCommand(); });
  document.getElementById('sendBtn').addEventListener('click', sendCommand);
  document.getElementById('openPreviewBtn').addEventListener('click', ()=>{
    const contentArr = logs.map(l=>l?.content || '');
    showLongText(contentArr.join('\n'));
  });
});

// ---------------- 历史日志 ----------------
async function loadHistoryLogs(){
  try{
    const res = await fetch('/history', { headers:{ 'Authorization': 'Bearer '+token } });
    if(res.status === 401 || res.status === 403) return redirectLogin();
    const historyLogs = await res.json();
    historyLogs.slice(-MAX_LOG_LINES).forEach(l=> appendLog({
      id: l.id,
      level: l.level,
      timestamp: l.timestamp,
      content: l.content
    }));
  } catch(err){
    appendLog({level:'error', content:'[系统] 获取历史日志失败: '+err.message});
  }
}
