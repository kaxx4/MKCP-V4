const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getVersion: () => ipcRenderer.invoke('get-version'),
  isElectron: true,
  discountRules: {
    load:   ()         => ipcRenderer.invoke('discount-rules:load'),
    save:   (payload)  => ipcRenderer.invoke('discount-rules:save', payload),
    export: (payload)  => ipcRenderer.invoke('discount-rules:export', payload),
    import: ()         => ipcRenderer.invoke('discount-rules:import'),
  },
  pickSyncFolder: () => ipcRenderer.invoke('pick-sync-folder'),
  pickWatchFolder: () => ipcRenderer.invoke('pick-watch-folder'),
  pickFileToPush: () => ipcRenderer.invoke('pick-file-to-push'),
});
