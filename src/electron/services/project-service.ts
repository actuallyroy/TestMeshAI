import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type {
  EntitySummary,
  EventHandlerInfo,
  GraphEdge,
  ProjectScanResult,
  RunEntityRequest,
  RunEntityResult,
  SetterPattern
} from "../../shared/types.js";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

let lastScan: ProjectScanResult | null = null;

// ── Scanning ────────────────────────────────────────────────

export async function scanProject(projectPath: string): Promise<ProjectScanResult> {
  const files = await collectFiles(projectPath);
  const entities: EntitySummary[] = [];
  const fileImports = new Map<string, ImportInfo[]>();
  const sourceFiles = new Map<string, ts.SourceFile>();

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const relativePath = path.relative(projectPath, filePath);
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);

    entities.push(...extractEntities(sourceFile, relativePath));
    fileImports.set(relativePath, extractImports(sourceFile, relativePath, projectPath, files));
    sourceFiles.set(relativePath, sourceFile);
  }

  const edges = buildEdges(entities, fileImports, sourceFiles);

  const result: ProjectScanResult = {
    projectPath,
    entityCount: entities.length,
    entities,
    edges
  };

  lastScan = result;
  return result;
}

// ── Entity extraction via AST ───────────────────────────────

function extractEntities(sourceFile: ts.SourceFile, relativePath: string): EntitySummary[] {
  const entities: EntitySummary[] = [];

  function visit(node: ts.Node): void {
    // export function Foo(...) — detect if it's a React component (returns JSX)
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      const name = node.name.text;
      if (isComponentName(name) && containsJsx(node)) {
        entities.push(buildComponentEntity(relativePath, name, node.parameters));
      } else {
        entities.push(buildFunctionEntity(relativePath, name, node.parameters, node.type));
      }
    }

    // export const Foo = (...) => ... — detect component vs plain function
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;

        const init = decl.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          const name = decl.name.text;
          if (isComponentName(name) && containsJsx(init)) {
            entities.push(buildComponentEntity(relativePath, name, init.parameters));
          } else {
            entities.push(buildFunctionEntity(relativePath, name, init.parameters, init.type));
          }
        }
      }
    }

    // export class Foo { ... } – extract class + methods
    if (ts.isClassDeclaration(node) && node.name && hasExportModifier(node)) {
      const className = node.name.text;
      const classId = `${relativePath}#${className}`;

      // Extract constructor params for the class entity
      const ctor = node.members.find(ts.isConstructorDeclaration);
      const classParams = ctor ? parseParameters(ctor.parameters) : [];

      // Class entity
      entities.push({
        id: classId,
        kind: "class",
        name: className,
        filePath: relativePath,
        exportName: className,
        params: classParams,
        dependencies: []
      });

      // Methods as children
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.name &&
          ts.isIdentifier(member.name) &&
          hasPublicVisibility(member)
        ) {
          const methodId = `${relativePath}#${className}.${member.name.text}`;
          entities.push({
            id: methodId,
            kind: "class-method",
            name: `${className}.${member.name.text}`,
            filePath: relativePath,
            exportName: className,
            params: parseParameters(member.parameters),
            returnType: member.type ? member.type.getText() : undefined,
            dependencies: []
          });
          // Class contains this method
          const classEntity = entities.find((e) => e.id === classId);
          if (classEntity) classEntity.dependencies.push(methodId);
        }
      }
    }

    // Express-style: app.get("/path", handler) / router.post("/path", handler)
    if (
      ts.isExpressionStatement(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression)
    ) {
      const propAccess = node.expression.expression;
      const methodName = propAccess.name.text;
      const httpMethods = ["get", "post", "put", "patch", "delete", "all", "use"];

      if (httpMethods.includes(methodName) && node.expression.arguments.length >= 2) {
        const routeArg = node.expression.arguments[0];
        if (ts.isStringLiteral(routeArg)) {
          const routePath = routeArg.text;
          const callerName = propAccess.expression.getText(sourceFile);
          const name = `${methodName.toUpperCase()} ${routePath}`;
          entities.push({
            id: `${relativePath}#${callerName}.${methodName}:${routePath}`,
            kind: "api-handler",
            name,
            filePath: relativePath,
            exportName: undefined,
            params: [{ name: "req" }, { name: "res" }],
            returnType: undefined,
            dependencies: []
          });
        }
      }
    }

    // Next.js API routes: export default function handler(req, res)
    // or export async function GET/POST/PUT/DELETE(request)
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      // export default ...
      const expr = node.expression;
      if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
        const name = "default handler";
        entities.push({
          id: `${relativePath}#default`,
          kind: "api-handler",
          name,
          filePath: relativePath,
          exportName: "default",
          params: parseParameters(expr.parameters),
          returnType: expr.type ? expr.type.getText() : undefined,
          dependencies: []
        });
      }
    }

    // Named export matching Next.js App Router pattern: export async function GET(...)
    if (ts.isFunctionDeclaration(node) && node.name && hasExportModifier(node)) {
      const fnName = node.name.text;
      const appRouterMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
      if (appRouterMethods.includes(fnName)) {
        // Already added as function above — upgrade kind to api-handler
        const existing = entities.find((e) => e.id === `${relativePath}#${fnName}`);
        if (existing) {
          existing.kind = "api-handler";
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // For each component, extract hooks, state, UI elements, and event flows
  const componentEntities = entities.filter((e) => e.kind === "component");
  for (const comp of componentEntities) {
    // 1. Extract hooks first (we need setter names for event tracing)
    const hooks = extractHooksFromSource(sourceFile, comp.exportName!);
    const setterToStateId = new Map<string, string>(); // setterName → state entity ID

    for (const hook of hooks) {
      const hookId = `${relativePath}#${comp.exportName}.${hook.label}`;
      if (!entities.some((e) => e.id === hookId)) {
        entities.push({
          id: hookId,
          kind: hook.kind,
          name: hook.displayName,
          filePath: relativePath,
          exportName: undefined,
          params: hook.params,
          returnType: hook.returnType,
          dependencies: [],
          setterName: hook.setterName,
          initialValue: hook.initialValue
        });
        comp.dependencies.push(hookId);
      }
      // Build setter → state ID map
      if (hook.kind === "state" && hook.setterName) {
        setterToStateId.set(hook.setterName, hookId);
      }
    }

    // 2. Extract UI elements with raw event handler info
    const uiElements = extractUiElementsFromSource(sourceFile, comp.exportName!);
    const funcBody = findExportedFunctionBody(sourceFile, comp.exportName!);
    const localHandlers = funcBody ? collectLocalHandlers(funcBody, sourceFile) : new Map<string, ts.Node>();

    for (const el of uiElements) {
      const uiId = `${relativePath}#${comp.exportName}.${el.tag}:${el.label}`;
      if (entities.some((e) => e.id === uiId)) continue;

      // 3. Trace event handlers → state setters
      const eventHandlers: EventHandlerInfo[] = [];
      for (const [eventName, handlerExpr] of Object.entries(el.eventHandlers)) {
        const info = traceEventHandler(
          eventName, handlerExpr, localHandlers, setterToStateId, sourceFile
        );
        if (info) eventHandlers.push(info);
      }

      entities.push({
        id: uiId,
        kind: "ui-element",
        name: el.displayName,
        filePath: relativePath,
        exportName: undefined,
        params: getUiElementActions(el.tag),
        returnType: undefined,
        dependencies: [],
        eventHandlers: eventHandlers.length > 0 ? eventHandlers : undefined
      });
      comp.dependencies.push(uiId);
    }
  }

  // Exported variables / constants (outside components)
  extractExportedVariables(sourceFile, relativePath, entities);

  return entities;
}

// ── Import / dependency edge extraction ─────────────────────

interface ImportInfo {
  /** Resolved relative path of the imported file */
  resolvedPath: string;
  /** Specific named imports: import { foo, bar } from '...' */
  namedImports: string[];
  /** Has a default import: import Foo from '...' */
  hasDefault: boolean;
  /** Has namespace import: import * as Foo from '...' */
  hasNamespace: boolean;
}

function extractImports(
  sourceFile: ts.SourceFile,
  relativePath: string,
  projectPath: string,
  allFiles: string[]
): ImportInfo[] {
  const imports: ImportInfo[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    const specifier = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;

    const raw = specifier.text;
    if (!raw.startsWith(".")) continue;

    const dir = path.dirname(path.join(projectPath, relativePath));
    const resolved = resolveLocalImport(dir, raw, projectPath, allFiles);
    if (!resolved) continue;

    const namedImports: string[] = [];
    let hasDefault = false;
    let hasNamespace = false;

    const importClause = stmt.importClause;
    if (importClause) {
      // import Foo from '...'
      if (importClause.name) hasDefault = true;

      const bindings = importClause.namedBindings;
      if (bindings) {
        if (ts.isNamedImports(bindings)) {
          // import { foo, bar } from '...'
          for (const el of bindings.elements) {
            // Use the original name (propertyName) if aliased, otherwise the name
            const originalName = el.propertyName ? el.propertyName.text : el.name.text;
            namedImports.push(originalName);
          }
        } else if (ts.isNamespaceImport(bindings)) {
          // import * as X from '...'
          hasNamespace = true;
        }
      }
    }

    imports.push({ resolvedPath: resolved, namedImports, hasDefault, hasNamespace });
  }

  return imports;
}

function resolveLocalImport(
  fromDir: string,
  specifier: string,
  projectPath: string,
  allFiles: string[]
): string | null {
  const abs = path.resolve(fromDir, specifier);
  const candidates = [
    abs,
    ...Array.from(SUPPORTED_EXTENSIONS).map((ext) => abs + ext),
    ...Array.from(SUPPORTED_EXTENSIONS).map((ext) => path.join(abs, "index" + ext))
  ];

  for (const candidate of candidates) {
    if (allFiles.includes(candidate)) {
      return path.relative(projectPath, candidate);
    }
  }

  return null;
}

function buildEdges(
  entities: EntitySummary[],
  fileImports: Map<string, ImportInfo[]>,
  sourceFiles: Map<string, ts.SourceFile>
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  function addEdge(fromId: string, toId: string, type: GraphEdge["type"]): void {
    const key = `${fromId}→${toId}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from: fromId, to: toId, type });
    const fromEntity = entities.find((e) => e.id === fromId);
    if (fromEntity) fromEntity.dependencies.push(toId);
  }

  const CHILD_KINDS = new Set(["ui-element", "state", "ref", "effect", "memo"]);

  // Build a map: for each file, which imported names map to which entity IDs
  // e.g. services.ts: { "User" -> "models.ts#User", "formatCurrency" -> "utils.ts#formatCurrency" }
  const fileImportMap = new Map<string, Map<string, string>>(); // filePath -> (importedName -> entityId)

  for (const [fromFile, importList] of fileImports) {
    const nameToEntityId = new Map<string, string>();

    for (const imp of importList) {
      const toFile = imp.resolvedPath;
      const toEntities = entities.filter((e) => e.filePath === toFile && !CHILD_KINDS.has(e.kind));

      for (const importedName of imp.namedImports) {
        const targetEntity = toEntities.find((e) => e.exportName === importedName);
        if (targetEntity) nameToEntityId.set(importedName, targetEntity.id);
      }
      if (imp.hasDefault) {
        const defaultEntity = toEntities.find((e) => e.exportName === "default");
        if (defaultEntity) nameToEntityId.set("default", defaultEntity.id);
      }
    }

    fileImportMap.set(fromFile, nameToEntityId);
  }

  // For each function/class-method entity, scan its AST body for references to imported names
  for (const entity of entities) {
    if (CHILD_KINDS.has(entity.kind)) continue;

    const sourceFile = sourceFiles.get(entity.filePath);
    const importNames = fileImportMap.get(entity.filePath);
    if (!sourceFile || !importNames || importNames.size === 0) continue;

    // Find this entity's AST node
    const node = findEntityNode(sourceFile, entity);
    if (!node) continue;

    // Collect all identifiers used in this node's body
    const usedNames = new Set<string>();
    collectIdentifiers(node, usedNames);

    // Create edges only for names this entity actually references
    for (const [name, targetId] of importNames) {
      if (usedNames.has(name)) {
        // Data flow direction: dependency flows INTO the caller
        addEdge(targetId, entity.id, "calls");
      }
    }
  }

  // Contains edges: class → methods, component → children
  for (const entity of entities) {
    if (entity.kind === "class") {
      for (const depId of entity.dependencies) {
        const dep = entities.find((e) => e.id === depId);
        if (dep && dep.kind === "class-method") {
          const key = `${entity.id}→${dep.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from: entity.id, to: dep.id, type: "contains" });
          }
        }
      }
    }
  }

  for (const entity of entities) {
    if (entity.kind === "component") {
      for (const depId of entity.dependencies) {
        const dep = entities.find((e) => e.id === depId);
        if (dep && (dep.kind === "ui-element" || dep.kind === "state" || dep.kind === "ref" || dep.kind === "effect" || dep.kind === "memo")) {
          const key = `${entity.id}→${dep.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from: entity.id, to: dep.id, type: "contains" });
          }
        }
      }
    }
  }

  // Triggers edges: ui-element → state (from event handler tracing)
  for (const entity of entities) {
    if (entity.kind === "ui-element" && entity.eventHandlers) {
      for (const handler of entity.eventHandlers) {
        for (const stateId of handler.targetStateIds) {
          addEdge(entity.id, stateId, "triggers");
        }
      }
    }
  }

  return edges;
}

// ── Persistent Runtime ──────────────────────────────────────

/** Cached modules — state persists between calls */
const moduleCache = new Map<string, Record<string, unknown>>();
/** Live class instances */
const liveInstances = new Map<string, { className: string; instance: Record<string, unknown>; filePath: string }>();
let instanceCounter = 0;

export async function resetRuntime(): Promise<void> {
  moduleCache.clear();
  liveInstances.clear();
  instanceCounter = 0;
}

async function getOrLoadModule(modulePath: string): Promise<Record<string, unknown>> {
  if (moduleCache.has(modulePath)) return moduleCache.get(modulePath)!;
  const mod = await loadModule(modulePath);
  moduleCache.set(modulePath, mod);
  return mod;
}

export function getRuntimeState(): import("../../shared/types.js").RuntimeState {
  const moduleVariables: Record<string, Record<string, unknown>> = {};

  for (const [modPath, mod] of moduleCache) {
    const vars: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(mod)) {
      if (typeof value === "function") continue; // skip functions/classes
      try {
        // Ensure serializable
        JSON.stringify(value);
        vars[key] = value;
      } catch {
        vars[key] = String(value);
      }
    }
    // Get relative path from lastScan
    const relPath = lastScan ? path.relative(path.resolve(lastScan.projectPath), modPath) : modPath;
    if (Object.keys(vars).length > 0) moduleVariables[relPath] = vars;
  }

  const instances = Array.from(liveInstances.entries()).map(([id, info]) => {
    const props = safeSerialize(info.instance) as Record<string, unknown>;
    delete props.__class; // Don't duplicate the class name
    return { instanceId: id, className: info.className, properties: props, filePath: info.filePath };
  });

  return { moduleVariables, instances };
}

export async function setVariable(filePath: string, varName: string, valueJson: string): Promise<void> {
  if (!lastScan) throw new Error("No project scanned");
  const modulePath = path.resolve(lastScan.projectPath, filePath);
  const mod = await getOrLoadModule(modulePath);
  const parsed = JSON.parse(valueJson);
  (mod as Record<string, unknown>)[varName] = parsed;
}

export async function runEntity(request: RunEntityRequest): Promise<RunEntityResult> {
  const startedAt = Date.now();

  try {
    if (!lastScan) throw new Error("No project has been scanned yet.");

    const entity = lastScan.entities.find((item) => item.id === request.entityId);
    if (!entity) throw new Error(`Entity not found: ${request.entityId}`);

    // Parse args, resolving instance references like User_1, Product_1
    const args = resolveArgs(request.inputJson);
    const modulePath = path.resolve(lastScan.projectPath, entity.filePath);

    // Load the module (cached — objects stay alive)
    const loadedModule = await getOrLoadModule(modulePath);
    const target = entity.exportName ? loadedModule[entity.exportName] : undefined;

    if (typeof target !== "function") {
      throw new Error(`"${entity.exportName}" is not a function in the loaded module.`);
    }

    let output: unknown;
    let instanceId: string | undefined;

    if (entity.kind === "class-method" && entity.name.includes(".")) {
      const methodName = entity.name.split(".")[1];

      if (request.instanceId && liveInstances.has(request.instanceId)) {
        // Call method on existing live instance
        const info = liveInstances.get(request.instanceId)!;
        const method = (info.instance as Record<string, unknown>)[methodName];
        if (typeof method !== "function") throw new Error(`Method "${methodName}" not found on instance`);
        output = await (method as Function).apply(info.instance, args);
        instanceId = request.instanceId;
      } else {
        // Construct new instance, then call method
        const instance = new (target as new (...a: unknown[]) => Record<string, unknown>)(...args);
        instanceId = `${entity.exportName}_${++instanceCounter}`;
        liveInstances.set(instanceId, { className: entity.exportName ?? "Unknown", instance, filePath: entity.filePath });
        const method = instance[methodName];
        if (typeof method === "function") {
          output = await (method as Function).call(instance);
        } else {
          output = instance;
        }
      }
    } else if (entity.kind === "class") {
      // Construct class instance — stays alive with full prototype
      const instance = new (target as new (...a: unknown[]) => Record<string, unknown>)(...args);
      instanceId = `${entity.exportName}_${++instanceCounter}`;
      liveInstances.set(instanceId, { className: entity.exportName ?? "Unknown", instance, filePath: entity.filePath });
      output = instance;
    } else {
      // Regular function call
      output = await target(...args);
      // Auto-register if result is a class instance
      if (output && typeof output === "object" && output.constructor && output.constructor.name !== "Object" && output.constructor.name !== "Array") {
        instanceId = `${output.constructor.name}_${++instanceCounter}`;
        liveInstances.set(instanceId, { className: output.constructor.name, instance: output as Record<string, unknown>, filePath: entity.filePath });
      }
    }

    // Capture module state from ALL cached modules
    const moduleState: Record<string, unknown> = {};
    for (const [modPath, mod] of moduleCache) {
      const relPath = lastScan ? path.relative(path.resolve(lastScan.projectPath), modPath) : modPath;
      const vars: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(mod)) {
        if (typeof value === "function") continue;
        try { JSON.stringify(value); vars[key] = safeSerialize(value); } catch { vars[key] = String(value); }
      }
      if (Object.keys(vars).length > 0) moduleState[relPath] = vars;
    }

    return {
      status: "passed",
      output: safeSerialize(output),
      durationMs: Date.now() - startedAt,
      instanceId,
      moduleState,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  }
}

/**
 * Resolve instance references in JSON input.
 * Replaces bare instance IDs like User_1, Product_1 with their serialized data.
 * Works in strings: [User_1, [{"product": Product_1, "quantity": 1}]]
 */
/**
 * Parse JSON input, resolving instance references.
 * "User_1" or "Product_1" in the JSON become live object references.
 * Input like: [User_1, [{"product": Product_1, "quantity": 1}]]
 * First replace refs with placeholder strings, parse JSON, then swap placeholders for real objects.
 */
function resolveArgs(inputJson: string): unknown[] {
  // Strip /* comments */ and // line comments
  const stripped = inputJson.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").trim();

  if (liveInstances.size === 0) {
    const parsed = JSON.parse(stripped);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  // Replace instance refs with placeholder strings (outside of quoted strings)
  const placeholders = new Map<string, Record<string, unknown>>();
  let processed = stripped;

  // Sort instance IDs by length descending
  const sortedIds = Array.from(liveInstances.keys()).sort((a, b) => b.length - a.length);

  // Tokenize to avoid replacing inside quoted strings
  const parts: Array<{ text: string; quoted: boolean }> = [];
  let i = 0;
  while (i < processed.length) {
    if (processed[i] === '"') {
      let j = i + 1;
      while (j < processed.length && !(processed[j] === '"' && processed[j - 1] !== '\\')) j++;
      parts.push({ text: processed.slice(i, j + 1), quoted: true });
      i = j + 1;
    } else {
      let j = i;
      while (j < processed.length && processed[j] !== '"') j++;
      parts.push({ text: processed.slice(i, j), quoted: false });
      i = j;
    }
  }

  // Replace instance IDs in non-quoted parts with placeholder strings
  for (const part of parts) {
    if (part.quoted) continue;
    for (const instId of sortedIds) {
      if (part.text.includes(instId)) {
        const placeholder = `"__INST_${instId}__"`;
        placeholders.set(`__INST_${instId}__`, liveInstances.get(instId)!.instance);
        part.text = part.text.split(instId).join(placeholder);
      }
    }
  }

  const resolvedJson = parts.map(p => p.text).join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolvedJson);
  } catch {
    // Fallback: try stripped
    parsed = JSON.parse(stripped);
  }

  // Deep-walk the parsed result and swap placeholder strings for live objects
  function swapPlaceholders(val: unknown): unknown {
    if (typeof val === "string" && placeholders.has(val)) {
      return placeholders.get(val);
    }
    if (Array.isArray(val)) {
      return val.map(swapPlaceholders);
    }
    if (val && typeof val === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        result[k] = swapPlaceholders(v);
      }
      return result;
    }
    return val;
  }

  const resolved = swapPlaceholders(parsed);
  return Array.isArray(resolved) ? resolved : [resolved];
}

/** Safely serialize a value for IPC (handles class instances, dates, functions) */
function safeSerialize(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
  if (typeof val === "function") return `[Function: ${val.name}]`;
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val)) return val.map(safeSerialize);
  if (typeof val === "object") {
    const className = val.constructor?.name;
    const result: Record<string, unknown> = {};
    if (className && className !== "Object") result.__class = className;
    for (const [k, v] of Object.entries(val)) {
      result[k] = safeSerialize(v);
    }
    return result;
  }
  return String(val);
}

// ── TS execution — in-process via tsx CJS register ──────────
// tsx hooks into require() so any .ts file can be loaded directly.
// Objects stay alive in memory with full prototypes.

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
let tsxRegistered = false;

async function loadModule(modulePath: string): Promise<Record<string, unknown>> {
  if (!tsxRegistered) {
    try {
      const tsxApi = _require("tsx/cjs/api") as { register: () => void };
      tsxApi.register();
    } catch (e) {
      console.error("Failed to register tsx:", e);
    }
    tsxRegistered = true;
  }
  return _require(modulePath) as Record<string, unknown>;
}

// ── Hook extraction ─────────────────────────────────────────

interface HookInfo {
  kind: "state" | "ref" | "effect" | "memo";
  label: string;
  displayName: string;
  params: Array<{ name: string; type?: string }>;
  returnType?: string;
  setterName?: string;
  initialValue?: string;
}

const HOOK_KIND_MAP: Record<string, HookInfo["kind"]> = {
  useState: "state",
  useReducer: "state",
  useRef: "ref",
  useEffect: "effect",
  useLayoutEffect: "effect",
  useMemo: "memo",
  useCallback: "memo",
};

function extractHooksFromSource(sourceFile: ts.SourceFile, componentName: string): HookInfo[] {
  const funcNode = findExportedFunctionBody(sourceFile, componentName);
  if (!funcNode) return [];

  const hooks: HookInfo[] = [];
  const counters = new Map<string, number>();

  function walk(node: ts.Node): void {
    // Look for: const [x, setX] = useState(...) or const x = useRef(...)
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const callExpr = node.initializer;
      const callee = callExpr.expression.getText(sourceFile);
      const hookKind = HOOK_KIND_MAP[callee];

      if (hookKind) {
        const info = buildHookInfo(hookKind, callee, node, callExpr, sourceFile, counters);
        if (info) hooks.push(info);
      }
    }

    // Standalone useEffect(() => { ... }, [...])
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const callee = node.expression.expression.getText(sourceFile);
      const hookKind = HOOK_KIND_MAP[callee];
      if (hookKind === "effect") {
        const deps = extractEffectDeps(node.expression, sourceFile);
        const count = (counters.get(callee) ?? 0) + 1;
        counters.set(callee, count);
        hooks.push({
          kind: "effect",
          label: `${callee}:${count}`,
          displayName: deps.length > 0 ? `${callee}([${deps.join(", ")}])` : `${callee}(${count})`,
          params: deps.map((d) => ({ name: d })),
          returnType: undefined,
        });
      }
    }

    ts.forEachChild(node, walk);
  }

  // Only walk direct statements of the function body, not nested functions
  if (ts.isFunctionDeclaration(funcNode) || ts.isFunctionExpression(funcNode)) {
    if (funcNode.body) ts.forEachChild(funcNode.body, walk);
  } else if (ts.isArrowFunction(funcNode)) {
    if (funcNode.body && ts.isBlock(funcNode.body)) {
      ts.forEachChild(funcNode.body, walk);
    }
  }

  return hooks;
}

function buildHookInfo(
  kind: HookInfo["kind"],
  hookName: string,
  decl: ts.VariableDeclaration,
  callExpr: ts.CallExpression,
  sourceFile: ts.SourceFile,
  counters: Map<string, number>
): HookInfo | null {
  // Extract the binding name(s)
  let varName: string;
  let setterName: string | undefined;

  if (ts.isArrayBindingPattern(decl.name)) {
    // const [value, setValue] = useState(...)
    const elements = decl.name.elements;
    varName = elements[0] && ts.isBindingElement(elements[0]) ? elements[0].name.getText(sourceFile) : "unknown";
    setterName = elements[1] && ts.isBindingElement(elements[1]) ? elements[1].name.getText(sourceFile) : undefined;
  } else if (ts.isIdentifier(decl.name)) {
    // const ref = useRef(...)
    varName = decl.name.text;
  } else {
    return null;
  }

  // Extract initial value hint
  const firstArg = callExpr.arguments[0];
  let initialValue: string | undefined;
  if (firstArg) {
    const text = firstArg.getText(sourceFile);
    initialValue = text.length <= 30 ? text : text.slice(0, 27) + "...";
  }

  // Extract type argument if present: useState<boolean>(false)
  let typeHint: string | undefined;
  if (callExpr.typeArguments && callExpr.typeArguments.length > 0) {
    typeHint = callExpr.typeArguments[0].getText(sourceFile);
  }

  const displayParts: string[] = [varName];
  if (typeHint) displayParts.push(`: ${typeHint}`);
  else if (initialValue) displayParts.push(` = ${initialValue}`);

  const params: Array<{ name: string; type?: string }> = [];
  if (kind === "state") {
    params.push({ name: varName, type: typeHint ?? "unknown" });
    if (setterName) params.push({ name: setterName, type: `(value) => void` });
  } else if (kind === "ref") {
    params.push({ name: varName, type: typeHint ? `Ref<${typeHint}>` : "Ref" });
  } else if (kind === "memo") {
    params.push({ name: varName, type: typeHint });
    const deps = extractEffectDeps(callExpr, sourceFile);
    for (const d of deps) params.push({ name: `dep:${d}` });
  }

  return {
    kind,
    label: `${hookName}:${varName}`,
    displayName: `${hookName}(${displayParts.join("")})`,
    params,
    returnType: typeHint,
    setterName: kind === "state" ? setterName : undefined,
    initialValue,
  };
}

function extractEffectDeps(callExpr: ts.CallExpression, sourceFile: ts.SourceFile): string[] {
  // The deps array is typically the last argument
  const lastArg = callExpr.arguments[callExpr.arguments.length - 1];
  if (!lastArg || !ts.isArrayLiteralExpression(lastArg)) return [];
  return lastArg.elements.map((el) => el.getText(sourceFile)).filter((t) => t.length < 30);
}

function findExportedFunctionBody(sourceFile: ts.SourceFile, name: string): ts.Node | null {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          return decl.initializer;
        }
      }
    }
  }
  return null;
}

// ── Exported variable extraction ────────────────────────────

function extractExportedVariables(
  sourceFile: ts.SourceFile,
  relativePath: string,
  entities: EntitySummary[]
): void {
  for (const stmt of sourceFile.statements) {
    // export const FOO = ... (but not functions/arrows already captured)
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const name = decl.name.text;
        const id = `${relativePath}#${name}`;

        // Skip if already captured as a function or component
        if (entities.some((e) => e.id === id)) continue;

        // Skip arrow/function expressions (already handled)
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) continue;

        let valueHint: string | undefined;
        const text = decl.initializer.getText(sourceFile);
        valueHint = text.length <= 50 ? text : text.slice(0, 47) + "...";

        const typeHint = decl.type ? decl.type.getText(sourceFile) : undefined;

        entities.push({
          id,
          kind: "variable",
          name,
          filePath: relativePath,
          exportName: name,
          params: [{ name: "value", type: typeHint ?? "unknown" }],
          returnType: typeHint,
          initialValue: valueHint,
          dependencies: []
        });
      }
    }

    // export enum Foo { ... }
    if (ts.isEnumDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      const name = stmt.name.text;
      const members = stmt.members.map((m) => m.name.getText(sourceFile));
      entities.push({
        id: `${relativePath}#${name}`,
        kind: "variable",
        name: `enum ${name}`,
        filePath: relativePath,
        exportName: name,
        params: members.map((m) => ({ name: m })),
        returnType: "enum",
        dependencies: []
      });
    }
  }
}

