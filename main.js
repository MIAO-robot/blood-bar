const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// douyinLive 子进程
let douyinLiveProcess = null;

function getDouyinLivePath() {
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  const exe = process.platform === 'win32' ? 'douyinLive.exe' : 'douyinLive';
  return path.join(base, 'bin', exe);
}

function startDouyinLive() {
  const exePath = getDouyinLivePath();
  if (!fs.existsSync(exePath)) {
    console.log('[douyinLive] 未找到程序文件:', exePath);
    return;
  }
  try {
    douyinLiveProcess = spawn(exePath, [], { detached: false, stdio: 'ignore' });
    douyinLiveProcess.on('error', (e) => console.error('[douyinLive] 启动失败:', e.message));
    douyinLiveProcess.unref();
    console.log('[douyinLive] 服务已自动启动');
  } catch (e) {
    console.error('[douyinLive] 启动异常:', e.message);
  }
}

function stopDouyinLive() {
  if (douyinLiveProcess) { try { douyinLiveProcess.kill(); } catch (e) {} douyinLiveProcess = null; }
}

// 配置
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadDefaultImage(filename) {
  try {
    const imgPath = path.join(__dirname, 'assets', filename);
    if (fs.existsSync(imgPath)) {
      const data = fs.readFileSync(imgPath);
      const ext = path.extname(filename).toLowerCase().replace('.', '');
      const mimeMap = { png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',webp:'image/webp' };
      return `data:${(mimeMap[ext]||'image/png')};base64,${data.toString('base64')}`;
    }
  } catch(e){}
  return '';
}

const defaultOuterImage = loadDefaultImage('default-outer.png');
const defaultInnerImage = loadDefaultImage('default-inner.png');

const defaultConfig = {
  cookie:'', roomId:'', wsPort:1088,
  maxHp:100, currentHp:100,
  gifts:[
    {id:'',name:'',hpChange:0,type:'heal'},{id:'',name:'',hpChange:0,type:'heal'},
    {id:'',name:'',hpChange:0,type:'heal'},{id:'',name:'',hpChange:0,type:'heal'},
    {id:'',name:'',hpChange:0,type:'damage'},{id:'',name:'',hpChange:0,type:'damage'},
    {id:'',name:'',hpChange:0,type:'damage'},{id:'',name:'',hpChange:0,type:'damage'}
  ],
  barInnerImage:defaultInnerImage, barOuterImage:defaultOuterImage,
  barWidth:400, barHeight:60, outerFrameWidth:3,
  windowWidth:420, windowHeight:80, windowX:null, windowY:null
};

let mainWindow=null, wsClient=null, config=null, ctxMenuWin=null;

// ====== 独立右键菜单窗口 ======
function ctxMenuHTML(){
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{margin:0;font-family:'Microsoft YaHei',sans-serif;background:transparent;overflow:hidden;user-select:none;}
    .menu{background:#252535;border:1px solid #444;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.6);padding:4px;min-width:170px;}
    .item{padding:8px 16px;font-size:13px;color:#e0e0e0;border-radius:5px;cursor:pointer;}
    .item:hover{background:#ff6b6b;color:#fff;}
    .item.danger:hover{background:#c0392b;}
    .sep{height:1px;background:#3a3a4a;margin:4px 8px;}
  </style></head><body>
  <div class="menu">
    <div class="item" onclick="act('config')">⚙️ 配置面板</div>
    <div class="sep"></div>
    <div class="item" onclick="act('connect')">🔗 连接直播间</div>
    <div class="sep"></div>
    <div class="item" onclick="act('reset')">🔄 重置血条</div>
    <div class="sep"></div>
    <div class="item danger" onclick="act('quit')">❌ 退出程序</div>
  </div>
  <script>const {ipcRenderer}=require('electron');function act(a){ipcRenderer.send('ctx-action',a);}document.addEventListener('contextmenu',e=>e.preventDefault());<\/script>
  </body></html>`;
}

function showContextMenu(screenX, screenY){
  try{ if(ctxMenuWin){ctxMenuWin.close();} }catch(e){}
  ctxMenuWin=new BrowserWindow({
    x:Math.round(screenX), y:Math.round(screenY),
    width:180, height:188,
    frame:false, transparent:true, alwaysOnTop:true, skipTaskbar:true, resizable:false,
    hasShadow:false,
    webPreferences:{ nodeIntegration:true, contextIsolation:false }
  });
  ctxMenuWin.loadURL('data:text/html,'+encodeURIComponent(ctxMenuHTML()));
  ctxMenuWin.on('blur',()=>{ try{ctxMenuWin.close();}catch(e){} ctxMenuWin=null; });
  ctxMenuWin.webContents.on('ipc-message',(event,channel)=>{
    if(channel==='ctx-action'){
      const action=event.args[0];
      try{ctxMenuWin.close();}catch(e){} ctxMenuWin=null;
      handleCtxAction(action);
    }
  });
}

function handleCtxAction(action){
  switch(action){
    case 'config': mainWindow.webContents.send('open-config'); break;
    case 'connect': mainWindow.webContents.send('open-config','connection'); break;
    case 'reset':
      config.currentHp=config.maxHp; saveConfig();
      mainWindow.webContents.send('update-hp',config.currentHp,config.maxHp);
      break;
    case 'quit': stopDouyinLive(); app.quit(); break;
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) config={...defaultConfig,...JSON.parse(fs.readFileSync(configPath,'utf-8'))};
    else { config={...defaultConfig}; saveConfig(); }
  } catch(e){ config={...defaultConfig}; saveConfig(); }
}
function saveConfig(){ try{ fs.writeFileSync(configPath,JSON.stringify(config,null,2),'utf-8'); }catch(e){console.error('保存配置失败:',e);} }

function createWindow() {
  const {width,height}=screen.getPrimaryDisplay().workAreaSize;
  const bw=config.barWidth||400, bh=config.barHeight||60;
  
  mainWindow=new BrowserWindow({
    width:bw+20, height:bh+20,
    x:config.windowX||Math.round((width-bw)/2), y:config.windowY||Math.round((height-bh)/2),
    frame:false, transparent:true, alwaysOnTop:true, resizable:true, skipTaskbar:true,
    hasShadow:false,
    webPreferences:{ nodeIntegration:true, contextIsolation:false },
    icon:path.join(__dirname,'assets','icon.png')
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('move',()=>{ [config.windowX,config.windowY]=mainWindow.getPosition();saveConfig();});
  mainWindow.on('resize',()=>{
    const[w,h]=mainWindow.getSize();
    config.windowWidth=w; config.windowHeight=h;
    // 同步更新barWidth/barHeight（减去padding）
    config.barWidth=Math.max(120,w-20);
    config.barHeight=Math.max(30,h-20);
    // 通知渲染进程更新内条尺寸
    mainWindow.webContents.send('window-resized',w,h);
    saveConfig();
  });

  mainWindow.setAlwaysOnTop(true,'screen-saver');

  // ★ Windows 系统级拦截右键菜单
  // 同时钩 WM_CONTEXTMENU(0x7B) 和 WM_NCRBUTTONUP(0xA5) —— 系统菜单真正由后者触发
  // 任意一条命中即弹自定义菜单并 return true 阻止系统默认菜单；用去重避免重复
  if (process.platform === 'win32' && typeof mainWindow.hookWindowMessage === 'function') {
    let lastCtxTime = 0;
    const sendCtx = (lParam) => {
      const now = Date.now();
      if (now - lastCtxTime < 80) return; // 去重
      lastCtxTime = now;
      let sx = 0, sy = 0;
      if (lParam != null && lParam >= 0) {
        sx = lParam & 0xffff; sy = (lParam >>> 16) & 0xffff;
      } else {
        const [wx, wy] = mainWindow.getPosition();
        const [ww, wh] = mainWindow.getSize();
        sx = wx + ww / 2; sy = wy + wh / 2;
      }
      // 用屏幕坐标弹出独立菜单窗口（避免被主窗口裁剪）
      showContextMenu(sx, sy);
    };
    [0x007b, 0x00a5].forEach((code) => {
      mainWindow.hookWindowMessage(code, (wParam, lParam) => {
        sendCtx(lParam);
        return true; // 已处理，阻止系统菜单
      });
    });
  }
}

// ====== WebSocket ======
function connectToDouyinLive(){
  if(wsClient){wsClient.close();wsClient=null;}
  if(!config.roomId)return;
  const wsUrl=`ws://127.0.0.1:${config.wsPort}/ws/${config.roomId}`+(config.cookie?`?cookie=${encodeURIComponent(config.cookie)}`:'');
  console.log('连接 douyinLive:',wsUrl.replace(/cookie=[^&]+/,'cookie=***'));
  try{
    wsClient=new WebSocket(wsUrl);
    wsClient.on('open',()=>{console.log('已连接');mainWindow.webContents.send('connection-status',true);});
    wsClient.on('message',(data)=>{
      try{const msg=JSON.parse(data.toString());if(msg.method==='WebcastGiftMessage')handleGiftMessage(msg);}catch(e){}
    });
    wsClient.on('error',(err)=>{console.error('WS错误:',err.message);mainWindow.webContents.send('connection-status',false);});
    wsClient.on('close',()=>{console.log('WS断开');mainWindow.webContents.send('connection-status',false);setTimeout(()=>{if(config.roomId)connectToDouyinLive();},5000);});
  }catch(e){console.error('连接失败:',e);}
}

function handleGiftMessage(msg){
  const giftId=String(msg.gift?.id||msg.gift?.gift_id||'');
  const giftName=msg.gift?.name||msg.gift?.gift_name||'';
  const repeatCount=msg.repeat_count||msg.gift?.repeat_count||msg.combo||1;
  const repeatEnd=msg.repeat_end||msg.gift?.repeat_end;
  if(repeatEnd!==undefined&&repeatEnd===0&&repeatCount>1)return;
  
  const giftConfig=config.gifts.find(g=>g.id===giftId&&g.id!=='');
  if(giftConfig){
    const totalChange=giftConfig.hpChange*repeatCount;
    const newHp=Math.max(0,Math.min(config.maxHp,config.currentHp+totalChange));
    config.currentHp=newHp; saveConfig();
    mainWindow.webContents.send('gift-received',{giftName,giftId,hpChange:totalChange,newHp,maxHp:config.maxHp,type:giftConfig.type,repeatCount});
  }
}

// ====== IPC ======
ipcMain.handle('get-config',()=>config);

ipcMain.handle('save-config',(event,newConfig)=>{
  config={...config,...newConfig};saveConfig();
  if(newConfig.roomId!==undefined||newConfig.wsPort!==undefined)connectToDouyinLive();
  return config;
});

ipcMain.handle('persist-config',(event,partial)=>{
  config={...config,...partial};saveConfig();return config;
});

ipcMain.handle('reset-hp',()=>{config.currentHp=config.maxHp;saveConfig();return config;});

ipcMain.handle('select-image',async ()=>{
  const result=await dialog.showOpenDialog(mainWindow,{properties:['openFile'],filters:[{name:'图片文件',extensions:['png','jpg','jpeg','gif','bmp','webp']}]});
  if(!result.canceled&&result.filePaths.length>0){
    const imgData=fs.readFileSync(result.filePaths[0]);
    const ext=path.extname(result.filePaths[0]).toLowerCase().replace('.','');
    const mimeMap={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',webp:'image/webp'};
    return `data:${(mimeMap[ext]||'image/png')};base64,${imgData.toString('base64')}`;
  }
  return null;
});

ipcMain.on('app-quit',()=>{stopDouyinLive();app.quit();});

// 手动拖拽窗口
ipcMain.on('drag-window',(event,dx,dy)=>{
  if(mainWindow&&!mainWindow.isDestroyed()){
    const [x,y]=mainWindow.getPosition();
    mainWindow.setPosition(x+dx,y+dy);
  }
});

ipcMain.on('resize-window',(event,w,h)=>{
  if(mainWindow&&!mainWindow.isDestroyed()){
    mainWindow.setSize(Math.round(w+20),Math.round(h+20));
    config.barWidth=w;config.barHeight=h;saveConfig();
  }
});

// 启动
app.whenReady().then(()=>{loadConfig();startDouyinLive();createWindow();setTimeout(()=>connectToDouyinLive(),2000);});
app.on('window-all-closed',()=>{if(wsClient)wsClient.close();stopDouyinLive();app.quit();});
app.on('before-quit',()=>{if(wsClient)wsClient.close();stopDouyinLive();});
