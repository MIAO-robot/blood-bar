const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, screen, nativeImage } = require('electron');
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
  if (!fs.existsSync(exePath)) { console.log('[douyinLive] 未找到:', exePath); return; }
  try {
    douyinLiveProcess = spawn(exePath, [], { detached: false, stdio: 'ignore' });
    douyinLiveProcess.on('error', (e) => console.error('[douyinLive] 启动失败:', e.message));
    douyinLiveProcess.unref();
    console.log('[douyinLive] 服务已自动启动');
  } catch(e){ console.error('[douyinLive] 启动异常:', e.message); }
}
function stopDouyinLive() { if(douyinLiveProcess){ try{douyinLiveProcess.kill();}catch(e){} douyinLiveProcess=null; } }

const configPath = path.join(app.getPath('userData'), 'config.json');

function loadDefaultImage(filename) {
  try {
    const imgPath = path.join(__dirname, 'assets', filename);
    if (fs.existsSync(imgPath)) {
      const data = fs.readFileSync(imgPath);
      const ext = path.extname(filename).toLowerCase().replace('.','');
      const mm = { png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',webp:'image/webp' };
      return `data:${(mm[ext]||'image/png')};base64,${data.toString('base64')}`;
    }
  } catch(e){}
  return '';
}

const defaultOuterImage = loadDefaultImage('default-outer.png');
const defaultInnerImage = loadDefaultImage('default-inner.png');

const defaultConfig = {
  cookie:'', roomId:'', wsPort:1088, maxHp:100, currentHp:100,
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

let mainWindow=null, wsClient=null, config=null, tray=null;

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) config={...defaultConfig,...JSON.parse(fs.readFileSync(configPath,'utf-8'))};
    else { config={...defaultConfig}; saveConfig(); }
  } catch(e){ config={...defaultConfig}; saveConfig(); }
}
function saveConfig(){ try{ fs.writeFileSync(configPath,JSON.stringify(config,null,2),'utf-8'); }catch(e){console.error('保存失败:',e);} }

function createWindow() {
  const {width,height}=screen.getPrimaryDisplay().workAreaSize;
  const bw=config.barWidth||400, bh=config.barHeight||60;
  
  mainWindow=new BrowserWindow({
    width:bw+20, height:bh+20,
    x:config.windowX||Math.round((width-bw)/2), y:config.windowY||Math.round((height-bh)/2),
    frame:false, transparent:true, alwaysOnTop:true, resizable:true, skipTaskbar:true,
    webPreferences:{ nodeIntegration:true, contextIsolation:false },
    icon:path.join(__dirname,'assets','icon.png')
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('move',()=>{ [config.windowX,config.windowY]=mainWindow.getPosition();saveConfig();});
  mainWindow.on('resize',()=>{
    const[w,h]=mainWindow.getSize();
    config.windowWidth=w; config.windowHeight=h;
    config.barWidth=Math.max(120,w-20); config.barHeight=Math.max(30,h-20);
    mainWindow.webContents.send('window-resized',w,h);
    saveConfig();
  });
  mainWindow.setAlwaysOnTop(true,'screen-saver');
}

// ====== 系统托盘 ======
function createTray() {
  try {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    let trayIcon;
    if (fs.existsSync(iconPath)) {
      trayIcon = nativeImage.createFromPath(iconPath);
      // 缩小到托盘合适尺寸（16x16 或 24x24）
      trayIcon = trayIcon.resize({ width: 16, height: 16 });
    }
    tray = new Tray(trayIcon || nativeImage.createEmpty());

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '⚙️ 配置面板',
        click: () => openConfigWindow()
      },
      { type: 'separator' },
      {
        label: '🔗 连接直播间',
        click: () => openConfigWindow('connection')
      },
      { type: 'separator' },
      {
        label: '🔄 重置血条',
        click: () => {
          config.currentHp = config.maxHp; saveConfig();
          if(mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-hp', config.currentHp, config.maxHp);
        }
      },
      { type: 'separator' },
      {
        label: '❌ 退出程序',
        click: () => { stopDouyinLive(); app.quit(); }
      }
    ]);

    tray.setToolTip('抖音血条插件');
    tray.setContextMenu(contextMenu);

    // 左键双击显示/隐藏窗口
    tray.on('double-click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isVisible()) mainWindow.hide(); else mainWindow.show();
      }
    });

    console.log('系统托盘已创建');
  } catch(e) {
    console.error('创建托盘失败:', e.message);
  }
}

// ====== 独立配置窗口 ======
let configWindow = null;

function openConfigWindow(section) {
  // 如果已有配置窗口，直接激活
  try { if (configWindow) { configWindow.focus(); return; } } catch(e) { configWindow = null; }

  configWindow = new BrowserWindow({
    width: 660, height: 740,
    resizable: true, title: '血条插件配置',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  const query = { mode: 'config' };
  if (section === 'connection') query.section = 'connection';
  configWindow.loadFile('index.html', { query });
  configWindow.on('closed', () => { configWindow = null; });
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
ipcMain.handle('save-config',(event,newConfig)=>{config={...config,...newConfig};saveConfig();if(newConfig.roomId!==undefined||newConfig.wsPort!==undefined)connectToDouyinLive();return config;});
ipcMain.handle('persist-config',(event,partial)=>{config={...config,...partial};saveConfig();return config;});
ipcMain.handle('reset-hp',()=>{config.currentHp=config.maxHp;saveConfig();return config;});
ipcMain.handle('select-image',async ()=>{
  const result=await dialog.showOpenDialog(mainWindow,{properties:['openFile'],filters:[{name:'图片文件',extensions:['png','jpg','jpeg','gif','bmp','webp']}]});
  if(!result.canceled&&result.filePaths.length>0){
    const imgData=fs.readFileSync(result.filePaths[0]);
    const ext=path.extname(result.filePaths[0]).toLowerCase().replace('.','');
    const mm={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',bmp:'image/bmp',webp:'image/webp'};
    return `data:${(mm[ext]||'image/png')};base64,${imgData.toString('base64')}`;
  }
  return null;
});

// 手动拖拽窗口
ipcMain.on('drag-window',(event,dx,dy)=>{
  if(mainWindow&&!mainWindow.isDestroyed()){
    const[x,y]=mainWindow.getPosition();
    mainWindow.setPosition(x+dx,y+dy);
  }
});

// 启动
app.whenReady().then(()=>{loadConfig();startDouyinLive();createWindow();createTray();setTimeout(()=>connectToDouyinLive(),2000);});
app.on('window-all-closed',()=>{if(wsClient)wsClient.close();stopDouyinLive();app.quit();});
app.on('before-quit',()=>{if(wsClient)wsClient.close();stopDouyinLive();});
