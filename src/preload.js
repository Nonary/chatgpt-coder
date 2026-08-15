const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('patchwork', {
  chooseRepositories: () => ipcRenderer.invoke('repositories:choose'),
  listWorkspaceRepositories: () => ipcRenderer.invoke('workspace:list'),
  removeWorkspaceRepository: (repositoryPath) => ipcRenderer.invoke('workspace:remove', repositoryPath),
  gitStatus: (repositoryPath) => ipcRenderer.invoke('git:status', repositoryPath),
  gitStage: (repositoryPath, files) => ipcRenderer.invoke('git:stage', repositoryPath, files),
  gitStageAll: (repositoryPath) => ipcRenderer.invoke('git:stage-all', repositoryPath),
  gitUnstage: (repositoryPath, files) => ipcRenderer.invoke('git:unstage', repositoryPath, files),
  gitUnstageAll: (repositoryPath) => ipcRenderer.invoke('git:unstage-all', repositoryPath),
  gitCommit: (repositoryPath, message) => ipcRenderer.invoke('git:commit', repositoryPath, message),
  gitDiff: (repositoryPath, filePath, staged) => ipcRenderer.invoke('git:diff', repositoryPath, filePath, staged),
  createTask: (input) => ipcRenderer.invoke('task:create', input),
  listTasks: () => ipcRenderer.invoke('task:list'),
  getTask: (taskId) => ipcRenderer.invoke('task:get', taskId),
  submitTask: (taskId) => ipcRenderer.invoke('task:submit', taskId),
  copyPrompt: (taskId) => ipcRenderer.invoke('task:copy-prompt', taskId),
  revealPackage: (taskId) => ipcRenderer.invoke('task:reveal-package', taskId),
  importResult: (taskId) => ipcRenderer.invoke('task:import-result', taskId),
  applyTask: (taskId) => ipcRenderer.invoke('task:apply', taskId),
  rollbackTask: (taskId) => ipcRenderer.invoke('task:rollback', taskId),
  revealPath: (targetPath) => ipcRenderer.invoke('path:reveal', targetPath),
  setBrowserBounds: (bounds) => ipcRenderer.invoke('browser:set-bounds', bounds),
  setBrowserVisible: (visible) => ipcRenderer.invoke('browser:set-visible', visible),
  newChat: () => ipcRenderer.invoke('browser:new-chat'),
  reloadBrowser: () => ipcRenderer.invoke('browser:reload'),
  browserBack: () => ipcRenderer.invoke('browser:back'),
  browserForward: () => ipcRenderer.invoke('browser:forward'),
  onTaskEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('task:event', handler);
    return () => ipcRenderer.removeListener('task:event', handler);
  },
});
