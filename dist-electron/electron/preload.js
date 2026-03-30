"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    pickProjectPath: () => electron_1.ipcRenderer.invoke("project:pick-path"),
    scanProject: (projectPath) => electron_1.ipcRenderer.invoke("project:scan", projectPath),
    runEntity: (request) => electron_1.ipcRenderer.invoke("entity:run", request)
};
electron_1.contextBridge.exposeInMainWorld("desktop", api);
