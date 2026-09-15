const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  getVersion: () => ipcRenderer.invoke('get-version'),

  /* Over-the-air updates. `onState` returns its own unsubscribe rather than
     exposing ipcRenderer — a renderer that could remove arbitrary listeners
     could silence channels it does not own. */
  update: {
    getState: ()  => ipcRenderer.invoke('update:get-state'),
    checkNow: ()  => ipcRenderer.invoke('update:check-now'),
    onState: (cb) => {
      const handler = (_e, state) => cb(state);
      ipcRenderer.on('update:state', handler);
      return () => ipcRenderer.removeListener('update:state', handler);
    },
  },
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