// ── Event handler → state tracing ───────────────────────────

/** Collect all local function/const declarations in a component body */
function collectLocalHandlers(funcNode: ts.Node, sourceFile: ts.SourceFile): Map<string, ts.Node> {
  const handlers = new Map<string, ts.Node>();
  let body: ts.Node | undefined;

  if (ts.isFunctionDeclaration(funcNode) || ts.isFunctionExpression(funcNode)) {
    body = funcNode.body;
  } else if (ts.isArrowFunction(funcNode)) {
    body = funcNode.body;
  }
  if (!body || !ts.isBlock(body)) return handlers;

  for (const stmt of body.statements) {
    // function handleFoo() { ... }
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      handlers.set(stmt.name.text, stmt);
    }
    // const handleFoo = () => { ... } or const handleFoo = function() { ... }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
            handlers.set(decl.name.text, decl.initializer);
          }
        }
      }
    }
  }

  return handlers;
}

/** Trace an event handler expression to find which state setters it calls */
function traceEventHandler(
  eventName: string,
  handlerExpr: string,
  localHandlers: Map<string, ts.Node>,
  setterToStateId: Map<string, string>,
  sourceFile: ts.SourceFile
): EventHandlerInfo | null {
  const setterPatterns: SetterPattern[] = [];

  // Try to find the handler node
  let handlerNode: ts.Node | undefined;
  let handlerName = handlerExpr;

  // Case 1: Simple identifier — handleSubmit
  if (localHandlers.has(handlerExpr)) {
    handlerNode = localHandlers.get(handlerExpr);
  }
  // Case 2: Inline expression — try to parse it
  else if (handlerExpr.includes("=>") || handlerExpr.includes("(")) {
    // Parse inline like: (e) => setFoo(e.target.value)
    const wrapper = `const __handler = ${handlerExpr}`;
    try {
      const tmpFile = ts.createSourceFile("__tmp.tsx", wrapper, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const firstStmt = tmpFile.statements[0];
      if (ts.isVariableStatement(firstStmt)) {
        const decl = firstStmt.declarationList.declarations[0];
        if (decl?.initializer) {
          handlerNode = decl.initializer;
          handlerName = handlerExpr.length > 30 ? handlerExpr.slice(0, 27) + "..." : handlerExpr;
        }
      }
    } catch {
      // Parse failed — can't trace
    }
  }

  if (!handlerNode) {
    // Can't resolve — still report the event but with no state tracing
    return { eventName, handlerName, targetStateIds: [], setterPatterns: [] };
  }

  // Determine the correct source file for getText() calls
  const handlerSourceFile = handlerNode.getSourceFile();

  // Walk the handler body statement-by-statement to track sync vs async phases
  const body = getHandlerBody(handlerNode);
  if (body) {
    let phase: "sync" | "async" = "sync";

    for (const stmt of body) {
      // Check if this statement contains an await — everything after is async phase
      if (containsAwait(stmt)) {
        // Setters BEFORE the await in this statement are sync
        walkForSetters(stmt, phase);
        phase = "async";
        continue;
      }
      walkForSetters(stmt, phase);
    }
  } else {
    // Simple expression body (arrow without block) — single pass
    walkForSetters(handlerNode, "sync");
  }

  function walkForSetters(node: ts.Node, phase: "sync" | "async"): void {
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression)
        ? node.expression.text
        : node.expression.getText(handlerSourceFile).length < 80
          ? node.expression.getText(handlerSourceFile)
          : undefined;

      if (callee && setterToStateId.has(callee)) {
        const stateId = setterToStateId.get(callee)!;
        const pattern = classifySetterPattern(callee, node, handlerSourceFile);
        setterPatterns.push({ ...pattern, setterName: callee, stateEntityId: stateId, phase });
      }
    }
    ts.forEachChild(node, (child) => walkForSetters(child, phase));
  }

  const targetStateIds = setterPatterns.map((p) => p.stateEntityId);
  return { eventName, handlerName, targetStateIds, setterPatterns };
}

