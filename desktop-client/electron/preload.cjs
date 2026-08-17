const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSources: () => ipcRenderer.invoke('GET_SOURCES'),
  getMode: () => ipcRenderer.invoke('GET_MODE'),
  getPermanentId: () => ipcRenderer.invoke('GET_PERMANENT_ID'),
  mouseMove: (x, y) => ipcRenderer.send('MOUSE_MOVE', { x, y }),
  mouseDown: (button) => ipcRenderer.send('MOUSE_DOWN', { button }),
  mouseUp: (button) => ipcRenderer.send('MOUSE_UP', { button }),
  keyDown: (key) => ipcRenderer.send('KEY_DOWN', { key }),
  keyUp: (key) => ipcRenderer.send('KEY_UP', { key }),
  scrollWheel: (deltaX, deltaY) => ipcRenderer.send('SCROLL_WHEEL', { deltaX, deltaY }),
  specialKey: (command) => ipcRenderer.send('SPECIAL_KEY', { command }),
  onControlStateChanged: (callback) => ipcRenderer.on('CONTROL_STATE_CHANGED', (_event, value) => callback(value)),
});
