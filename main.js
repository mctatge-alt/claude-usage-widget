const { app, BrowserWindow, ipcMain, Tray, Menu, session, shell, Notification, safeStorage, nativeImage, screen, nativeTheme, globalShortcut, powerMonitor } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { fetchViaWindow, fetchMultipleViaWindow } = require('./src/fetch-via-window');

// Migration: Handle old encrypted config files from v1.7.0 and earlier
const fs = require('fs');
const os = require('os');

const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'claude-usage-widget', 'config.json');

try {
  if (fs.existsSync(configPath)) {
    const rawData = fs.readFileSync(configPath, 'utf-8');
    // Check if file looks encrypted (contains non-JSON garbage or doesn't start with {)
    if (rawData.includes('\u0000') || !rawData.trim().startsWith('{')) {
      console.log('[Migration] Detected old encrypted config from v1.7.0, deleting for fresh start');
      fs.unlinkSync(configPath);
    }
  }
} catch (err) {
  console.error('[Migration] Error checking config file:', err.message);
  // If we can't read it, try to delete it
  try {
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  } catch {}
}

// Non-sensitive settings storage (no encryption needed)
const store = new Store();

// Debug mode: set DEBUG_LOG=1 env var or pass --debug flag to see verbose logs.
// Regular users will only see critical errors in the console.
const DEBUG = process.env.DEBUG_LOG === '1' || process.argv.includes('--debug');
function debugLog(...args) {
  if (DEBUG) console.log('[Debug]', ...args);
}

const CHROME_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let mainWindow = null;
let sessionTray = null;
let weeklyTray = null;
let singleTray = null;
let notificationSnoozeUntil = 0;
let isOnBatteryPower = false;

const WIDGET_WIDTH = 590;
const WIDGET_HEIGHT = 155;
const COMPACT_WIDTH = 290;
const SIDEBAR_MIN_WIDTH = 72;
const SIDEBAR_MAX_HEIGHT = 1200;
const SIDEBAR_EXIT_WIDTH = 260;
const HISTORY_RETENTION_DAYS = 30;
const CHART_DAYS = 7;
const MAX_HISTORY_SAMPLES = 10000; // Cap total samples to prevent unbounded growth

function storeUsageHistory(data) {
  const timestamp = Date.now();
  let history = store.get('usageHistory', []);

  history.push({
    timestamp,
    session: data.five_hour?.utilization || 0,
    weekly: data.seven_day?.utilization || 0,
    sonnet: data.seven_day_sonnet?.utilization || 0,
    extraUsage: data.extra_usage?.utilization || 0
  });

  // Rotation: apply both time-based and count-based limits
  const cutoff = timestamp - (HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  history = history.filter((entry) => entry.timestamp > cutoff);

  // If still over limit, drop oldest samples
  if (history.length > MAX_HISTORY_SAMPLES) {
    history = history.slice(history.length - MAX_HISTORY_SAMPLES);
  }

  store.set('usageHistory', history);
}

// Set session-level User-Agent to avoid Electron detection
app.on('ready', () => {
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
});

// Set sessionKey as a cookie in Electron's session
async function setSessionCookie(sessionKey) {
  await session.defaultSession.cookies.set({
    url: 'https://claude.ai',
    name: 'sessionKey',
    value: sessionKey,
    domain: '.claude.ai',
    path: '/',
    secure: true,
    httpOnly: true
  });
  debugLog('sessionKey cookie set in Electron session');
}

function notifyWindowResize() {
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const [width, height] = mainWindow.getContentSize();
  mainWindow.webContents.send('window-resize', { width, height });
  return { width, height };
}

function getSavedWindowPosition(displayId) {
  const positions = store.get('windowPositions', {});
  const key = displayId != null ? String(displayId) : null;
  if (key && positions[key] && Number.isFinite(positions[key].x) && Number.isFinite(positions[key].y)) {
    return positions[key];
  }
  const legacy = store.get('windowPosition');
  if (legacy && Number.isFinite(legacy.x) && Number.isFinite(legacy.y)) {
    return legacy;
  }
  return null;
}

function saveWindowPosition(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return;
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const displayId = String(display.id);
  const positions = store.get('windowPositions', {});
  positions[displayId] = { x: bounds.x, y: bounds.y };
  store.set('windowPositions', positions);
  store.set('windowPosition', { x: bounds.x, y: bounds.y });
}

function updateDockBadge(usageData) {
  if (process.platform !== 'darwin') return;
  if (store.get('settings.minimizeToTray', false)) {
    app.dock.setBadge('');
    return;
  }
  const sessionKey = store.get('sessionKey') || store.get('sessionKey_encrypted');
  if (!sessionKey || !usageData) {
    app.dock.setBadge('');
    return;
  }
  const pct = Math.round(usageData?.five_hour?.utilization || 0);
  app.dock.setBadge(pct > 0 ? String(pct) : '');
}

function clearDockBadge() {
  if (process.platform === 'darwin') {
    app.dock.setBadge('');
  }
}

function toggleMainWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    showMainWindowClean();
  }
}