/** Classify the pattern of a setter call to know how to simulate it */
function classifySetterPattern(
  setterName: string,
  callExpr: ts.CallExpression,
  sourceFile: ts.SourceFile
): Omit<SetterPattern, "setterName" | "stateEntityId"> {
  const arg = callExpr.arguments[0];
  if (!arg) return { pattern: "unknown" };

  const argText = arg.getText(sourceFile);

  // Direct literal: setFoo("hello"), setFoo(42), setFoo(true/false), setFoo(null)
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { pattern: "direct", literalValue: arg.text, expression: argText };
  }
  if (ts.isNumericLiteral(arg)) {
    return { pattern: "direct", literalValue: Number(arg.text), expression: argText };
  }
  if (arg.kind === ts.SyntaxKind.TrueKeyword) {
    return { pattern: "direct", literalValue: true, expression: argText };
  }
  if (arg.kind === ts.SyntaxKind.FalseKeyword) {
    return { pattern: "direct", literalValue: false, expression: argText };
  }
  if (arg.kind === ts.SyntaxKind.NullKeyword) {
    return { pattern: "direct", literalValue: null, expression: argText };
  }

  // e.target.value pattern: setFoo(e.target.value) or event.target.value
  if (argText.includes(".target.value") || argText.includes(".currentTarget.value")) {
    return { pattern: "event-target", expression: argText };
  }

  // Boolean toggle: setFoo(!foo) or setFoo(prev => !prev)
  if (argText.startsWith("!") || argText.includes("=> !")) {
    return { pattern: "toggle", expression: argText };
  }

  // Increment: setCount(count + 1) or setCount(c => c + 1)
  if (/\+\s*1/.test(argText) || /\-\s*1/.test(argText)) {
    return { pattern: "increment", expression: argText };
  }

  // Functional update: setFoo(prev => ...)
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    return { pattern: "functional", expression: argText };
  }

  return { pattern: "unknown", expression: argText };
}

