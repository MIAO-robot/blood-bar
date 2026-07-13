const { app, BrowserWindow, ipcMain, Tray, Menu, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// douyinLive 子进程
let douyinLiveProcess = null;

// 获取 douyinLive 可执行文件路径（开发态与打包态不同）
function getDouyinLivePath() {
  const base = app.isPackaged ? process.resourcesPath : __dirname;
  const exe = process.platform === 'win32' ? 'douyinLive.exe' : 'douyinLive';
  return path.join(base, 'bin', exe);
}

// 自动启动 douyinLive 服务
function startDouyinLive() {
  const exePath = getDouyinLivePath();
  if (!fs.existsSync(exePath)) {
    console.log('[douyinLive] 未找到程序文件:', exePath, '(将仅尝试连接已手动启动的服务)');
    return;
  }
  try {
    douyinLiveProcess = spawn(exePath, [], {
      detached: false,
      stdio: 'ignore'
    });
    douyinLiveProcess.on('error', (e) => console.error('[douyinLive] 启动失败:', e.message));
    douyinLiveProcess.unref();
    console.log('[douyinLive] 服务已自动启动');
  } catch (e) {
    console.error('[douyinLive] 启动异常:', e.message);
  }
}

function stopDouyinLive() {
  if (douyinLiveProcess) {
    try { douyinLiveProcess.kill(); } catch (e) {}
    douyinLiveProcess = null;
    console.log('[douyinLive] 服务已停止');
  }
}

// 配置文件路径
const configPath = path.join(app.getPath('userData'), 'config.json');
// 加载默认图片
function loadDefaultImage(filename) {
  try {
    const imgPath = path.join(__dirname, 'assets', filename);
    if (fs.existsSync(imgPath)) {
      const data = fs.readFileSync(imgPath);
      const ext = path.extname(filename).toLowerCase().replace('.', '');
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
      const mime = mimeMap[ext] || 'image/png';
      return `data:${mime};base64,${data.toString('base64')}`;
    }
  } catch (e) { /* ignore */ }
  return '';
}

const defaultOuterImage = loadDefaultImage('default-outer.png');
const defaultInnerImage = loadDefaultImage('default-inner.png');

const defaultConfig = {
  cookie: '',
  roomId: '',
  wsPort: 1088,
  maxHp: 100,
  currentHp: 100,
  gifts: [
    { id: '', name: '', hpChange: 0, type: 'heal' },
    { id: '', name: '', hpChange: 0, type: 'heal' },
    { id: '', name: '', hpChange: 0, type: 'heal' },
    { id: '', name: '', hpChange: 0, type: 'heal' },
    { id: '', name: '', hpChange: 0, type: 'damage' },
    { id: '', name: '', hpChange: 0, type: 'damage' },
    { id: '', name: '', hpChange: 0, type: 'damage' },
    { id: '', name: '', hpChange: 0, type: 'damage' }
  ],
  barInnerImage: defaultInnerImage,
  barOuterImage: defaultOuterImage,
  barWidth: 400,
  barHeight: 60,
  outerFrameWidth: 3,
  innerBarHeight: 40,
  windowWidth: 420,
  windowHeight: 80,
  windowX: null,
  windowY: null
};

let mainWindow = null;
let wsClient = null;
let config = null;
let tray = null;

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      config = { ...defaultConfig, ...JSON.parse(data) };
    } else {
      config = { ...defaultConfig };
      saveConfig();
    }
  } catch (e) {
    config = { ...defaultConfig };
    saveConfig();
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    console.error('保存配置失败:', e);
  }
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  const bw = config.barWidth || 400;
  const bh = config.barHeight || 60;
  
  mainWindow = new BrowserWindow({
    width: bw + 20,
    height: bh + 20,
    x: config.windowX || Math.round((width - bw) / 2),
    y: config.windowY || Math.round((height - bh) / 2),
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });

  mainWindow.loadFile('index.html');
  
  // 保存窗口位置
  mainWindow.on('move', () => {
    const [x, y] = mainWindow.getPosition();
    config.windowX = x;
    config.windowY = y;
    saveConfig();
  });

  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    config.windowWidth = w;
    config.windowHeight = h;
    saveConfig();
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