function restoreMainWindowSize() {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, width: 0, height: 0 };

  mainWindow.setFullScreen(false);

  const compact = store.get('settings.compactMode', false);
  const targetWidth = compact ? COMPACT_WIDTH : WIDGET_WIDTH;
  const targetHeight = compact ? 105 : WIDGET_HEIGHT;

  const [cx, cy] = mainWindow.getPosition();
  const nearestDisplay = screen.getDisplayNearestPoint({ x: cx, y: cy });
  const savedPosition = store.get('lastNormalBounds') || getSavedWindowPosition(nearestDisplay.id);
  let display = screen.getPrimaryDisplay();
  if (savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)) {
    display = screen.getDisplayNearestPoint({ x: savedPosition.x, y: savedPosition.y });
  }

  const workArea = display.workArea;
  let x = savedPosition?.x;
  let y = savedPosition?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    x = workArea.x + Math.round((workArea.width - targetWidth) / 2);
    y = workArea.y + Math.round((workArea.height - targetHeight) / 2);
  }

  x = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - targetWidth));
  y = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - targetHeight));

  // Reposition first — moving out of a macOS split-screen tile is required before resizing.
  mainWindow.setPosition(x, y);
  mainWindow.setBounds({ x, y, width: targetWidth, height: targetHeight });

  let size = notifyWindowResize() || { width: 0, height: 0 };

  if (size.width < targetWidth - 20) {
    const fallbackX = workArea.x + Math.round((workArea.width - targetWidth) / 2);
    const fallbackY = workArea.y + Math.round((workArea.height - targetHeight) / 2);
    mainWindow.setBounds({ x: fallbackX, y: fallbackY, width: targetWidth, height: targetHeight }, true);
    size = notifyWindowResize() || size;
  }

  return {
    success: size.width >= targetWidth - 20,
    width: size.width,
    height: size.height
  };
}

function createMainWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const savedPosition = getSavedWindowPosition(primaryDisplay.id);
  const windowOptions = {
    width: WIDGET_WIDTH,
    height: WIDGET_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    icon: path.join(__dirname, 'assets/icon.icns'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  };

  if (savedPosition) {
    windowOptions.x = savedPosition.x;
    windowOptions.y = savedPosition.y;
  }

  windowOptions.minWidth = SIDEBAR_MIN_WIDTH;
  windowOptions.maxWidth = WIDGET_WIDTH;
  windowOptions.minHeight = 105;
  windowOptions.maxHeight = SIDEBAR_MAX_HEIGHT;

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('src/renderer/index.html');

  mainWindow.on('resize', () => {
    notifyWindowResize();
    const [contentWidth] = mainWindow.getContentSize();
    if (contentWidth >= SIDEBAR_EXIT_WIDTH) {
      store.set('lastNormalBounds', mainWindow.getBounds());
    }
  });
  mainWindow.webContents.on('did-finish-load', notifyWindowResize);

  let positionSaveTimer = null;
  mainWindow.on('move', () => {
    if (positionSaveTimer) clearTimeout(positionSaveTimer);
    positionSaveTimer = setTimeout(() => {
      saveWindowPosition(mainWindow.getBounds());
    }, 300);
  });

  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', true);
  });

  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.send('fullscreen-changed', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

/**
 * Determine background color based on thresholds
 */
function getBackgroundColor(percent, isSession, warnThreshold, dangerThreshold) {
  if (percent >= dangerThreshold) {
    // Red #ef4444
    return { r: 239, g: 68, b: 68 };
  } else if (percent >= warnThreshold) {
    // Amber/Orange #f59e0b
    return { r: 245, g: 158, b: 11 };
  } else {
    // Default colors
    if (isSession) {
      // Session coral
      return { r: 255, g: 107, b: 74 };
    } else {
      // Weekly macOS blue
      return { r: 10, g: 132, b: 255 };
    }
  }
}

/**
 * Bold 8x11 bitmap font for numbers 0-9 (2-pixel strokes for bold look)
 * Each number is represented as an array of 11 rows, each row is 8 bits
 */
const BITMAP_FONT = {
  '0': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '1': [
    0b00011000,
    0b00111000,
    0b01111000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b00011000,
    0b01111110,
    0b01111110
  ],
  '2': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00011100,
    0b00111000,
    0b01110000,
    0b11100000,
    0b11111111,
    0b11111111
  ],
  '3': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b00000011,
    0b00000110,
    0b00111100,
    0b00000110,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '4': [
    0b00000110,
    0b00001110,
    0b00011110,
    0b00110110,
    0b01100110,
    0b11111111,
    0b11111111,
    0b00000110,
    0b00000110,
    0b00000110,
    0b00000110
  ],
  '5': [
    0b11111111,
    0b11111111,
    0b11000000,
    0b11000000,
    0b11111100,
    0b00000110,
    0b00000011,
    0b00000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '6': [
    0b00111100,
    0b01111110,
    0b11100000,
    0b11000000,
    0b11111100,
    0b11100110,
    0b11000011,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '7': [
    0b11111111,
    0b11111111,
    0b00000011,
    0b00000110,
    0b00001100,
    0b00011000,
    0b00110000,
    0b00110000,
    0b01100000,
    0b01100000,
    0b01100000
  ],
  '8': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b01111110,
    0b00111100,
    0b01111110,
    0b11000011,
    0b11100111,
    0b01111110,
    0b00111100
  ],
  '9': [
    0b00111100,
    0b01111110,
    0b11100111,
    0b11000011,
    0b11000011,
    0b01111111,
    0b00111111,
    0b00000011,
    0b00000111,
    0b01111110,
    0b00111100
  ]
};

/**
 * Narrow 6x11 bitmap font for 3-digit numbers (100%)
 * Bold version to match
 */
const BITMAP_FONT_NARROW = {
  '0': [
    0b011110,
    0b111111,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b110011,
    0b111111,
    0b011110
  ],
  '1': [
    0b001100,
    0b011100,
    0b111100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b001100,
    0b111111,
    0b111111
  ]
};

/**
 * Draw a crisp bitmap character at position (x, y) in the buffer
 */
function drawChar(buffer, width, height, char, x, y, color, useNarrow = false) {
  const bitmap = useNarrow ? BITMAP_FONT_NARROW[char] : BITMAP_FONT[char];
  if (!bitmap) return useNarrow ? 6 : 8;
  
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const maxCol = useNarrow ? 5 : 7;
  
  for (let row = 0; row < charHeight; row++) {
    for (let col = 0; col < charWidth; col++) {
      if (bitmap[row] & (1 << (maxCol - col))) {
        const px = x + col;
        const py = y + row;
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = color.b;
          buffer[offset + 1] = color.g;
          buffer[offset + 2] = color.r;
          buffer[offset + 3] = color.a;
        }
      }
    }
  }
  return charWidth;
}