/** Get statements from a handler's body (if block body), or null for expression body */
function getHandlerBody(node: ts.Node): ts.NodeArray<ts.Statement> | null {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) {
    return node.body ? node.body.statements : null;
  }
  if (ts.isArrowFunction(node) && ts.isBlock(node.body)) {
    return node.body.statements;
  }
  return null;
}

/** Check if a node contains an await expression */
function containsAwait(node: ts.Node): boolean {
  let found = false;
  function walk(n: ts.Node): void {
    if (found) return;
    if (ts.isAwaitExpression(n)) { found = true; return; }
    ts.forEachChild(n, walk);
  }
  walk(node);
  return found;
}

// ── Helpers ─────────────────────────────────────────────────

/** Find the AST node corresponding to an entity */
function findEntityNode(sourceFile: ts.SourceFile, entity: EntitySummary): ts.Node | null {
  for (const stmt of sourceFile.statements) {
    // export function foo(...)
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === entity.exportName) {
      return stmt;
    }
    // export const foo = ...
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === entity.exportName) {
          return decl.initializer ?? stmt;
        }
      }
    }
    // export class Foo — for class-method, find the method inside
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      if (entity.kind === "class-method" && entity.name.startsWith(stmt.name.text + ".")) {
        const methodName = entity.name.split(".")[1];
        for (const member of stmt.members) {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name) && member.name.text === methodName) {
            return member;
          }
          if (ts.isConstructorDeclaration(member) && methodName === "constructor") {
            return member;
          }
        }
      }
      // The class itself
      if (entity.exportName === stmt.name.text && entity.kind !== "class-method") {
        return stmt;
      }
    }
  }
  return null;
}

