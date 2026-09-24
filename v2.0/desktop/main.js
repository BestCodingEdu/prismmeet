const { app, BrowserWindow, session, desktopCapturer, protocol, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// ---- 用户数据目录 ----
// 需求：每次重新下载 / 升级客户端都不得复用旧的用户数据 —— 目录必须是全新的，用户必须重新登录。
// 做法：打包时生成 build-info.json（见 build/gen-build-info.mjs），打包版按「构建 ID」
//       使用独立子目录 %APPDATA%\prismmeet-desktop\builds\<buildId>。构建 ID 一变目录就变，
//       登录态(localStorage 的 pm_token)自然不在新目录里，必须重新登录。
//       启动时顺带删除其它构建的残留目录，以及 2.0.0 及更早版本直接写在根目录下的旧数据。
// 源码运行(未打包)不启用，否则开发时每次重开都要重新登录；
// PM_USER_DATA 仍是最高优先级（自动化测试靠它跑多实例并存）。
function readBuildId() {
  try {
    const id = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')).buildId;
    if (typeof id === 'string' && /^[\w.+-]+$/.test(id)) return id;   // 防路径穿越
  } catch {}
  return null;
}
function setupUserData() {
  if (process.env.PM_USER_DATA) { app.setPath('userData', process.env.PM_USER_DATA); return; }
  if (!app.isPackaged) return;                      // 源码运行：沿用默认目录
  const buildId = readBuildId();
  if (!buildId) return;                             // 无构建信息：退回默认行为，不冒险
  const root = path.join(app.getPath('appData'), 'prismmeet-desktop');
  const buildsDir = path.join(root, 'builds');
  const dir = path.join(buildsDir, buildId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    app.setPath('userData', dir);
  } catch { return; }
  // 清掉其它构建的残留目录（删不掉就算了，下次启动再试）
  try {
    for (const name of fs.readdirSync(buildsDir)) {
      if (name !== buildId) fs.rmSync(path.join(buildsDir, name), { recursive: true, force: true });
    }
  } catch {}
  // 清掉 2.0.0 及更早版本直接写在 prismmeet-desktop 根目录下的旧数据(Local Storage / Cache / ...)
  try {
    for (const name of fs.readdirSync(root)) {
      if (name !== 'builds') fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch {}
}
setupUserData();

// ---- config ----
const DEV = process.env.PM_DEV === '1' || !app.isPackaged; // controls devtools/logging only
// Always talk to the PRODUCTION backend — running from source and the packaged binary
// share the same server & data. Override with PM_API_BASE only for automated tests.
const API_BASE = process.env.PM_API_BASE || 'https://meeting.prismglory.org/pmapi';
const PUBLIC_DIR = app.isPackaged ? path.join(process.resourcesPath, 'public') : path.join(__dirname, '..', 'server', 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

if (process.env.PM_TEST_FAKE === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream'); // auto-accepts getDisplayMedia (bypasses custom picker)
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
}
// fake DEVICES only (no fake UI) -> getDisplayMedia still goes through our custom picker
if (process.env.PM_TEST_FAKEDEV === '1') {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow = null;
let pendingDeepLink = null;

function resolveSafe(urlPath) {
  // map app://local/<path> to a file inside PUBLIC_DIR, prevent traversal
  let p = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  if (p === '' ) p = 'index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, p));
  if (!full.startsWith(path.normalize(PUBLIC_DIR))) return null;
  return full;
}

function registerAppProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url); // app://local/...
    let file = resolveSafe(url.pathname);
    if (!file) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // SPA-ish fallback: missing file -> index.html
      file = path.join(PUBLIC_DIR, 'index.html');
    }
    const ext = path.extname(file).toLowerCase();
    const data = fs.readFileSync(file);
    return new Response(data, { headers: { 'content-type': MIME[ext] || 'application/octet-stream' } });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180, height: 760, minWidth: 900, minHeight: 600,
    backgroundColor: '#18191c',
    title: `PrismMeet 棱镜会议 v${app.getVersion()}`,
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--pm-api=${API_BASE}`],
    },
  });
  mainWindow.loadURL('app://local/index.html');
  if (DEV) mainWindow.webContents.on('before-input-event', (e, input) => {
    if (input.key === 'F12') mainWindow.webContents.toggleDevTools();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    // 从会议页 location.href='/' 退回首页后，Electron 的 webContents 会丢失【OS 级键盘焦点】，
    // 导致首页「会议号」输入框点了也没光标、无法输入。单纯 webContents.focus() 不够（窗口一直在前台、
    // 'focus' 事件不会再触发）。这里强制做一次 blur→focus 焦点循环，重建 OS→webContents 的键盘路由。
    const reclaimFocus = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try { mainWindow.blur(); mainWindow.focus(); mainWindow.webContents.focus(); } catch {}
    };
    reclaimFocus();
    setTimeout(reclaimFocus, 80); // 渲染稳定后再压一次，兜底
    if (pendingDeepLink) { navigateToMeeting(pendingDeepLink); pendingDeepLink = null; }
  });
  // 窗口重新获得系统焦点时，也把键盘焦点压回网页内容（兜底）
  mainWindow.on('focus', () => { try { mainWindow.webContents.focus(); } catch {} });
}

function navigateToMeeting(meetingId) {
  if (!mainWindow) return;
  mainWindow.loadURL(`app://local/meeting.html?id=${encodeURIComponent(meetingId)}`);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function parseDeepLink(url) {
  // prismmeet://join/<id>  OR prismmeet://<id>
  try {
    const m = url.match(/prismmeet:\/\/(?:join\/)?(\d{6,12})/i);
    return m ? m[1] : null;
  } catch { return null; }
}

// ---- screen share: provide a source picker ----
function setupDisplayMedia() {
  // grant camera/microphone permissions for our own app
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
    cb(['media', 'audioCapture', 'videoCapture', 'display-capture'].includes(perm) ? true : true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  // Fallback handler (used only if getDisplayMedia is ever called directly, e.g. in browser-in-electron).
  // The normal flow is renderer -> pm:pickSource (IPC) -> getUserMedia(desktop) below.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback(sources[0] ? { video: sources[0] } : null);
    } catch { callback(null); }
  }, { useSystemPicker: false });
}

