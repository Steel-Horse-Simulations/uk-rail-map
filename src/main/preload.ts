import { contextBridge, ipcRenderer } from 'electron';

// the overview window only ever receives
contextBridge.exposeInMainWorld('overview', {
  onData: (cb: (payload: unknown) => void) =>
    ipcRenderer.on('overview:data', (_e, payload) => cb(payload)),
});

contextBridge.exposeInMainWorld('api', {
  openOverview: () => ipcRenderer.invoke('overview:open'),
  closeOverview: () => ipcRenderer.invoke('overview:close'),
  overviewIsOpen: () => ipcRenderer.invoke('overview:isOpen'),
  sendOverview: (payload: unknown) => ipcRenderer.send('overview:data', payload),
  onOverviewClosed: (cb: () => void) => ipcRenderer.on('overview:closed', () => cb()),
  saveProject: (json: string, current?: string) =>
    ipcRenderer.invoke('project:save', json, current),
  openProject: () => ipcRenderer.invoke('project:open'),
  readBasemap: () => ipcRenderer.invoke('basemap:read'),
  exportSvg: (svg: string) => ipcRenderer.invoke('export:svg', svg),
  exportPdf: (svg: string, w: number, h: number) =>
    ipcRenderer.invoke('export:pdf', svg, w, h),
  version: () => ipcRenderer.invoke('app:version'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateReady: (cb: (v: string) => void) =>
    ipcRenderer.on('update:ready', (_e, v) => cb(v)),
  onUpdateState: (cb: (s: { state: string; detail?: string | number }) => void) =>
    ipcRenderer.on('update:state', (_e, s) => cb(s)),
  onMenu: (cb: (what: 'open' | 'save') => void) => {
    ipcRenderer.on('menu:open', () => cb('open'));
    ipcRenderer.on('menu:save', () => cb('save'));
  },
});