/** Collect all identifier names referenced in an AST node */
function collectIdentifiers(node: ts.Node, names: Set<string>): void {
  if (ts.isIdentifier(node)) {
    names.add(node.text);
  }
  ts.forEachChild(node, (child) => collectIdentifiers(child, names));
}


function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasPublicVisibility(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  if (!modifiers) return true; // no modifier = public by default
  return !modifiers.some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
  );
}

function buildFunctionEntity(
  filePath: string,
  exportName: string,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  returnType: ts.TypeNode | undefined
): EntitySummary {
  return {
    id: `${filePath}#${exportName}`,
    kind: "function",
    name: exportName,
    filePath,
    exportName,
    params: parseParameters(params),
    returnType: returnType ? returnType.getText() : undefined,
    dependencies: []
  };
}

function parseParameters(params: ts.NodeArray<ts.ParameterDeclaration>): Array<{ name: string; type?: string }> {
  return params.map((p) => ({
    name: p.name.getText(),
    type: p.type ? p.type.getText() : undefined
  }));
}

// ── React component / UI element helpers ────────────────────

/** PascalCase name → likely a React component */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Check if a function body contains JSX */
function containsJsx(node: ts.Node): boolean {
  let found = false;
  function walk(n: ts.Node): void {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  }
  ts.forEachChild(node, walk);
  return found;
}

