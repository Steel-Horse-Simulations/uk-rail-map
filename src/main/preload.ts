import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  saveProject: (json: string, current?: string) =>
    ipcRenderer.invoke('project:save', json, current),
  openProject: () => ipcRenderer.invoke('project:open'),
  readBasemap: () => ipcRenderer.invoke('basemap:read'),
  readPlaces: () => ipcRenderer.invoke('places:read'),
  exportSvg: (svg: string) => ipcRenderer.invoke('export:svg', svg),
  exportPdf: (svg: string, w: number, h: number) =>
    ipcRenderer.invoke('export:pdf', svg, w, h),
  version: () => ipcRenderer.invoke('app:version'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateReady: (cb: (v: string) => void) =>
    ipcRenderer.on('update:ready', (_e, v) => cb(v)),
  onMenu: (cb: (what: 'open' | 'save') => void) => {
    ipcRenderer.on('menu:open', () => cb('open'));
    ipcRenderer.on('menu:save', () => cb('save'));
  },
});
