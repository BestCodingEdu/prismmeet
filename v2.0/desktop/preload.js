const { contextBridge, ipcRenderer } = require('electron');

// API base passed via additionalArguments (--pm-api=...)
const apiArg = process.argv.find(a => a.startsWith('--pm-api='));
const apiBase = apiArg ? apiArg.slice('--pm-api='.length) : '';

// Expose to the meeting UI (read by api.js)
contextBridge.exposeInMainWorld('PM_API_BASE', apiBase);
contextBridge.exposeInMainWorld('PM_ELECTRON', true);

// Desktop helpers (screen-share picker IPC, config)
contextBridge.exposeInMainWorld('PM_DESKTOP', {
  getConfig: () => ipcRenderer.invoke('pm:getConfig'),
  // show the source picker and resolve to { id, audio } (or null if canceled)
  pickSource: () => ipcRenderer.invoke('pm:pickSource'),
  // picker window API (used inside picker.html)
  onSources: (cb) => ipcRenderer.on('picker:sources', (_e, list) => cb(list)),
  choose: (id) => ipcRenderer.send('picker:choose', id),
});
