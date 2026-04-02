import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopApi,
  CdpConnectionConfig,
  CdpStatusInfo,
  ProjectScanResult,
  RunEntityRequest,
  RunEntityResult,
  TriggerEventRequest,
  TriggerEventResult,
  StateSnapshot,
  StateChange
} from "../shared/types.js";

const api: DesktopApi = {
  // File-based
  pickProjectPath: () => ipcRenderer.invoke("project:pick-path"),
  scanProject: (projectPath: string): Promise<ProjectScanResult> =>
    ipcRenderer.invoke("project:scan", projectPath),
  runEntity: (request: RunEntityRequest): Promise<RunEntityResult> =>
    ipcRenderer.invoke("entity:run", request),
  getRuntimeState: (): Promise<import("../shared/types.js").RuntimeState> =>
    ipcRenderer.invoke("runtime:state"),
  setVariable: (filePath: string, varName: string, valueJson: string): Promise<void> =>
    ipcRenderer.invoke("runtime:set-var", filePath, varName, valueJson),
  resetRuntime: (): Promise<void> =>
    ipcRenderer.invoke("runtime:reset"),
  triggerEvent: (request: TriggerEventRequest): Promise<TriggerEventResult> =>
    ipcRenderer.invoke("event:trigger", request),
  getState: (componentId: string): Promise<StateSnapshot> =>
    ipcRenderer.invoke("state:get", componentId),
  resetState: (componentId: string): Promise<StateSnapshot> =>
    ipcRenderer.invoke("state:reset", componentId),

  // Discovery
  discoverTargets: (): Promise<import("../shared/types.js").DiscoveredTarget[]> =>
    ipcRenderer.invoke("discover:targets"),
  launchChrome: (targetUrl: string, cdpPort = 9222): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("discover:launch-chrome", targetUrl, cdpPort),

  // CDP
  connectCdp: (config: CdpConnectionConfig): Promise<CdpStatusInfo> =>
    ipcRenderer.invoke("cdp:connect", config),
  disconnectCdp: (): Promise<void> =>
    ipcRenderer.invoke("cdp:disconnect"),
  getCdpStatus: (): Promise<CdpStatusInfo> =>
    ipcRenderer.invoke("cdp:status"),
  scanLive: (): Promise<ProjectScanResult> =>
    ipcRenderer.invoke("cdp:scan"),
  triggerEventLive: (entityId: string, eventName: string, inputValue?: string): Promise<TriggerEventResult> =>
    ipcRenderer.invoke("cdp:trigger-event", entityId, eventName, inputValue),
  getStateLive: (componentId: string): Promise<StateSnapshot> =>
    ipcRenderer.invoke("cdp:get-state", componentId),
};

contextBridge.exposeInMainWorld("desktop", api);