function finalizeTrayImage(buffer, width, height, templateMode) {
  const image = nativeImage.createFromBuffer(buffer, { width, height });
  if (templateMode) {
    image.setTemplateImage(true);
  }
  return image;
}

/**
 * Generate a single percentage badge icon with colored background and bitmap text
 * @param {number} percent - Usage percentage (0-100)
 * @param {object} bgColor - Background color {r, g, b}
 * @param {boolean} templateMode - Monochrome template icon for macOS menu bar
 * @returns {NativeImage} Generated tray icon
 */
function generatePercentageIcon(percent, bgColor, templateMode = false) {
  const width = 20;  // Back to 20x20
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  if (templateMode) {
    // Transparent background; digits drawn in white for macOS template tinting
  } else {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        buffer[offset] = bgColor.b;
        buffer[offset + 1] = bgColor.g;
        buffer[offset + 2] = bgColor.r;
        buffer[offset + 3] = 255;
      }
    }
  }
  
  const percentText = Math.round(percent).toString();
  const textColor = { r: 255, g: 255, b: 255, a: 255 };
  
  // Use narrow font for 3-digit numbers (100%)
  const useNarrow = percentText.length >= 3;
  const charWidth = useNarrow ? 6 : 8;
  const charHeight = 11;
  const gap = percentText.length >= 3 ? 0 : 1; // 1px gap for 1-2 digits, no gap for 100
  const totalWidth = percentText.length * charWidth + (percentText.length - 1) * gap;
  let startX = Math.floor((width - totalWidth) / 2);
  const startY = Math.floor((height - charHeight) / 2);
  
  // Draw each digit
  for (let i = 0; i < percentText.length; i++) {
    drawChar(buffer, width, height, percentText[i], startX, startY, textColor, useNarrow);
    startX += charWidth + gap;
  }
  
  return finalizeTrayImage(buffer, width, height, templateMode);
}

/**
 * Generate a split icon for single-tray mode (session left, weekly right)
 */
function generateCombinedTrayIcon(sessionPercent, weeklyPercent, templateMode = false) {
  const width = 20;
  const height = 20;
  const halfWidth = 10;
  const warnThreshold = store.get('settings.warnThreshold', 75);
  const dangerThreshold = store.get('settings.dangerThreshold', 90);
  const sessionBg = getBackgroundColor(sessionPercent, true, warnThreshold, dangerThreshold);
  const weeklyBg = getBackgroundColor(weeklyPercent, false, warnThreshold, dangerThreshold);

  const leftIcon = sessionPercent >= 99
    ? generateRedXIcon(templateMode)
    : generatePercentageIcon(sessionPercent, sessionBg, templateMode);
  const rightIcon = weeklyPercent >= 99
    ? generateRedXIcon(templateMode)
    : generatePercentageIcon(weeklyPercent, weeklyBg, templateMode);

  if (templateMode) {
    const maxPct = Math.max(sessionPercent, weeklyPercent);
    return generatePercentageIcon(maxPct, { r: 255, g: 255, b: 255 }, true);
  }

  const buffer = Buffer.alloc(width * height * 4);
  const leftBuf = leftIcon.toBitmap();
  const rightBuf = rightIcon.toBitmap();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < halfWidth; x++) {
      const src = (y * width + x) * 4;
      const dst = (y * width + x) * 4;
      buffer[dst] = leftBuf[src];
      buffer[dst + 1] = leftBuf[src + 1];
      buffer[dst + 2] = leftBuf[src + 2];
      buffer[dst + 3] = leftBuf[src + 3];
    }
    for (let x = halfWidth; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = (y * width + x) * 4;
      buffer[dst] = rightBuf[src];
      buffer[dst + 1] = rightBuf[src + 1];
      buffer[dst + 2] = rightBuf[src + 2];
      buffer[dst + 3] = rightBuf[src + 3];
    }
  }

  return nativeImage.createFromBuffer(buffer, { width, height });
}

/**
 * Generate a Red X icon for 99-100% usage (maxed out)
 * @param {boolean} templateMode - Monochrome template icon for macOS menu bar
 * @returns {NativeImage} Generated red X tray icon
 */
function generateRedXIcon(templateMode = false) {
  const width = 20;
  const height = 20;
  const buffer = Buffer.alloc(width * height * 4);
  
  if (!templateMode) {
    const red = { r: 220, g: 53, b: 69 }; // #dc3545
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        buffer[offset] = red.b;
        buffer[offset + 1] = red.g;
        buffer[offset + 2] = red.r;
        buffer[offset + 3] = 255;
      }
    }
  }
  
  // Draw white X (2 pixel thick lines)
  const white = { r: 255, g: 255, b: 255, a: 255 };
  
  // Diagonal line from top-left to bottom-right
  for (let i = 0; i < 11; i++) {
    const x1 = 5 + i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  // Diagonal line from top-right to bottom-left
  for (let i = 0; i < 11; i++) {
    const x1 = 15 - i;
    const y1 = 5 + i;
    // Draw 2x2 pixel for thickness
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const px = x1 + dx;
        const py = y1 + dy;
        if (px < width && py < height) {
          const offset = (py * width + px) * 4;
          buffer[offset] = white.b;
          buffer[offset + 1] = white.g;
          buffer[offset + 2] = white.r;
          buffer[offset + 3] = white.a;
        }
      }
    }
  }
  
  return finalizeTrayImage(buffer, width, height, templateMode);
}

function buildTrayContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Show Claude Meter',
      click: () => {
        if (mainWindow) {
          showMainWindowClean();
        } else {
          createMainWindow();
        }
      }
    },
    {
      label: 'Refresh',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('refresh-usage');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => {
        if (mainWindow) {
          showMainWindowClean();
          mainWindow.webContents.send('open-settings');
        } else {
          createMainWindow();
          mainWindow.webContents.once('did-finish-load', () => {
            mainWindow.webContents.send('open-settings');
          });
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Sign Out',
      click: async () => {
        store.delete('sessionKey');
        store.delete('organizationId');
        store.delete('sessionKey_encrypted');
        clearDockBadge();
        const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
        for (const cookie of cookies) {
          await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
        }
        await session.defaultSession.clearStorageData({
          storages: ['localstorage', 'sessionstorage', 'cachestorage'],
          origin: 'https://claude.ai'
        });
        if (mainWindow) {
          mainWindow.webContents.send('session-expired');
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Claude Meter',
      click: () => {
        app.quit();
      }
    }
  ]);
}

function attachTrayClickHandlers(tray) {
  tray.on('click', () => {
    toggleMainWindowVisibility();
  });
}

/**
 * Show the main window.
 */
function showMainWindowClean() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function getTrayIconMode() {
  return store.get('settings.trayIconMode', 'dual') === 'single' ? 'single' : 'dual';
}

function createTray() {
  if (!store.get('settings.showTrayStats', false)) {
    destroyTrayIcons();
    return;
  }

  const iconMode = getTrayIconMode();
  const hasSessionTray = sessionTray && !sessionTray.isDestroyed();
  const hasWeeklyTray = weeklyTray && !weeklyTray.isDestroyed();
  const hasSingleTray = singleTray && !singleTray.isDestroyed();

  if (iconMode === 'single') {
    if (hasSingleTray && !hasSessionTray && !hasWeeklyTray) return;
    if (hasSessionTray || hasWeeklyTray || hasSingleTray) destroyTrayIcons();
  } else {
    if (hasSessionTray && hasWeeklyTray && !hasSingleTray) return;
    if (hasSessionTray || hasWeeklyTray || hasSingleTray) destroyTrayIcons();
  }

  try {
    const staticIconPath = path.join(__dirname, 'assets/tray-icon-mac.png');
    const contextMenu = buildTrayContextMenu();

    if (iconMode === 'single') {
      singleTray = new Tray(staticIconPath);
      singleTray.setToolTip('Claude Meter');
      singleTray.setContextMenu(contextMenu);
      attachTrayClickHandlers(singleTray);
    } else {
      weeklyTray = new Tray(staticIconPath);
      weeklyTray.setToolTip('Weekly Usage');
      sessionTray = new Tray(staticIconPath);
      sessionTray.setToolTip('Session Usage');
      sessionTray.setContextMenu(contextMenu);
      weeklyTray.setContextMenu(contextMenu);
      attachTrayClickHandlers(weeklyTray);
      attachTrayClickHandlers(sessionTray);
    }
  } catch (error) {
    console.error('Failed to create tray:', error);
  }
}

function destroyTrayIcons() {
  const trays = [sessionTray, weeklyTray, singleTray];
  sessionTray = null;
  weeklyTray = null;
  singleTray = null;

  for (const tray of trays) {
    if (!tray || tray.isDestroyed()) continue;

    try {
      tray.removeAllListeners();
      tray.setContextMenu(null);
      tray.setToolTip('');
    } catch (error) {
      console.error('Failed to clear tray icon:', error);
    }

    try {
      tray.destroy();
    } catch (error) {
      console.error('Failed to destroy tray icon:', error);
    }
  }
}

/**
 * Format reset time for tray tooltip
 * @param {string} resetsAt - ISO timestamp string
 * @param {string} timeFormat - '12h' or '24h'
 * @param {boolean} includeDate - Whether to include the date (for weekly resets)
 * @returns {string} Formatted time string
 */
function formatResetTime(resetsAt, timeFormat, includeDate = false) {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  
  const formatTime = () => {
    if (timeFormat === '24h') {
      return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    } else {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${hours}:${minutes} ${ampm}`;
    }
  };
  
  if (includeDate) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const monthStr = months[date.getMonth()];
    const dayNum = date.getDate();
    return `${monthStr} ${dayNum}, ${formatTime()}`;
  } else {
    return formatTime();
  }
}

/**
 * Update tray icons with current usage data
 * @param {Object} usageData - Usage data object containing session and weekly percentages
 */
function updateTrayIcon(usageData) {
  const showTrayStats = store.get('settings.showTrayStats', false);
  updateDockBadge(usageData);

  if (!showTrayStats) {
    destroyTrayIcons();
    return;
  }

  const iconMode = getTrayIconMode();
  const templateMode = store.get('settings.trayTemplateIcons', true);
  const warnThreshold = store.get('settings.warnThreshold', 75);
  const dangerThreshold = store.get('settings.dangerThreshold', 90);
  const timeFormat = store.get('settings.timeFormat', '12h');

  const sessionPercent = usageData?.five_hour?.utilization || 0;
  const sessionResetsAt = usageData?.five_hour?.resets_at;
  const weeklyPercent = usageData?.seven_day?.utilization || 0;
  const weeklyResetsAt = usageData?.seven_day?.resets_at;

  const needsSingle = iconMode === 'single';
  const needsDual = iconMode === 'dual';
  const singleOk = singleTray && !singleTray.isDestroyed();
  const sessionOk = sessionTray && !sessionTray.isDestroyed();
  const weeklyOk = weeklyTray && !weeklyTray.isDestroyed();

  if ((needsSingle && !singleOk) || (needsDual && (!sessionOk || !weeklyOk))) {
    createTray();
  }

  try {
    if (iconMode === 'single' && singleTray && !singleTray.isDestroyed()) {
      const combinedIcon = (sessionPercent >= 99 && weeklyPercent >= 99)
        ? generateRedXIcon(templateMode)
        : generateCombinedTrayIcon(sessionPercent, weeklyPercent, templateMode);
      singleTray.setImage(combinedIcon);
      let tooltip = `Session: ${Math.round(sessionPercent)}% · Weekly: ${Math.round(weeklyPercent)}%`;
      const sessionResetTime = formatResetTime(sessionResetsAt, timeFormat, false);
      const weeklyResetTime = formatResetTime(weeklyResetsAt, timeFormat, true);
      if (sessionResetTime) tooltip += `\nSession resets: ${sessionResetTime}`;
      if (weeklyResetTime) tooltip += `\nWeekly resets: ${weeklyResetTime}`;
      singleTray.setToolTip(tooltip);
      return;
    }

    let weeklyIcon;
    if (weeklyPercent >= 99) {
      weeklyIcon = generateRedXIcon(templateMode);
    } else {
      const weeklyColor = getBackgroundColor(weeklyPercent, false, warnThreshold, dangerThreshold);
      weeklyIcon = generatePercentageIcon(weeklyPercent, weeklyColor, templateMode);
    }
    if (weeklyTray && !weeklyTray.isDestroyed()) {
      weeklyTray.setImage(weeklyIcon);
      let weeklyTooltip = `Weekly: ${Math.round(weeklyPercent)}%`;
      const weeklyResetTime = formatResetTime(weeklyResetsAt, timeFormat, true);
      if (weeklyResetTime) {
        weeklyTooltip += `\nResets: ${weeklyResetTime}`;
      }
      weeklyTray.setToolTip(weeklyTooltip);
    }

    let sessionIcon;
    if (sessionPercent >= 99) {
      sessionIcon = generateRedXIcon(templateMode);
    } else {
      const sessionColor = getBackgroundColor(sessionPercent, true, warnThreshold, dangerThreshold);
      sessionIcon = generatePercentageIcon(sessionPercent, sessionColor, templateMode);
    }
    if (sessionTray && !sessionTray.isDestroyed()) {
      sessionTray.setImage(sessionIcon);
      let sessionTooltip = `Session: ${Math.round(sessionPercent)}%`;
      const sessionResetTime = formatResetTime(sessionResetsAt, timeFormat, false);
      if (sessionResetTime) {
        sessionTooltip += `\nResets: ${sessionResetTime}`;
      }
      sessionTray.setToolTip(sessionTooltip);
    }
  } catch (error) {
    console.error('Failed to update tray icons:', error);
  }
}

function setupApplicationMenu() {
  const appName = 'Claude Meter';
  const template = [
    {
      label: appName,
      submenu: [
        { role: 'about', label: `About ${appName}` },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${appName}` }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Refresh Usage',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('refresh-usage');
            }
          }
        },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Settings',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow) {
              showMainWindowClean();
              mainWindow.webContents.send('open-settings');
            } else {
              createMainWindow();
              mainWindow.webContents.once('did-finish-load', () => {
                mainWindow.webContents.send('open-settings');
              });
            }
          }
        },
        { type: 'separator' },
        { role: 'minimize' },
        {
          label: 'Hide Window',
          accelerator: 'CmdOrCtrl+H',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.hide();
            } else {
              app.hide();
            }
          }
        },
        { role: 'close' }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerGlobalShortcuts() {
  try {
    globalShortcut.register('CommandOrControl+Shift+U', () => {
      toggleMainWindowVisibility();
    });
  } catch (error) {
    console.error('Failed to register global shortcut:', error.message);
  }
}