// WebSocket 连接 douyinLive 服务
function connectToDouyinLive() {
  if (wsClient) {
    wsClient.close();
    wsClient = null;
  }

  if (!config.roomId) {
    console.log('未设置房间号，跳过连接');
    return;
  }

  const wsUrl = `ws://127.0.0.1:${config.wsPort}/ws/${config.roomId}` + 
    (config.cookie ? `?cookie=${encodeURIComponent(config.cookie)}` : '');
  console.log('连接 douyinLive:', wsUrl.replace(/cookie=[^&]+/, 'cookie=***'));
  
  try {
    wsClient = new WebSocket(wsUrl);
    
    wsClient.on('open', () => {
      console.log('已连接到 douyinLive 服务');
      mainWindow.webContents.send('connection-status', true);
    });

    wsClient.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'WebcastGiftMessage') {
          handleGiftMessage(msg);
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    wsClient.on('error', (err) => {
      console.error('WebSocket 错误:', err.message);
      mainWindow.webContents.send('connection-status', false);
    });

    wsClient.on('close', () => {
      console.log('WebSocket 已断开');
      mainWindow.webContents.send('connection-status', false);
      // 5秒后自动重连
      setTimeout(() => {
        if (config.roomId) {
          connectToDouyinLive();
        }
      }, 5000);
    });
  } catch (e) {
    console.error('连接失败:', e);
  }
}

function handleGiftMessage(msg) {
  const giftId = String(msg.gift?.id || msg.gift?.gift_id || '');
  const giftName = msg.gift?.name || msg.gift?.gift_name || '';
  const repeatCount = msg.repeat_count || msg.gift?.repeat_count || msg.combo || 1;
  const repeatEnd = msg.repeat_end || msg.gift?.repeat_end;
  
  // 只处理连击结束的消息（避免连击中间状态多次扣血）
  // 如果没有 repeat_end 字段或是连击结束，才处理
  if (repeatEnd !== undefined && repeatEnd === 0 && repeatCount > 1) {
    return; // 连击中，跳过
  }

  // 查找匹配的礼物配置
  const giftConfig = config.gifts.find(g => g.id === giftId && g.id !== '');
  
  if (giftConfig) {
    const totalChange = giftConfig.hpChange * repeatCount;
    const newHp = Math.max(0, Math.min(config.maxHp, config.currentHp + totalChange));
    config.currentHp = newHp;
    saveConfig();
    
    mainWindow.webContents.send('gift-received', {
      giftName: giftName,
      giftId: giftId,
      hpChange: totalChange,
      newHp: newHp,
      maxHp: config.maxHp,
      type: giftConfig.type,
      repeatCount: repeatCount
    });
    
    console.log(`礼物: ${giftName} x${repeatCount}, HP变化: ${totalChange > 0 ? '+' : ''}${totalChange}, 当前HP: ${newHp}/${config.maxHp}`);
  }
}

// IPC 处理
ipcMain.handle('get-config', () => {
  return config;
});

ipcMain.handle('save-config', (event, newConfig) => {
  config = { ...config, ...newConfig };
  saveConfig();
  
  // 如果房间号改变，重新连接
  if (newConfig.roomId !== undefined || newConfig.wsPort !== undefined) {
    connectToDouyinLive();
  }
  
  return config;
});

// 持久化部分配置（尺寸/外观等，不触发重连）
ipcMain.handle('persist-config', (event, partial) => {
  config = { ...config, ...partial };
  saveConfig();
  return config;
});

// 退出程序
ipcMain.on('app-quit', () => {
  stopDouyinLive();
  app.quit();
});

// 调整窗口大小（拖拽血条或数值输入触发）
ipcMain.on('resize-window', (event, w, h) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSize(Math.round(w + 20), Math.round(h + 20));
    config.barWidth = w;
    config.barHeight = h;
    saveConfig();
  }
});

ipcMain.handle('reset-hp', () => {
  config.currentHp = config.maxHp;
  saveConfig();
  return config;
});

ipcMain.handle('select-image', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '图片文件', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'] }]
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const imagePath = result.filePaths[0];
    const imageData = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).toLowerCase().replace('.', '');
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };
    const mime = mimeMap[ext] || 'image/png';
    return `data:${mime};base64,${imageData.toString('base64')}`;
  }
  return null;
});

ipcMain.handle('reconnect', () => {
  connectToDouyinLive();
  return true;
});

// 应用启动
app.whenReady().then(() => {
  loadConfig();
  startDouyinLive();   // 自动拉起 douyinLive 服务
  createWindow();
  
  // 给服务 2 秒启动时间后连接
  setTimeout(() => connectToDouyinLive(), 2000);
});

app.on('window-all-closed', () => {
  if (wsClient) wsClient.close();
  stopDouyinLive();
  app.quit();
});

app.on('before-quit', () => {
  if (wsClient) wsClient.close();
  stopDouyinLive();
});
