import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopApi,
  ProjectScanResult,
  RunEntityRequest,
  RunEntityResult
} from "../shared/types.js";

const api: DesktopApi = {
  pickProjectPath: () => ipcRenderer.invoke("project:pick-path"),
  scanProject: (projectPath: string): Promise<ProjectScanResult> =>
    ipcRenderer.invoke("project:scan", projectPath),
  runEntity: (request: RunEntityRequest): Promise<RunEntityResult> =>
    ipcRenderer.invoke("entity:run", request)
};

contextBridge.exposeInMainWorld("desktop", api);