// IPC Handlers
ipcMain.handle('get-credentials', () => {
  let sessionKey = null;
  // Try safeStorage first (OS keychain)
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
      }
    }
  } else {
    // Fallback: plain storage (legacy or safeStorage unavailable)
    sessionKey = store.get('sessionKey');
  }
  return {
    sessionKey,
    organizationId: store.get('organizationId')
  };
});

ipcMain.handle('save-credentials', async (event, { sessionKey, organizationId }) => {
  // Store session key in OS keychain if available
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(sessionKey);
    store.set('sessionKey_encrypted', encrypted.toString('base64'));
    store.delete('sessionKey'); // Remove legacy plain storage
  } else {
    // Fallback: plain storage
    store.set('sessionKey', sessionKey);
  }
  if (organizationId) {
    store.set('organizationId', organizationId);
  }
  // Also set cookie in Electron session for window-based fetching
  await setSessionCookie(sessionKey);
  return true;
});

ipcMain.handle('delete-credentials', async () => {
  store.delete('sessionKey');
  store.delete('sessionKey_encrypted');
  store.delete('organizationId');
  clearDockBadge();
  // Remove all Claude.ai cookies
  const cookies = await session.defaultSession.cookies.get({ url: 'https://claude.ai' });
  for (const cookie of cookies) {
    await session.defaultSession.cookies.remove('https://claude.ai', cookie.name);
  }
  // Clear any cached data from the Electron session (storage, cache)
  // so nothing lingers on shared machines
  await session.defaultSession.clearStorageData({
    storages: ['localstorage', 'sessionstorage', 'cachestorage'],
    origin: 'https://claude.ai'
  });
  return true;
});

// Validate a sessionKey by fetching org ID via hidden BrowserWindow
ipcMain.handle('validate-session-key', async (event, sessionKey) => {
  debugLog('Validating session key:', sessionKey.substring(0, 20) + '...');
  try {
    // Set the cookie in Electron's session first
    await setSessionCookie(sessionKey);

    // Fetch organizations using hidden BrowserWindow (bypasses Cloudflare)
    const data = await fetchViaWindow('https://claude.ai/api/organizations');

    if (data && Array.isArray(data) && data.length > 0) {
      // Filter to orgs with 'chat' capability (excludes API-only orgs)
      const chatOrgs = data.filter(org => 
        org.capabilities && org.capabilities.includes('chat')
      );

      if (chatOrgs.length === 0) {
        return { success: false, error: 'No chat-enabled organizations found' };
      }

      // Prioritize Teams org if present, otherwise use first chat org
      const defaultOrg = chatOrgs.find(org => org.raven_type === 'team') || chatOrgs[0];
      const orgId = defaultOrg.uuid || defaultOrg.id;
      
      debugLog(`Session key validated, found ${chatOrgs.length} chat org(s), default org ID:`, orgId);
      
      return { 
        success: true, 
        organizationId: orgId,
        organizations: chatOrgs.map(org => ({
          id: org.uuid || org.id,
          name: org.name,
          isTeam: org.raven_type === 'team'
        }))
      };
    }

    // Check if it's an error response
    if (data && data.error) {
      return { success: false, error: data.error.message || data.error };
    }

    return { success: false, error: 'No organization found' };
  } catch (error) {
    console.error('Session key validation failed:', error.message);
    // Clean up the invalid cookie
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
    return { success: false, error: error.message };
  }
});

