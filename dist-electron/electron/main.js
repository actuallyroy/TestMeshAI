import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runEntity, scanProject } from "./services/project-service.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = !app.isPackaged;
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
        return;
    }
    void window.loadFile(path.join(process.cwd(), "dist-web", "index.html"));
}
app.whenReady().then(() => {
    ipcMain.handle("project:pick-path", async () => {
        const result = await dialog.showOpenDialog({
            properties: ["openDirectory"]
        });
        return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle("project:scan", async (_event, projectPath) => {
        return scanProject(projectPath);
    });
    ipcMain.handle("entity:run", async (_event, request) => {
        return runEntity(request);
    });
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