interface UiElementInfo {
  tag: string;
  label: string;
  displayName: string;
  /** Raw event handler expressions: { onClick: "handleSubmit", onChange: "setName" } */
  eventHandlers: Record<string, string>;
}

/** Find a named exported function/const and extract individual UI elements */
function extractUiElementsFromSource(sourceFile: ts.SourceFile, name: string): UiElementInfo[] {
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) {
      return collectUiElements(stmt);
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          return collectUiElements(decl.initializer);
        }
      }
    }
  }
  return [];
}

/** Walk a function body and collect every interactive JSX element with a descriptive label */
function collectUiElements(node: ts.Node): UiElementInfo[] {
  const interactiveTags = new Set([
    "button", "input", "textarea", "select", "form", "a",
    "details", "dialog", "summary", "label", "option",
    "img", "video", "audio", "canvas", "iframe"
  ]);

  const results: UiElementInfo[] = [];
  const tagCounters = new Map<string, number>();

  function walk(n: ts.Node): void {
    const isOpening = ts.isJsxOpeningElement(n);
    const isSelfClosing = ts.isJsxSelfClosingElement(n);

    if (isOpening || isSelfClosing) {
      const tagName = n.tagName.getText().toLowerCase();
      if (!interactiveTags.has(tagName)) {
        ts.forEachChild(n, walk);
        return;
      }

      // Extract identifying attributes
      const attrs = getJsxAttributes(n);
      const textContent = isOpening && n.parent && ts.isJsxElement(n.parent)
        ? getJsxTextContent(n.parent)
        : undefined;

      // Build a descriptive label
      const label = buildElementLabel(tagName, attrs, textContent, tagCounters);
      const displayName = buildDisplayName(tagName, attrs, textContent);

      // Extract event handler expressions
      const eventHandlers: Record<string, string> = {};
      const eventAttrNames = [
        "onClick", "onChange", "onInput", "onSubmit", "onBlur",
        "onFocus", "onKeyDown", "onKeyUp", "onKeyPress", "onMouseDown",
        "onMouseUp", "onDoubleClick"
      ];
      for (const evtName of eventAttrNames) {
        if (attrs[evtName]) eventHandlers[evtName] = attrs[evtName];
      }

      results.push({ tag: tagName, label, displayName, eventHandlers });
    }

    ts.forEachChild(n, walk);
  }

  ts.forEachChild(node, walk);
  return results;
}