ipcMain.on('minimize-window', () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.on('close-window', () => {
  app.quit();
});

ipcMain.on('resize-window', (event, height) => {
  if (mainWindow) {
    const [currentWidth] = mainWindow.getContentSize();
    mainWindow.setContentSize(currentWidth, height);
  }
});

ipcMain.handle('get-window-position', () => {
  if (mainWindow) {
    return mainWindow.getBounds();
  }
  return null;
});

ipcMain.handle('set-window-position', (event, { x, y }) => {
  if (mainWindow) {
    mainWindow.setPosition(x, y);
    return true;
  }
  return false;
});

ipcMain.on('open-external', (event, url) => {
  // Trust boundary enforcement: duplicate allowlist check in main process
  const allowedDomains = ['claude.ai'];
  try {
    const parsedUrl = new URL(url);
    const isAllowed = allowedDomains.some(domain => 
      parsedUrl.hostname === domain || parsedUrl.hostname.endsWith('.' + domain)
    );
    if (isAllowed) {
      shell.openExternal(url);
    } else {
      console.warn(`[Security] Blocked openExternal call to disallowed domain: ${parsedUrl.hostname}`);
    }
  } catch (err) {
    console.warn(`[Security] Blocked openExternal call with invalid URL: ${url}`);
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-usage-history', () => {
  const history = store.get('usageHistory', []);
  const cutoff = Date.now() - (CHART_DAYS * 24 * 60 * 60 * 1000);
  return history
    .filter((entry) => entry.timestamp > cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
});

// macOS Notification Center
ipcMain.on('show-notification', (event, { title, body, thresholdAlert }) => {
  if (!Notification.isSupported()) return;
  if (thresholdAlert && Date.now() < notificationSnoozeUntil) return;

  const options = { title, body, silent: false };
  if (thresholdAlert) {
    options.actions = [
      { type: 'button', text: 'Show Widget' },
      { type: 'button', text: 'Snooze 1 hour' }
    ];
    options.closeButtonText = 'Dismiss';
  }

  const n = new Notification(options);

  n.on('click', () => {
    showMainWindowClean();
  });

  if (thresholdAlert) {
    n.on('action', (_event, index) => {
      if (index === 0) {
        showMainWindowClean();
      } else if (index === 1) {
        notificationSnoozeUntil = Date.now() + (60 * 60 * 1000);
      }
    });
  }

  n.show();
});

// Resize window for compact vs normal mode
// Compact: 290px wide, normal: 530px wide. Height stays managed by renderer.
ipcMain.on('set-compact-mode', (event, compact) => {
  if (mainWindow) {
    const bounds = mainWindow.getBounds();
    const width = compact ? COMPACT_WIDTH : WIDGET_WIDTH;
    const height = compact ? 105 : WIDGET_HEIGHT;
    mainWindow.setBounds({ x: bounds.x, y: bounds.y, width, height });
  }
});

ipcMain.handle('restore-window-size', () => restoreMainWindowSize());

ipcMain.handle('is-window-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isFullScreen();
});

ipcMain.handle('toggle-fullscreen', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { fullScreen: false };
  mainWindow.setFullScreen(!mainWindow.isFullScreen());
  return { fullScreen: mainWindow.isFullScreen() };
});

// Settings handlers
ipcMain.handle('get-settings', () => {
  return {
    autoStart: store.get('settings.autoStart', false),
    minimizeToTray: store.get('settings.minimizeToTray', false),
    alwaysOnTop: store.get('settings.alwaysOnTop', true),
    theme: store.get('settings.theme', 'dark'),
    warnThreshold: store.get('settings.warnThreshold', 75),
    dangerThreshold: store.get('settings.dangerThreshold', 90),
    timeFormat: store.get('settings.timeFormat', '12h'),
    weeklyDateFormat: store.get('settings.weeklyDateFormat', 'date'),
    usageAlerts: store.get('settings.usageAlerts', true),
    compactMode: store.get('settings.compactMode', false),
    refreshInterval: store.get('settings.refreshInterval', '300'),
    graphVisible: store.get('settings.graphVisible', false),
    expandedOpen: store.get('settings.expandedOpen', false),
    showTrayStats: store.get('settings.showTrayStats', false),
    panelOpacity: store.get('settings.panelOpacity', 82),
    trayIconMode: store.get('settings.trayIconMode', 'dual'),
    trayTemplateIcons: store.get('settings.trayTemplateIcons', true),
    batterySaver: store.get('settings.batterySaver', true)
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  const autoStart = settings.autoStart;

  store.set('settings.autoStart', autoStart);
  store.set('settings.minimizeToTray', settings.minimizeToTray);
  store.set('settings.alwaysOnTop', settings.alwaysOnTop);
  store.set('settings.theme', settings.theme);
  store.set('settings.warnThreshold', settings.warnThreshold);
  store.set('settings.dangerThreshold', settings.dangerThreshold);
  store.set('settings.timeFormat', settings.timeFormat);
  store.set('settings.weeklyDateFormat', settings.weeklyDateFormat);
  store.set('settings.usageAlerts', settings.usageAlerts);
  store.set('settings.compactMode', settings.compactMode);
  store.set('settings.refreshInterval', settings.refreshInterval);
  store.set('settings.graphVisible', settings.graphVisible);
  store.set('settings.expandedOpen', settings.expandedOpen);
  store.set('settings.showTrayStats', settings.showTrayStats);
  store.set('settings.panelOpacity', Math.min(100, Math.max(40, settings.panelOpacity ?? 82)));
  store.set('settings.trayIconMode', settings.trayIconMode === 'single' ? 'single' : 'dual');
  store.set('settings.trayTemplateIcons', settings.trayTemplateIcons !== false);
  store.set('settings.batterySaver', settings.batterySaver !== false);

  app.setLoginItemSettings({ openAtLogin: autoStart });

  if (mainWindow) {
    if (settings.minimizeToTray) {
      app.dock.hide();
      clearDockBadge();
    } else {
      app.dock.show();
      const latestUsageData = store.get('latestUsageData');
      updateDockBadge(latestUsageData);
    }
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  }

  if (!settings.showTrayStats) {
    destroyTrayIcons();
  } else {
    destroyTrayIcons();
    const latestUsageData = store.get('latestUsageData');
    if (latestUsageData) {
      createTray();
      updateTrayIcon(latestUsageData);
    } else {
      createTray();
    }
  }

  if (mainWindow) {
    mainWindow.webContents.send('settings-saved', settings);
  }

  return true;
});

// Open a visible BrowserWindow for the user to log in to Claude.ai.
//
// Why we don't embed login directly in the app:
// Claude.ai (via Cloudflare) detects and blocks Electron-embedded logins.
// Instead, we open a standalone browser window, let the user authenticate
// normally, then capture the sessionKey cookie once login completes.
// Do NOT attempt to "fix" this back to an embedded login without verifying
// that Claude.ai/Cloudflare no longer blocks it.
//
// SECURITY: Navigation is restricted to trusted domains (claude.ai and OAuth
// providers) to prevent phishing attacks. Popup windows are blocked. Current
// URL is displayed in the window title bar for transparency.
ipcMain.handle('detect-session-key', async () => {
  // Clear any leftover sessionKey cookie
  try {
    await session.defaultSession.cookies.remove('https://claude.ai', 'sessionKey');
  } catch (e) { /* ignore */ }

  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      title: 'Claude Login - https://claude.ai/login',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let resolved = false;

    // Security: restrict navigation to trusted domains only
    const allowedLoginDomains = [
      'claude.ai',
      'accounts.google.com',
      'appleid.apple.com',
      'login.microsoftonline.com'
    ];

    loginWin.webContents.on('will-navigate', (event, url) => {
      try {
        const hostname = new URL(url).hostname;
        const isAllowed = allowedLoginDomains.some(domain =>
          hostname === domain || hostname.endsWith('.' + domain)
        );
        if (!isAllowed) {
          event.preventDefault();
          console.warn('[Security] Blocked login navigation to untrusted domain:', url);
        } else {
          // Update title bar to show current URL (read-only)
          loginWin.setTitle(`Claude Login - ${url}`);
        }
      } catch (err) {
        event.preventDefault();
        console.warn('[Security] Blocked login navigation with invalid URL:', url);
      }
    });

    // Update title on OAuth redirects and in-page navigation
    loginWin.webContents.on('did-navigate', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    loginWin.webContents.on('did-navigate-in-page', (event, url) => {
      loginWin.setTitle(`Claude Login - ${url}`);
    });

    // Security: block popup windows from login page
    loginWin.webContents.setWindowOpenHandler(() => {
      console.warn('[Security] Blocked popup window attempt from login page');
      return { action: 'deny' };
    });

    // Listen for sessionKey cookie being set after login
    const onCookieChanged = (event, cookie, cause, removed) => {
      if (
        cookie.name === 'sessionKey' &&
        cookie.domain.includes('claude.ai') &&
        !removed &&
        cookie.value
      ) {
        resolved = true;
        session.defaultSession.cookies.removeListener('changed', onCookieChanged);
        loginWin.close();
        resolve({ success: true, sessionKey: cookie.value });
      }
    };

    session.defaultSession.cookies.on('changed', onCookieChanged);

    loginWin.on('closed', () => {
      session.defaultSession.cookies.removeListener('changed', onCookieChanged);
      if (!resolved) {
        resolve({ success: false, error: 'Login window closed' });
      }
    });

    loginWin.loadURL('https://claude.ai/login');
  });
});

ipcMain.handle('fetch-usage-data', async (event, options = {}) => {
  // Use the same credential retrieval logic as get-credentials
  let sessionKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key:', err.message);
      }
    }
  } else {
    sessionKey = store.get('sessionKey');
  }

  const organizationId = store.get('organizationId');

  if (!sessionKey || !organizationId) {
    throw new Error('Missing credentials');
  }

  // Ensure cookie is set
  await setSessionCookie(sessionKey);

  // Conditional API polling: Only fetch overage/prepaid if the expand panel is open
  // or if compact mode is disabled (normal mode). This reduces API calls when the
  // user won't see the extra usage data anyway.
  // If forceExtended is passed (e.g., when user clicks expand), use that instead of saved setting
  const expandedOpen = options.forceExtended !== undefined ? options.forceExtended : store.get('settings.expandedOpen', false);
  const compactMode = store.get('settings.compactMode', false);
  const shouldFetchExtended = expandedOpen;

  const usageUrl = `https://claude.ai/api/organizations/${organizationId}/usage`;
  const overageUrl = `https://claude.ai/api/organizations/${organizationId}/overage_spend_limit`;
  const prepaidUrl = `https://claude.ai/api/organizations/${organizationId}/prepaid/credits`;

  // Build URL array based on UI state
  const urls = [usageUrl];
  if (shouldFetchExtended) {
    urls.push(overageUrl, prepaidUrl);
    debugLog('[Conditional Polling] Fetching extended data (overage + prepaid) - panel is visible');
  } else {
    debugLog('[Conditional Polling] Skipping extended data - panel not visible');
  }

  // Fetch endpoints sequentially using a single reused BrowserWindow.
  // This reduces memory overhead compared to creating 3 separate windows.
  // Usage is always required; overage and prepaid are conditional based on UI state.
  let usageResult, overageResult, prepaidResult;
  
  try {
    const results = await fetchMultipleViaWindow(urls);
    
    // Always have usage result (first in array)
    usageResult = { status: 'fulfilled', value: results[0] };
    
    // Conditionally map overage/prepaid results
    if (shouldFetchExtended) {
      overageResult = { status: 'fulfilled', value: results[1] };
      prepaidResult = { status: 'fulfilled', value: results[2] };
    } else {
      // Mark as skipped (not an error, just not fetched)
      overageResult = { status: 'skipped', reason: 'UI panel not visible' };
      prepaidResult = { status: 'skipped', reason: 'UI panel not visible' };
    }
  } catch (error) {
    // If any fetch fails, determine which one and set appropriate result statuses
    // For now, if the batch fails, treat usage as failed (required endpoint)
    usageResult = { status: 'rejected', reason: error };
    overageResult = { status: 'rejected', reason: error };
    prepaidResult = { status: 'rejected', reason: error };
  }

  // Usage endpoint is mandatory
  if (usageResult.status === 'rejected') {
    const error = usageResult.reason;
    debugLog('API request failed:', error.message);
    const isBlocked = error.message.startsWith('CloudflareBlocked')
      || error.message.startsWith('CloudflareChallenge')
      || error.message.startsWith('UnexpectedHTML');
    if (isBlocked) {
      store.delete('sessionKey');
      store.delete('organizationId');
      if (mainWindow) {
        mainWindow.webContents.send('session-expired');
      }
      throw new Error('SessionExpired');
    }
    throw error;
  }

  const data = usageResult.value;

  // Merge overage spending data into data.extra_usage
  if (overageResult.status === 'fulfilled' && overageResult.value) {
    const overage = overageResult.value;
    const limit = overage.monthly_credit_limit ?? overage.spend_limit_amount_cents;
    const used = overage.used_credits ?? overage.balance_cents;
    const enabled = overage.is_enabled !== undefined ? overage.is_enabled : (limit != null);

    if (enabled && typeof limit === 'number' && limit > 0 && typeof used === 'number') {
      data.extra_usage = {
        utilization: (used / limit) * 100,
        resets_at: null,
        used_cents: used,
        limit_cents: limit,
        is_enabled: true,
        currency: overage.currency || 'USD',
      };
    } else if (!enabled) {
      // Extra usage is off — still pass the flag so the renderer can show status
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.is_enabled = false;
      data.extra_usage.currency = overage.currency || 'USD';
    }
  } else {
    debugLog('Overage fetch skipped or failed:', overageResult.reason?.message || 'no data');
  }

  // Merge prepaid balance into data.extra_usage
  if (prepaidResult.status === 'fulfilled' && prepaidResult.value) {
    const prepaid = prepaidResult.value;
    if (typeof prepaid.amount === 'number') {
      if (!data.extra_usage) data.extra_usage = {};
      data.extra_usage.balance_cents = prepaid.amount;
      // Use prepaid currency if overage didn't already set one
      if (!data.extra_usage.currency && prepaid.currency) {
        data.extra_usage.currency = prepaid.currency;
      }
    }
  } else {
    debugLog('Prepaid fetch skipped or failed:', prepaidResult.reason?.message || 'no data');
  }

  storeUsageHistory(data);

  // Store latest usage data for settings refresh
  store.set('latestUsageData', data);

  // Update tray icon with current usage data
  updateTrayIcon(data);

  // Re-assert always-on-top after hidden BrowserWindows from fetchViaWindow
  // are destroyed — creating/destroying BrowserWindows can temporarily disrupt
  // the main window's z-order on some OS/window manager combinations.
  if (mainWindow && !mainWindow.isDestroyed()) {
    const alwaysOnTop = store.get('settings.alwaysOnTop', true);
    if (alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true, 'floating');
    }
  }

  return data;
});

