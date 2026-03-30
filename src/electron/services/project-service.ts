import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type {
  EntitySummary,
  GraphEdge,
  ProjectScanResult,
  RunEntityRequest,
  RunEntityResult
} from "../../shared/types.js";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

let lastScan: ProjectScanResult | null = null;

// ── Scanning ────────────────────────────────────────────────

export async function scanProject(projectPath: string): Promise<ProjectScanResult> {
  const files = await collectFiles(projectPath);
  const entities: EntitySummary[] = [];
  const fileImports = new Map<string, string[]>(); // relativePath → imported relative paths

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    const relativePath = path.relative(projectPath, filePath);
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);

    entities.push(...extractEntities(sourceFile, relativePath));
    fileImports.set(relativePath, extractImports(sourceFile, relativePath, projectPath, files));
  }

  const edges = buildEdges(entities, fileImports);

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

    // export class Foo { ... } – extract methods
    if (ts.isClassDeclaration(node) && node.name && hasExportModifier(node)) {
      const className = node.name.text;
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          member.name &&
          ts.isIdentifier(member.name) &&
          hasPublicVisibility(member)
        ) {
          entities.push({
            id: `${relativePath}#${className}.${member.name.text}`,
            kind: "class-method",
            name: `${className}.${member.name.text}`,
            filePath: relativePath,
            exportName: className,
            params: parseParameters(member.parameters),
            returnType: member.type ? member.type.getText() : undefined,
            dependencies: []
          });
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

  // For each component, extract hooks, state, and UI elements
  const componentEntities = entities.filter((e) => e.kind === "component");
  for (const comp of componentEntities) {
    // UI elements
    const uiElements = extractUiElementsFromSource(sourceFile, comp.exportName!);
    for (const el of uiElements) {
      const uiId = `${relativePath}#${comp.exportName}.${el.tag}:${el.label}`;
      if (!entities.some((e) => e.id === uiId)) {
        entities.push({
          id: uiId,
          kind: "ui-element",
          name: el.displayName,
          filePath: relativePath,
          exportName: undefined,
          params: getUiElementActions(el.tag),
          returnType: undefined,
          dependencies: []
        });
        comp.dependencies.push(uiId);
      }
    }

    // Hooks (useState, useReducer, useRef, useEffect, useMemo, useCallback)
    const hooks = extractHooksFromSource(sourceFile, comp.exportName!);
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
          dependencies: []
        });
        comp.dependencies.push(hookId);
      }
    }
  }

  // Exported variables / constants (outside components)
  extractExportedVariables(sourceFile, relativePath, entities);

  return entities;
}

// ── Import / dependency edge extraction ─────────────────────

function extractImports(
  sourceFile: ts.SourceFile,
  relativePath: string,
  projectPath: string,
  allFiles: string[]
): string[] {
  const imports: string[] = [];

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;

    const specifier = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;

    const raw = specifier.text;
    if (!raw.startsWith(".")) continue; // skip bare module specifiers (node_modules)

    const dir = path.dirname(path.join(projectPath, relativePath));
    const resolved = resolveLocalImport(dir, raw, projectPath, allFiles);
    if (resolved) {
      imports.push(resolved);
    }
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
  fileImports: Map<string, string[]>
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  // Import-based edges
  for (const [fromFile, importedFiles] of fileImports) {
    const fromEntities = entities.filter((e) => e.filePath === fromFile);
    for (const toFile of importedFiles) {
      const toEntities = entities.filter((e) => e.filePath === toFile);

      for (const from of fromEntities) {
        for (const to of toEntities) {
          const key = `${from.id}→${to.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from: from.id, to: to.id, type: "imports" });
            from.dependencies.push(to.id);
          }
        }
      }
    }
  }

  // Contains edges: component → ui-element (already in dependencies from extraction)
  for (const entity of entities) {
    if (entity.kind === "component") {
      for (const depId of entity.dependencies) {
        const dep = entities.find((e) => e.id === depId);
        if (dep && dep.kind === "ui-element") {
          const key = `${entity.id}→${dep.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({ from: entity.id, to: dep.id, type: "contains" });
          }
        }
      }
    }
  }

  return edges;
}

// ── Execution ───────────────────────────────────────────────

export async function runEntity(request: RunEntityRequest): Promise<RunEntityResult> {
  const startedAt = Date.now();

  try {
    if (!lastScan) {
      throw new Error("No project has been scanned yet.");
    }

    const entity = lastScan.entities.find((item) => item.id === request.entityId);
    if (!entity) {
      throw new Error(`Entity not found: ${request.entityId}`);
    }

    const parsedInput = JSON.parse(request.inputJson) as unknown;
    const args = Array.isArray(parsedInput) ? parsedInput : [parsedInput];

    const modulePath = path.resolve(lastScan.projectPath, entity.filePath);

    // Transpile TS on-the-fly if needed
    const loadedModule = await loadModule(modulePath);

    const target = entity.exportName ? loadedModule[entity.exportName] : undefined;

    if (typeof target !== "function") {
      throw new Error("Selected entity is not an executable exported function.");
    }

    const output = await target(...args);

    return {
      status: "passed",
      output,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      durationMs: Date.now() - startedAt
    };
  }
}

// ── TS transpile-and-load helper ────────────────────────────

async function loadModule(modulePath: string): Promise<Record<string, unknown>> {
  const ext = path.extname(modulePath);

  // JS files can be imported directly
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return import(modulePath) as Promise<Record<string, unknown>>;
  }

  // TS/TSX – transpile to a temp JS file, then import
  const source = await fs.readFile(modulePath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ext === ".tsx" ? ts.JsxEmit.ReactJSX : undefined,
      esModuleInterop: true,
      strict: false
    },
    fileName: modulePath
  });

  // Write transpiled JS next to the source (cleaned up after import)
  const tmpPath = modulePath.replace(/\.tsx?$/, ".__testmesh_tmp__.mjs");
  await fs.writeFile(tmpPath, result.outputText, "utf8");

  try {
    // Cache-bust so re-runs pick up changes
    const loaded = await import(`${tmpPath}?t=${Date.now()}`) as Record<string, unknown>;
    return loaded;
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

// ── Hook extraction ─────────────────────────────────────────

interface HookInfo {
  kind: "state" | "ref" | "effect" | "memo";
  label: string;
  displayName: string;
  params: Array<{ name: string; type?: string }>;
  returnType?: string;
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
          params: [{ name: "value", type: typeHint ?? valueHint }],
          returnType: typeHint,
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

// ── Helpers ─────────────────────────────────────────────────

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
  label: string;       // unique key within the component
  displayName: string;  // human-readable name for the entity
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

      results.push({ tag: tagName, label, displayName });
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
        attrs[name] = expr.getText().slice(0, 40);
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
