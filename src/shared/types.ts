export type EntityKind = "function" | "class" | "class-method" | "api-handler" | "module" | "component" | "ui-element" | "state" | "ref" | "effect" | "memo" | "variable";

export interface EventHandlerInfo {
  eventName: string;        // "onClick", "onChange", etc.
  handlerName: string;      // "handleSubmit" or inline expression snippet
  targetStateIds: string[]; // state entity IDs this handler modifies
  setterPatterns: SetterPattern[]; // how each setter is called
}

export interface SetterPattern {
  setterName: string;
  stateEntityId: string;
  pattern: "direct" | "event-target" | "toggle" | "increment" | "functional" | "unknown";
  literalValue?: unknown;    // for "direct" pattern
  expression?: string;       // raw expression text
  /** "sync" = before any await, "async" = after an await (depends on runtime result) */
  phase?: "sync" | "async";
}

export interface EntitySummary {
  id: string;
  kind: EntityKind;
  name: string;
  filePath: string;
  exportName?: string;
  params: Array<{ name: string; type?: string }>;
  returnType?: string;
  dependencies: string[];
  /** Only for ui-element: event handlers and what state they modify */
  eventHandlers?: EventHandlerInfo[];
  /** Only for state: the setter function name */
  setterName?: string;
  /** Only for state: the initial value as a string */
  initialValue?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "imports" | "calls" | "contains" | "triggers";
}

export interface ProjectScanResult {
  projectPath: string;
  entityCount: number;
  entities: EntitySummary[];
  edges: GraphEdge[];
}

export interface RunEntityRequest {
  entityId: string;
  inputJson: string;
  /** For class-method: which instance to call on (by instanceId) */
  instanceId?: string;
}

export interface RunEntityResult {
  status: "passed" | "failed";
  output?: unknown;
  error?: string;
  durationMs: number;
  /** If a class was constructed, the new instance ID */
  instanceId?: string;
  /** Updated module state after execution */
  moduleState?: Record<string, unknown>;
}

/** A live class instance in the runtime */
export interface LiveInstance {
  instanceId: string;
  className: string;
  properties: Record<string, unknown>;
  filePath: string;
}

export interface RuntimeState {
  /** Module-level exported variables and their current values */
  moduleVariables: Record<string, Record<string, unknown>>; // filePath → { varName: value }
  /** Live class instances */
  instances: LiveInstance[];
}

export interface TriggerEventRequest {
  componentId: string;
  uiElementId: string;
  eventName: string;
  inputValue?: string;
}

export interface StateChange {
  stateEntityId: string;
  variableName: string;
  previousValue: unknown;
  newValue: unknown;
  setterExpression: string;
}

export interface TriggerEventResult {
  stateChanges: StateChange[];
  handlerName: string;
  success: boolean;
  error?: string;
}

export interface StateSnapshot {
  componentId: string;
  variables: Array<{
    stateEntityId: string;
    variableName: string;
    currentValue: unknown;
    initialValue: unknown;
    type: string;
  }>;
}

export interface CdpConnectionConfig {
  host: string;
  port: number;
  targetUrl?: string;
}

export type CdpStatus = "disconnected" | "connecting" | "connected" | "error";

export interface CdpStatusInfo {
  status: CdpStatus;
  url: string;
  error?: string;
}

export interface DiscoveredTarget {
  type: "cdp" | "devserver";
  host: string;
  port: number;
  url?: string;
  title?: string;
  framework?: string;
}

export interface DesktopApi {
  pickProjectPath: () => Promise<string | null>;
  scanProject: (projectPath: string) => Promise<ProjectScanResult>;
  runEntity: (request: RunEntityRequest) => Promise<RunEntityResult>;
  getRuntimeState: () => Promise<RuntimeState>;
  setVariable: (filePath: string, varName: string, valueJson: string) => Promise<void>;
  resetRuntime: () => Promise<void>;
  triggerEvent: (request: TriggerEventRequest) => Promise<TriggerEventResult>;
  getState: (componentId: string) => Promise<StateSnapshot>;
  resetState: (componentId: string) => Promise<StateSnapshot>;
  // Discovery
  discoverTargets: () => Promise<DiscoveredTarget[]>;
  launchChrome: (targetUrl: string, cdpPort?: number) => Promise<{ success: boolean; error?: string }>;
  // CDP
  connectCdp: (config: CdpConnectionConfig) => Promise<CdpStatusInfo>;
  disconnectCdp: () => Promise<void>;
  getCdpStatus: () => Promise<CdpStatusInfo>;
  scanLive: () => Promise<ProjectScanResult>;
  triggerEventLive: (entityId: string, eventName: string, inputValue?: string) => Promise<TriggerEventResult>;
  getStateLive: (componentId: string) => Promise<StateSnapshot>;
}
