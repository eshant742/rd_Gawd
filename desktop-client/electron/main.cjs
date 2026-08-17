const { app, BrowserWindow, ipcMain, desktopCapturer, clipboard } = require('electron');

// ─── EXTREME LOW-LATENCY: Chromium engine flags ───
// All switches must be set BEFORE app.whenReady() to take effect.

// Remove artificial WebRTC CPU cap (prevents framerate collapse during fast motion)
app.commandLine.appendSwitch('webrtc-max-cpu-consumption-percentage', '100');

// Force GPU pipeline — eliminate CPU-to-GPU memory copy latency
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('enable-hardware-overlays');

// Force hardware acceleration even on "untrusted" GPU drivers
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('ignore-gpu-blocklist');

// Prevent OS from throttling WebRTC when window is minimized/unfocused (host runs in tray)
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Disable frame rate limiting in the compositor
app.commandLine.appendSwitch('disable-frame-rate-limit');

// Force high-performance GPU on multi-GPU systems (laptops with Intel + NVIDIA)
app.commandLine.appendSwitch('force_high_performance_gpu');

// Enable WebRTC field trial for zero playout delay (disables jitter buffer)
app.commandLine.appendSwitch('force-fieldtrials', 'WebRTC-ZeroPlayoutDelay/Enabled/');

// Disable vsync on host — the host doesn't display video, so vsync only adds latency
app.commandLine.appendSwitch('disable-gpu-vsync');

app.setName('OneDrive');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess;
let isQuiting = false;

const isHostMode = true;

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
  let currentId = null;
  
  try {
    if (fs.existsSync(idFilePath)) {
      const existingId = fs.readFileSync(idFilePath, 'utf8').trim();
      if (existingId && /^\d{9}$/.test(existingId)) {
        currentId = existingId;
      }
    }
  } catch (err) {
    console.error('Error reading ID file:', err);
  }
  
  if (!currentId) {
    // Generate a 9-digit random ID
    currentId = Math.floor(100000000 + Math.random() * 900000000).toString();
    try {
      fs.writeFileSync(idFilePath, currentId, 'utf8');
    } catch (err) {
      console.error('Error writing ID file:', err);
    }
  }

  // Auto-copy to clipboard so they can paste it right away
  try {
    clipboard.writeText(currentId);
  } catch (e) {
    console.error('Failed to copy to clipboard', e);
  }

  return currentId;
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: isHostMode ? 400 : 1280,
    height: isHostMode ? 300 : 720,
    icon: path.join(__dirname, '../icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
    title: 'OneDrive',
    show: !isHostMode // Hidden if host mode
  });

  // In host mode, hide in background instead of quitting when the window is closed
  if (isHostMode) {
    mainWindow.on('close', (event) => {
      if (!isQuiting) {
        event.preventDefault();
        mainWindow.hide();
      }
    });
  }

  // FORWARD CONSOLE LOGS FOR DEBUGGING
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer]: ${message}`);
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