/** Extract key attributes from a JSX element */
function getJsxAttributes(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const prop of node.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || !prop.name) continue;
    const name = prop.name.getText();

    if (!prop.initializer) {
      attrs[name] = "true";
    } else if (ts.isStringLiteral(prop.initializer)) {
      attrs[name] = prop.initializer.text;
    } else if (ts.isJsxExpression(prop.initializer) && prop.initializer.expression) {
      // For expressions like onClick={handleSubmit}, extract the identifier
      const expr = prop.initializer.expression;
      if (ts.isIdentifier(expr)) {
        attrs[name] = expr.text;
      } else if (ts.isPropertyAccessExpression(expr)) {
        attrs[name] = expr.name.text;
      } else {
        attrs[name] = expr.getText();
      }
    }
  }
  return attrs;
}

/** Get direct text content of a JSX element */
function getJsxTextContent(element: ts.JsxElement): string | undefined {
  const texts: string[] = [];
  for (const child of element.children) {
    if (ts.isJsxText(child)) {
      const t = child.text.trim();
      if (t) texts.push(t);
    }
  }
  return texts.length > 0 ? texts.join(" ").slice(0, 30) : undefined;
}

/** Build a unique label for deduplication */
function buildElementLabel(
  tag: string,
  attrs: Record<string, string>,
  textContent: string | undefined,
  counters: Map<string, number>
): string {
  // Try meaningful identifiers first
  if (attrs["id"]) return attrs["id"];
  if (attrs["name"]) return attrs["name"];
  if (attrs["aria-label"]) return attrs["aria-label"];
  if (textContent) return textContent.replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 25);
  if (attrs["onClick"]) return `onClick:${attrs["onClick"]}`;
  if (attrs["onChange"]) return `onChange:${attrs["onChange"]}`;
  if (attrs["type"]) return `type:${attrs["type"]}`;
  if (attrs["placeholder"]) return attrs["placeholder"].slice(0, 25);
  if (attrs["href"]) return `href:${attrs["href"].slice(0, 25)}`;

  // Fallback: indexed
  const count = (counters.get(tag) ?? 0) + 1;
  counters.set(tag, count);
  return `${tag}${count}`;
}

