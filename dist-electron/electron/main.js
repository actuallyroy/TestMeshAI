import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEntity, scanProject, getRuntimeState, setVariable, resetRuntime } from "./services/project-service.js";
import { initComponentStates, getState, resetState, triggerEvent } from "./services/state-simulator.js";
import * as cdp from "./services/cdp-service.js";
import { discoverTargets, launchChromeWithDebugging } from "./services/discovery-service.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;
let lastEntities = [];
function createWindow() {
    const window = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1100,
        minHeight: 760,
        title: "TestMeshAI",
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    if (isDev) {
        void window.loadURL("http://localhost:5173");
        window.webContents.openDevTools({ mode: "detach" });
    }
    else {
        void window.loadFile(path.join(process.cwd(), "dist-web", "index.html"));
    }
    return window;
}
app.whenReady().then(() => {
    const mainWindow = createWindow();
    // ── File-based scanning ──────────────────────────────────
    ipcMain.handle("project:pick-path", async () => {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle("project:scan", async (_event, projectPath) => {
        const result = await scanProject(projectPath);
        lastEntities = result.entities;
        initComponentStates(result.entities, projectPath);
        return result;
    });
    ipcMain.handle("entity:run", async (_event, request) => {
        return runEntity(request);
    });
    ipcMain.handle("runtime:state", async () => {
        return getRuntimeState();
    });
    ipcMain.handle("runtime:set-var", async (_event, filePath, varName, valueJson) => {
        await setVariable(filePath, varName, valueJson);
    });
    ipcMain.handle("runtime:reset", async () => {
        resetRuntime();
    });
    // ── Simulation-based event triggering (fallback) ─────────
    ipcMain.handle("event:trigger", async (_event, request) => {
        try {
            const result = await triggerEvent(request, lastEntities);
            if (!result.success)
                console.error("[event:trigger]", result.error);
            return result;
        }
        catch (err) {
            console.error("[event:trigger]", err);
            return { stateChanges: [], handlerName: "?", success: false, error: String(err) };
        }
    });
    ipcMain.handle("state:get", async (_event, componentId) => {
        return getState(componentId);
    });
    ipcMain.handle("state:reset", async (_event, componentId) => {
        return resetState(componentId);
    });
    // ── Discovery ────────────────────────────────────────────
    ipcMain.handle("discover:targets", async () => {
        return discoverTargets();
    });
    ipcMain.handle("discover:launch-chrome", async (_event, targetUrl, cdpPort) => {
        return launchChromeWithDebugging(targetUrl, cdpPort);
    });
    // ── CDP (Chrome DevTools Protocol) ───────────────────────
    ipcMain.handle("cdp:connect", async (_event, config) => {
        try {
            const result = await cdp.connect(config.host, config.port, config.targetUrl);
            if (result.status === "connected") {
                // Set up state change push notifications
                cdp.setStateChangeCallback((changes) => {
                    mainWindow.webContents.send("cdp:state-changed", changes);
                });
                await cdp.startWatching();
            }
            return cdp.getStatus();
        }
        catch (err) {
            console.error("[cdp:connect]", err);
            return { status: "error", url: "", error: String(err) };
        }
    });
    ipcMain.handle("cdp:disconnect", async () => {
        await cdp.disconnect();
    });
    ipcMain.handle("cdp:status", async () => {
        return cdp.getStatus();
    });
    ipcMain.handle("cdp:scan", async () => {
        const result = await cdp.scanLive();
        lastEntities = result.entities;
        return result;
    });
    ipcMain.handle("cdp:trigger-event", async (_event, entityId, eventName, inputValue) => {
        try {
            return await cdp.triggerEventLive(entityId, eventName, inputValue);
        }
        catch (err) {
            console.error("[cdp:trigger-event]", err);
            return { stateChanges: [], handlerName: eventName, success: false, error: String(err) };
        }
    });
    ipcMain.handle("cdp:get-state", async (_event, componentId) => {
        return await cdp.getStateLive(componentId);
    });
    // ────────────────────────────────────────────────────────
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        app.quit();
});