// Renderer asks us to choose a screen/window; returns { id, audio } or null (canceled).
ipcMain.handle('pm:pickSource', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } });
  if (process.env.PM_TEST_AUTOPICK === '1') {
    const s = sources.find(x => x.id.startsWith('screen')) || sources[0];
    return s ? { id: s.id, audio: false } : null;
  }
  return await showPicker(sources); // { id, audio } | null
});

let pickerWin = null;
function showPicker(sources) {
  return new Promise((resolve) => {
    pickerWin = new BrowserWindow({
      width: 760, height: 580, minWidth: 520, minHeight: 460, parent: mainWindow, modal: true, show: false,
      title: '选择共享内容', autoHideMenuBar: true, backgroundColor: '#232427', resizable: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    pickerWin.loadFile(path.join(__dirname, 'picker.html'));
    const payload = sources.map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
    pickerWin.webContents.on('did-finish-load', () => {
      pickerWin.webContents.send('picker:sources', payload);
      pickerWin.show();
    });
    const onPick = (_e, payload) => { cleanup(); resolve(payload); }; // payload = {id, audio} or null
    const cleanup = () => {
      ipcMain.removeListener('picker:choose', onPick);
      if (pickerWin && !pickerWin.isDestroyed()) pickerWin.close();
      pickerWin = null;
    };
    ipcMain.once('picker:choose', onPick);
    pickerWin.on('closed', () => { ipcMain.removeListener('picker:choose', onPick); resolve(null); });
  });
}

// expose API base to renderer on request
ipcMain.handle('pm:getConfig', () => ({ apiBase: API_BASE, version: app.getVersion() }));

// ---- single instance + deep link ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find(a => a.startsWith('prismmeet://'));
    const id = url && parseDeepLink(url);
    if (id) navigateToMeeting(id);
    else if (mainWindow) { mainWindow.restore(); mainWindow.focus(); }
  });
  app.on('open-url', (e, url) => { // macOS
    e.preventDefault();
    const id = parseDeepLink(url);
    if (id) { if (mainWindow) navigateToMeeting(id); else pendingDeepLink = id; }
  });

  app.whenReady().then(() => {
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('prismmeet', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('prismmeet');
    }
    registerAppProtocol();
    setupDisplayMedia();
    // capture deep link passed at first launch (Windows)
    const url = process.argv.find(a => a.startsWith('prismmeet://'));
    if (url) pendingDeepLink = parseDeepLink(url);
    createWindow();
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
}
