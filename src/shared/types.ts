export type EntityKind = "function" | "class-method" | "api-handler" | "module" | "component" | "ui-element" | "state" | "ref" | "effect" | "memo" | "variable";

export interface EntitySummary {
  id: string;
  kind: EntityKind;
  name: string;
  filePath: string;
  exportName?: string;
  params: Array<{ name: string; type?: string }>;
  returnType?: string;
  dependencies: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  type: "imports" | "calls" | "contains";
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
}

export interface RunEntityResult {
  status: "passed" | "failed";
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface DesktopApi {
  pickProjectPath: () => Promise<string | null>;
  scanProject: (projectPath: string) => Promise<ProjectScanResult>;
  runEntity: (request: RunEntityRequest) => Promise<RunEntityResult>;
}
