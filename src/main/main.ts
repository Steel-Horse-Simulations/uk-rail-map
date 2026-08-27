import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#E4F3F9',
    title: 'UK Rail Map',
    icon: path.join(__dirname, '../../build/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => {
    win = null;
  });
}

// ---------------------------------------------------------------- updates
//
// Checks GitHub Releases on launch, downloads in the background, and never
// restarts on its own — you might be halfway through moving a station.
function setupUpdates() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const say = (state: string, detail?: string | number) =>
    win?.webContents.send('update:state', { state, detail });

  autoUpdater.on('checking-for-update', () => say('checking'));
  autoUpdater.on('update-available', (info) => say('found', info.version));
  autoUpdater.on('update-not-available', () => say('current'));
  autoUpdater.on('download-progress', (p) => say('downloading', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', (info) => {
    say('ready', info.version);
    win?.webContents.send('update:ready', info.version);
  });
  autoUpdater.on('error', (err) => say('error', String(err)));

  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { state: 'dev' };
    try {
      const r = await autoUpdater.checkForUpdates();
      return { state: 'checked', version: r?.updateInfo.version ?? null };
    } catch (err) {
      return { state: 'error', detail: String(err) };
    }
  });

  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {
      /* offline is fine */
    });
    // and again while it is left open, so a release lands without a restart
    setInterval(
      () => {
        autoUpdater.checkForUpdates().catch(() => {});
      },
      30 * 60 * 1000,
    );
  }
}

// ---------------------------------------------------------------- files
ipcMain.handle('project:save', async (_e, json: string, current?: string) => {
  let target = current;
  if (!target) {
    const res = await dialog.showSaveDialog(win!, {
      title: 'Save map',
      defaultPath: 'map.ukrm',
      filters: [{ name: 'UK Rail Map', extensions: ['ukrm'] }],
    });
    if (res.canceled || !res.filePath) return null;
    target = res.filePath;
  }
  await fs.writeFile(target, json, 'utf8');
  return target;
});

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog(win!, {
    title: 'Open map',
    properties: ['openFile'],
    filters: [{ name: 'UK Rail Map', extensions: ['ukrm'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const p = res.filePaths[0];
  return { path: p, json: await fs.readFile(p, 'utf8') };
});

ipcMain.handle('basemap:read', async () => {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'uk-base.svg')
    : path.join(__dirname, '../../assets/uk-base.svg');
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('places:read', async () => {
  const p = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'places.json')
    : path.join(__dirname, '../../assets/places.json');
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as { places: unknown[] };
  } catch {
    return { places: [] };
  }
});

ipcMain.handle('export:svg', async (_e, svg: string) => {
  const res = await dialog.showSaveDialog(win!, {
    title: 'Export SVG',
    defaultPath: 'map.svg',
    filters: [{ name: 'SVG', extensions: ['svg'] }],
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, svg, 'utf8');
  return res.filePath;
});

/** Chromium prints the map straight to a vector PDF, fitted to its content. */
ipcMain.handle('export:pdf', async (_e, svg: string, widthPx: number, heightPx: number) => {
  const res = await dialog.showSaveDialog(win!, {
    title: 'Export PDF',
    defaultPath: 'map.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (res.canceled || !res.filePath) return null;

  const printer = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  const html = `<!doctype html><html><body style="margin:0">${svg}</body></html>`;
  await printer.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const data = await printer.webContents.printToPDF({
    printBackground: true,
    pageSize: { width: widthPx / 96, height: heightPx / 96 },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  printer.destroy();
  await fs.writeFile(res.filePath, data);
  return res.filePath;
});

ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => win?.webContents.send('menu:open') },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => win?.webContents.send('menu:save') },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { role: 'resetZoom' }] },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Project page',
            click: () => shell.openExternal('https://github.com/Steel-Horse-Simulations/uk-rail-map'),
          },
        ],
      },
    ]),
  );
  createWindow();
  setupUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