/** Build a human-readable display name */
function buildDisplayName(
  tag: string,
  attrs: Record<string, string>,
  textContent: string | undefined
): string {
  if (textContent) return `<${tag}> "${textContent}"`;
  if (attrs["aria-label"]) return `<${tag}> "${attrs["aria-label"]}"`;
  if (attrs["placeholder"]) return `<${tag}> [${attrs["placeholder"]}]`;
  if (attrs["type"]) return `<${tag} type="${attrs["type"]}">`;
  if (attrs["id"]) return `<${tag}#${attrs["id"]}>`;
  if (attrs["name"]) return `<${tag} name="${attrs["name"]}">`;
  if (attrs["onClick"]) return `<${tag}> onClick=${attrs["onClick"]}`;
  return `<${tag}>`;
}

/** Map HTML tag names to their semantic actions (PRD section 7.5) */
function getUiElementActions(tag: string): Array<{ name: string; type?: string }> {
  const actionMap: Record<string, Array<{ name: string; type?: string }>> = {
    button:   [{ name: "click", type: "() => void" }],
    input:    [{ name: "type", type: "(value: string) => void" }, { name: "clear", type: "() => void" }],
    textarea: [{ name: "type", type: "(value: string) => void" }, { name: "clear", type: "() => void" }],
    select:   [{ name: "select", type: "(value: string) => void" }],
    form:     [{ name: "submit", type: "() => void" }],
    a:        [{ name: "click", type: "() => void" }, { name: "navigate", type: "(href: string) => void" }],
    details:  [{ name: "toggle", type: "() => void" }],
    dialog:   [{ name: "open", type: "() => void" }, { name: "close", type: "() => void" }],
    label:    [{ name: "click", type: "() => void" }],
    img:      [{ name: "load", type: "() => void" }],
    video:    [{ name: "play", type: "() => void" }, { name: "pause", type: "() => void" }],
    audio:    [{ name: "play", type: "() => void" }, { name: "pause", type: "() => void" }],
    canvas:   [{ name: "draw", type: "() => void" }],
    iframe:   [{ name: "load", type: "() => void" }],
  };
  return actionMap[tag] ?? [{ name: "interact", type: "() => void" }];
}

function buildComponentEntity(
  filePath: string,
  exportName: string,
  params: ts.NodeArray<ts.ParameterDeclaration>
): EntitySummary {
  return {
    id: `${filePath}#${exportName}`,
    kind: "component",
    name: exportName,
    filePath,
    exportName,
    params: parseParameters(params),
    returnType: "JSX.Element",
    dependencies: []
  };
}

async function collectFiles(projectPath: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.readdir(projectPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(projectPath, entry.name);

    if (entry.isDirectory()) {
      result.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name))) {
      result.push(fullPath);
    }
  }

  return result;
}
