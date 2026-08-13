const { app, BrowserWindow, ipcMain, desktopCapturer, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess;
let tray = null;

const isHostMode = process.argv.includes('--host');

function startPythonServer() {
  const scriptPath = path.join(__dirname, 'input_server.py');
  pythonProcess = spawn('python', [scriptPath]);
  
  pythonProcess.stderr.on('data', (data) => {
    console.error(`Python Error: ${data}`);
  });
}

function getOrGeneratePermanentId() {
  const desktopPath = path.join(os.homedir(), 'Desktop');
  const idFilePath = path.join(desktopPath, 'My_Remote_ID.txt');
  
  if (fs.existsSync(idFilePath)) {
    return fs.readFileSync(idFilePath, 'utf8').trim();
  }
  
  // Generate a 9-digit random ID
  const newId = Math.floor(100000000 + Math.random() * 900000000).toString();
  fs.writeFileSync(idFilePath, newId, 'utf8');
  return newId;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    title: 'Antigravity Remote Desktop',
    show: !isHostMode // Hidden if host mode
  });

  const isDev = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;
  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  if (isHostMode) {
    startPythonServer();
    
    // Create Tray Icon (Using a default built-in icon or empty for now)
    // We'll create a simple transparent icon if one doesn't exist, or just use app icon
    // For now, we'll try to use the executable's icon
    let icon;
    try {
      const iconPath = path.join(__dirname, '../public/vite.svg');
      // Windows doesn't always support SVG tray icons natively, so this might fail.
      icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) throw new Error('Icon empty');
    } catch (err) {
      // Create a fallback blank icon 16x16
      icon = nativeImage.createEmpty();
    }
    
    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Host is Running (Hidden)', enabled: false },
      { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
    ]);
    tray.setToolTip('Antigravity Remote Desktop (Host)');
    tray.setContextMenu(contextMenu);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.stdin.write("QUIT\n");
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Provide mode and ID to the frontend
ipcMain.handle('GET_MODE', () => {
  return isHostMode ? 'host' : 'viewer';
});

ipcMain.handle('GET_PERMANENT_ID', () => {
  return getOrGeneratePermanentId();
});

// IPC Handlers for Screen Sources
ipcMain.handle('GET_SOURCES', async () => {
  return await desktopCapturer.getSources({ types: ['window', 'screen'] });
});

// Helper to send command to Python
function sendToPython(cmdObj) {
  if (pythonProcess && !pythonProcess.killed) {
    pythonProcess.stdin.write(JSON.stringify(cmdObj) + "\n");
  }
}

// IPC Handlers for Remote Control
ipcMain.on('MOUSE_MOVE', (event, { x, y }) => {
  sendToPython({ type: "mousemove", x: Math.round(x), y: Math.round(y) });
});

ipcMain.on('MOUSE_DOWN', (event, { button }) => {
  sendToPython({ type: "mousedown", button });
});

ipcMain.on('MOUSE_UP', (event, { button }) => {
  sendToPython({ type: "mouseup", button });
});

ipcMain.on('KEY_DOWN', (event, { key }) => {
  sendToPython({ type: "keydown", key });
});

ipcMain.on('KEY_UP', (event, { key }) => {
  sendToPython({ type: "keyup", key });
});
