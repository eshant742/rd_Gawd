const { app, BrowserWindow, ipcMain, desktopCapturer, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess;
let tray = null;
let isQuiting = false;

const isHostMode = process.argv.includes('--host');

function startPythonServer() {
  const scriptPath = path.join(__dirname, 'input_server.py');
  
  // Try 'python' first, then 'python3' as fallback
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  
  try {
    // Add -u flag to ensure unbuffered I/O (zero latency)
    pythonProcess = spawn(pythonCmd, ['-u', scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    pythonProcess.stdout.on('data', (data) => {
      console.log(`Python: ${data}`);
    });
    
    pythonProcess.stderr.on('data', (data) => {
      console.error(`Python Error: ${data}`);
    });
    
    pythonProcess.on('error', (err) => {
      console.error('Failed to start Python input server:', err.message);
      console.error('Make sure Python and pyautogui are installed.');
      pythonProcess = null;
    });
    
    pythonProcess.on('exit', (code, signal) => {
      console.log(`Python process exited with code ${code}, signal ${signal}`);
      pythonProcess = null;
    });
  } catch (err) {
    console.error('Failed to spawn Python process:', err);
    pythonProcess = null;
  }
}

function getOrGeneratePermanentId() {
  const desktopPath = path.join(os.homedir(), 'Desktop');
  const idFilePath = path.join(desktopPath, 'My_Remote_ID.txt');
  
  try {
    if (fs.existsSync(idFilePath)) {
      const existingId = fs.readFileSync(idFilePath, 'utf8').trim();
      if (existingId && /^\d{9}$/.test(existingId)) {
        return existingId;
      }
    }
  } catch (err) {
    console.error('Error reading ID file:', err);
  }
  
  // Generate a 9-digit random ID
  const newId = Math.floor(100000000 + Math.random() * 900000000).toString();
  try {
    fs.writeFileSync(idFilePath, newId, 'utf8');
  } catch (err) {
    console.error('Error writing ID file:', err);
  }
  return newId;
}

/**
 * Create a simple 16x16 PNG tray icon programmatically.
 * Windows does not support SVG tray icons, so we generate a small colored icon.
 */
function createTrayIcon() {
  // Create a minimal valid 16x16 PNG with a blue circle.
  // This is a hand-crafted PNG encoded as base64 to avoid raw RGBA issues
  // with nativeImage.createFromBuffer (which expects PNG/JPEG, not raw pixels).
  const size = 16;
  
  // Build raw RGBA pixel data for a blue circle
  const pixels = [];
  const centerX = size / 2;
  const centerY = size / 2;
  const radius = 6;
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
      if (dist <= radius) {
        pixels.push(0x3b, 0x82, 0xf6, 255); // Blue #3b82f6
      } else {
        pixels.push(0, 0, 0, 0); // Transparent
      }
    }
  }
  
  // Use nativeImage.createFromBitmap which accepts raw RGBA + size
  // Fallback: create a simple colored icon via data URL
  try {
    const img = nativeImage.createEmpty();
    // createFromBuffer with explicit scaleFactor and size
    const buffer = Buffer.from(pixels);
    const icon = nativeImage.createFromBitmap(buffer, { width: size, height: size });
    return icon.resize({ width: 16, height: 16 });
  } catch (e) {
    console.warn('Could not create tray icon from bitmap, using fallback:', e.message);
    // Fallback: generate a 1x1 blue PNG via data URL
    const fallback = nativeImage.createEmpty();
    return fallback;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: isHostMode ? 400 : 1280,
    height: isHostMode ? 300 : 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    title: 'Omniscreen',
    show: !isHostMode // Hidden if host mode
  });

  // In host mode, hide to tray instead of quitting when the window is closed
  if (isHostMode) {
    mainWindow.on('close', (event) => {
      if (!isQuiting) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
  }

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
    
    // Create Tray Icon with a proper bitmap icon (not SVG)
    const icon = createTrayIcon();
    
    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
      { label: 'Host is Running', enabled: false },
      { type: 'separator' },
      { label: 'Show Window', click: () => { if (mainWindow) mainWindow.show(); } },
      { label: 'Quit', click: () => { isQuiting = true; app.quit(); } }
    ]);
    tray.setToolTip('Omniscreen (Host)');
    tray.setContextMenu(contextMenu);
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  // Ensure Python process is properly killed
  if (pythonProcess && !pythonProcess.killed) {
    try {
      pythonProcess.stdin.write("QUIT\n");
    } catch (e) {
      // stdin might already be closed
    }
    // Force kill after a short delay
    setTimeout(() => {
      if (pythonProcess && !pythonProcess.killed) {
        pythonProcess.kill('SIGTERM');
      }
    }, 500);
  }
});

app.on('window-all-closed', () => {
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
// CRITICAL FIX: Strip NativeImage thumbnails — they cannot be serialized over IPC
// and cause the getSources call to silently fail, resulting in a BLACK SCREEN.
ipcMain.handle('GET_SOURCES', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 0, height: 0 }, // Don't generate thumbnails (they cause IPC serialization issues)
      fetchWindowIcons: false
    });
    
    // Return only serializable properties
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      display_id: source.display_id
    }));
  } catch (err) {
    console.error('Error getting desktop sources:', err);
    return [];
  }
});

// Helper to send command to Python
function sendToPython(cmdObj) {
  if (pythonProcess && !pythonProcess.killed) {
    try {
      pythonProcess.stdin.write(JSON.stringify(cmdObj) + "\n");
    } catch (err) {
      console.error('Error sending to Python:', err);
    }
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

// Scroll wheel support
ipcMain.on('SCROLL_WHEEL', (event, { deltaX, deltaY }) => {
  sendToPython({ type: "scroll", deltaX: Math.round(deltaX), deltaY: Math.round(deltaY) });
});
