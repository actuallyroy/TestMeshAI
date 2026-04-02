"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    // File-based
    pickProjectPath: () => electron_1.ipcRenderer.invoke("project:pick-path"),
    scanProject: (projectPath) => electron_1.ipcRenderer.invoke("project:scan", projectPath),
    runEntity: (request) => electron_1.ipcRenderer.invoke("entity:run", request),
    getRuntimeState: () => electron_1.ipcRenderer.invoke("runtime:state"),
    setVariable: (filePath, varName, valueJson) => electron_1.ipcRenderer.invoke("runtime:set-var", filePath, varName, valueJson),
    resetRuntime: () => electron_1.ipcRenderer.invoke("runtime:reset"),
    triggerEvent: (request) => electron_1.ipcRenderer.invoke("event:trigger", request),
    getState: (componentId) => electron_1.ipcRenderer.invoke("state:get", componentId),
    resetState: (componentId) => electron_1.ipcRenderer.invoke("state:reset", componentId),
    // Discovery
    discoverTargets: () => electron_1.ipcRenderer.invoke("discover:targets"),
    launchChrome: (targetUrl, cdpPort = 9222) => electron_1.ipcRenderer.invoke("discover:launch-chrome", targetUrl, cdpPort),
    // CDP
    connectCdp: (config) => electron_1.ipcRenderer.invoke("cdp:connect", config),
    disconnectCdp: () => electron_1.ipcRenderer.invoke("cdp:disconnect"),
    getCdpStatus: () => electron_1.ipcRenderer.invoke("cdp:status"),
    scanLive: () => electron_1.ipcRenderer.invoke("cdp:scan"),
    triggerEventLive: (entityId, eventName, inputValue) => electron_1.ipcRenderer.invoke("cdp:trigger-event", entityId, eventName, inputValue),
    getStateLive: (componentId) => electron_1.ipcRenderer.invoke("cdp:get-state", componentId),
};
electron_1.contextBridge.exposeInMainWorld("desktop", api);
