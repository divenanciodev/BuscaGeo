const { contextBridge, ipcRenderer } = require('electron');

const buscaGeo = {};

buscaGeo.loadState = function () {
  return ipcRenderer.invoke('load-state');
};

buscaGeo.selectFolders = function () {
  return ipcRenderer.invoke('select-folders');
};

buscaGeo.selectDirectFolders = function () {
  return ipcRenderer.invoke('select-direct-folders');
};

buscaGeo.getComputerRoots = function () {
  return ipcRenderer.invoke('get-computer-roots');
};

buscaGeo.saveAIConfig = function (config) {
  return ipcRenderer.invoke('save-ai-config', config);
};

buscaGeo.interpretSearch = function (text, requestId) {
  return ipcRenderer.invoke('interpret-search', text, requestId);
};

buscaGeo.answerDocuments = function (question, roots, requestId) {
  return ipcRenderer.invoke('answer-documents', question, roots, requestId);
};

buscaGeo.testAIConnection = function () {
  return ipcRenderer.invoke('test-ai-connection');
};

buscaGeo.removeRoot = function (root) {
  return ipcRenderer.invoke('remove-root', root);
};

buscaGeo.setKeepIndex = function (keep) {
  return ipcRenderer.invoke('set-keep-index', keep);
};

buscaGeo.setWatchEnabled = function (enabled) {
  return ipcRenderer.invoke('set-watch-enabled', enabled);
};

buscaGeo.deleteLegacyIndex = function () {
  return ipcRenderer.invoke('delete-legacy-index');
};

buscaGeo.selectReferenceFolder = function () {
  return ipcRenderer.invoke('select-reference-folder');
};

buscaGeo.saveReference = function (reference) {
  return ipcRenderer.invoke('save-reference', reference);
};

buscaGeo.deleteReference = function (id) {
  return ipcRenderer.invoke('delete-reference', id);
};

buscaGeo.scan = function () {
  return ipcRenderer.invoke('scan');
};

buscaGeo.cancelScan = function () {
  return ipcRenderer.invoke('cancel-catalog-scan');
};

buscaGeo.searchFiles = function (filters) {
  return ipcRenderer.invoke('search-files', filters);
};

buscaGeo.startDirectSearch = function (filters) {
  return ipcRenderer.invoke('start-direct-search', filters);
};

buscaGeo.cancelDirectSearch = function (requestId) {
  return ipcRenderer.invoke('cancel-direct-search', requestId);
};

buscaGeo.openPath = function (filePath) {
  return ipcRenderer.invoke('open-path', filePath);
};

buscaGeo.revealPath = function (filePath) {
  return ipcRenderer.invoke('reveal-path', filePath);
};

buscaGeo.exportCsv = function (rows) {
  return ipcRenderer.invoke('export-csv', rows);
};

buscaGeo.onScanProgress = function (callback) {
  ipcRenderer.on('scan-progress', function (event, payload) {
    callback(payload);
  });
};

buscaGeo.onDirectSearchUpdate = function (callback) {
  ipcRenderer.on('direct-search-update', function (event, payload) {
    callback(payload);
  });
};

contextBridge.exposeInMainWorld('buscaGeo', buscaGeo);