// App lifecycle
app.whenReady().then(async () => {
  setupApplicationMenu();
  registerGlobalShortcuts();

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
    }
  });

  powerMonitor.on('on-battery', () => {
    isOnBatteryPower = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-state-changed', { onBattery: true });
    }
  });

  powerMonitor.on('on-ac-power', () => {
    isOnBatteryPower = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('power-state-changed', { onBattery: false });
    }
  });

  isOnBatteryPower = powerMonitor.isOnBatteryPower?.() ?? false;

  // Restore session cookie if we have stored credentials
  let sessionKey = null;
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = store.get('sessionKey_encrypted');
    if (encrypted) {
      try {
        sessionKey = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      } catch (err) {
        console.error('[Keychain] Failed to decrypt session key on startup:', err.message);
      }
    }
  } else {
    sessionKey = store.get('sessionKey');
  }

  if (sessionKey) {
    await setSessionCookie(sessionKey);
  }

  createMainWindow();
  // Avoid creating temporary tray icons during startup when tray stats are disabled.
  if (store.get('settings.showTrayStats', false)) {
    createTray();
  }

  // Apply persisted settings
  const minimizeToTray = store.get('settings.minimizeToTray', false);
  const alwaysOnTop = store.get('settings.alwaysOnTop', true);
  if (mainWindow) {
    if (minimizeToTray) {
      app.dock.hide();
      clearDockBadge();
    } else {
      const latestUsageData = store.get('latestUsageData');
      updateDockBadge(latestUsageData);
    }
    mainWindow.setAlwaysOnTop(alwaysOnTop, 'floating');
  }

  // Periodic always-on-top re-assertion to recover from z-order disruptions
  // (hidden window spawns, window manager shortcuts, alt-tab, etc.)
  setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const alwaysOnTopSetting = store.get('settings.alwaysOnTop', true);
      if (alwaysOnTopSetting) {
        mainWindow.setAlwaysOnTop(true, 'floating');
      }
    }
  }, 5000);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  // macOS apps stay running until explicit Quit
});

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow();
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Prevent multiple instances
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
