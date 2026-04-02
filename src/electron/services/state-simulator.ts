import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type {
  EntitySummary,
  StateChange,
  StateSnapshot,
  TriggerEventRequest,
  TriggerEventResult
} from "../../shared/types.js";

/**
 * Real execution engine for React component handlers.
 *
 * Instead of pattern-matching AST, we:
 * 1. Transpile the component source
 * 2. Replace React.useState with a tracked version
 * 3. Execute the component function to capture hooks + handlers
 * 4. Call the actual handler and record every setter invocation
 */

interface StateSlot {
  stateEntityId: string;
  variableName: string;
  setterName: string;
  currentValue: unknown;
  initialValue: unknown;
  type: string;
}

interface ComponentRuntime {
  componentId: string;
  filePath: string;      // absolute path
  exportName: string;
  slots: StateSlot[];
  /** Handler functions captured from the last render */
  handlers: Map<string, Function>;
}

const runtimes = new Map<string, ComponentRuntime>();
let projectPath = "";

// ── Public API ──────────────────────────────────────────────

export function initComponentStates(entities: EntitySummary[], scanProjectPath: string): void {
  runtimes.clear();
  projectPath = scanProjectPath;

  // Build state slot info from scanned entities
  for (const comp of entities) {
    if (comp.kind !== "component" || !comp.exportName) continue;

    const slots: StateSlot[] = [];
    for (const depId of comp.dependencies) {
      const dep = entities.find((e) => e.id === depId);
      if (!dep || dep.kind !== "state" || !dep.setterName) continue;
      slots.push({
        stateEntityId: dep.id,
        variableName: dep.params[0]?.name ?? "unknown",
        setterName: dep.setterName,
        currentValue: parseInitialValue(dep.initialValue),
        initialValue: parseInitialValue(dep.initialValue),
        type: dep.returnType ?? dep.params[0]?.type ?? "unknown",
      });
    }

    runtimes.set(comp.id, {
      componentId: comp.id,
      filePath: path.resolve(scanProjectPath, comp.filePath),
      exportName: comp.exportName,
      slots,
      handlers: new Map(),
    });
  }
}

export function getState(componentId: string): StateSnapshot {
  const rt = runtimes.get(componentId);
  return {
    componentId,
    variables: rt
      ? rt.slots.map((s) => ({
          stateEntityId: s.stateEntityId,
          variableName: s.variableName,
          currentValue: s.currentValue,
          initialValue: s.initialValue,
          type: s.type,
        }))
      : [],
  };
}

export function resetState(componentId: string): StateSnapshot {
  const rt = runtimes.get(componentId);
  if (rt) {
    for (const slot of rt.slots) {
      slot.currentValue = slot.initialValue;
    }
  }
  return getState(componentId);
}

export async function triggerEvent(
  request: TriggerEventRequest,
  entities: EntitySummary[]
): Promise<TriggerEventResult> {
  const rt = runtimes.get(request.componentId);
  if (!rt) {
    return { stateChanges: [], handlerName: "?", success: false, error: "Component runtime not found" };
  }

  // Find the UI element and handler info
  const uiElement = entities.find((e) => e.id === request.uiElementId);
  if (!uiElement?.eventHandlers) {
    return { stateChanges: [], handlerName: "?", success: false, error: "No event handlers on element" };
  }

  const handlerInfo = uiElement.eventHandlers.find((h) => h.eventName === request.eventName);
  if (!handlerInfo) {
    return { stateChanges: [], handlerName: "?", success: false, error: `No ${request.eventName} handler` };
  }

  try {
    // Execute the component to capture current handlers and state
    const { handlers, stateChanges } = await executeComponent(rt, request.eventName, request.inputValue, uiElement.name);

    // Update our stored state with the changes
    for (const change of stateChanges) {
      const slot = rt.slots.find((s) => s.variableName === change.variableName);
      if (slot) {
        slot.currentValue = change.newValue;
      }
    }

    return {
      stateChanges,
      handlerName: handlerInfo.handlerName,
      success: true,
    };
  } catch (error) {
    return {
      stateChanges: [],
      handlerName: handlerInfo.handlerName,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ── Execution engine ────────────────────────────────────────

async function executeComponent(
  rt: ComponentRuntime,
  eventName: string,
  inputValue: string | undefined,
  elementName: string
): Promise<{ handlers: Map<string, Function>; stateChanges: StateChange[] }> {
  // 1. Read and transpile the source
  const source = await fs.readFile(rt.filePath, "utf8");
  const ext = path.extname(rt.filePath);

  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: (ext === ".tsx" || ext === ".jsx") ? ts.JsxEmit.React : undefined,
      esModuleInterop: true,
      strict: false,
    },
    fileName: rt.filePath,
  });

  // 2. Build the mock React with tracked useState
  const stateChanges: StateChange[] = [];
  let hookIndex = 0;

  const mockReact = {
    createElement: (...args: unknown[]) => {
      // Capture JSX elements — return a descriptor we can inspect
      return { __jsx: true, type: args[0], props: args[1] ?? {}, children: args.slice(2) };
    },
    useState: (initialValue: unknown) => {
      const idx = hookIndex++;
      const slot = rt.slots[idx];
      const currentValue = slot ? slot.currentValue : initialValue;

      const setter = (newValue: unknown) => {
        const resolved = typeof newValue === "function" ? (newValue as Function)(currentValue) : newValue;
        stateChanges.push({
          stateEntityId: slot?.stateEntityId ?? `unknown-${idx}`,
          variableName: slot?.variableName ?? `state${idx}`,
          previousValue: currentValue,
          newValue: resolved,
          setterExpression: typeof newValue === "function" ? "functional update" : JSON.stringify(resolved),
        });
        // Also update the slot for subsequent calls in the same handler
        if (slot) slot.currentValue = resolved;
      };

      return [currentValue, setter];
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn: Function) => { try { return fn(); } catch { return undefined; } },
    useCallback: (fn: Function) => fn,
    useContext: () => ({}),
    useReducer: (reducer: Function, initial: unknown) => {
      const idx = hookIndex++;
      const slot = rt.slots[idx];
      return [slot?.currentValue ?? initial, (action: unknown) => {
        const newState = reducer(slot?.currentValue ?? initial, action);
        stateChanges.push({
          stateEntityId: slot?.stateEntityId ?? `unknown-${idx}`,
          variableName: slot?.variableName ?? `state${idx}`,
          previousValue: slot?.currentValue ?? initial,
          newValue: newState,
          setterExpression: JSON.stringify(action),
        });
        if (slot) slot.currentValue = newState;
      }];
    },
    Fragment: Symbol("Fragment"),
    // Add other commonly used React exports
    forwardRef: (fn: Function) => fn,
    memo: (fn: Function) => fn,
    createContext: () => ({ Provider: "Provider", Consumer: "Consumer" }),
  };

  // 3. Build a module sandbox
  const moduleExports: Record<string, unknown> = {};
  const moduleObj = { exports: moduleExports };

  // Mock require for common modules
  const mockRequire = (id: string) => {
    if (id === "react" || id === "React") return mockReact;
    if (id === "react/jsx-runtime" || id === "react/jsx-dev-runtime") {
      return {
        jsx: mockReact.createElement,
        jsxs: mockReact.createElement,
        jsxDEV: mockReact.createElement,
        Fragment: mockReact.Fragment,
      };
    }
    if (id === "react-dom") return {};
    // Return empty object for anything else — we're only running the logic, not rendering
    return new Proxy({}, { get: () => () => {} });
  };

  // 4. Execute the transpiled module
  const wrappedCode = `(function(exports, require, module, __filename, __dirname, React) {
${transpiled.outputText}
})`;

  const fn = eval(wrappedCode) as Function;
  fn(moduleExports, mockRequire, moduleObj, rt.filePath, path.dirname(rt.filePath), mockReact);

  // 5. Get the component function
  const componentFn = moduleObj.exports[rt.exportName] ?? moduleExports[rt.exportName];
  if (typeof componentFn !== "function") {
    throw new Error(`Component "${rt.exportName}" is not a function in the transpiled module`);
  }

  // 6. "Render" the component to capture its JSX tree with handler references
  hookIndex = 0; // Reset hook index for render
  let jsxTree: unknown;
  try {
    jsxTree = componentFn({});
  } catch (e) {
    // Component may fail to render due to missing context/props — that's ok,
    // we still captured the hooks via useState calls
    jsxTree = null;
  }

  // 7. Find the target element's handler in the JSX tree
  // Collect ALL elements with this event handler, then match by element name
  const allHandlers = findAllHandlersInTree(jsxTree, eventName);
  const handler = pickBestHandler(allHandlers, elementName);
  if (!handler) {
    throw new Error(`Could not find ${eventName} handler for "${elementName}" in rendered tree (found ${allHandlers.length} candidates)`);
  }

  // 8. Build mock event and call the handler
  const mockEvent = buildMockEvent(eventName, inputValue);
  stateChanges.length = 0; // Clear any setter calls from the render phase

  try {
    const result = handler(mockEvent);
    // If it's async, await it
    if (result && typeof result === "object" && typeof (result as Promise<unknown>).then === "function") {
      await result;
    }
  } catch (e) {
    // Handler may throw (e.g., network call fails) — we still have the state changes
    // that happened before the error
  }

  return { handlers: new Map(), stateChanges };
}

// ── Helpers ─────────────────────────────────────────────────

interface HandlerCandidate {
  handler: Function;
  type: string;
  id?: string;
  placeholder?: string;
  textContent?: string;
  className?: string;
  ariaLabel?: string;
  score: number;
}

/** Collect ALL elements in the tree that have the given event handler */
function findAllHandlersInTree(tree: unknown, eventName: string): HandlerCandidate[] {
  const results: HandlerCandidate[] = [];

  function walk(node: unknown): void {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (!n.__jsx) return;

    const props = n.props as Record<string, unknown> | null;
    if (props && typeof props[eventName] === "function") {
      const children = n.children as unknown[];
      const textContent = Array.isArray(children)
        ? children.filter((c) => typeof c === "string" || typeof c === "number").join(" ").trim()
        : undefined;

      results.push({
        handler: props[eventName] as Function,
        type: typeof n.type === "string" ? n.type : "",
        id: props.id ? String(props.id) : undefined,
        placeholder: props.placeholder ? String(props.placeholder) : undefined,
        textContent: textContent || undefined,
        className: props.className ? String(props.className) : undefined,
        ariaLabel: props["aria-label"] ? String(props["aria-label"]) : undefined,
        score: 0,
      });
    }

    // Recurse children
    const children = n.children as unknown[];
    if (Array.isArray(children)) {
      for (const child of children) {
        if (Array.isArray(child)) {
          for (const c of child) walk(c);
        } else {
          walk(child);
        }
      }
    }
    if (props?.children) {
      if (Array.isArray(props.children)) {
        for (const child of props.children) walk(child);
      } else {
        walk(props.children);
      }
    }
  }

  walk(tree);
  return results;
}

/** Pick the candidate that best matches the entity's display name */
function pickBestHandler(candidates: HandlerCandidate[], elementName: string): Function | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].handler;

  // Score each candidate by how well it matches
  for (const c of candidates) {
    // Exact id match
    if (c.id && elementName.includes(`#${c.id}`)) { c.score += 100; }
    // Text content match: '<button> "Scan Codebase"'
    if (c.textContent && elementName.includes(`"${c.textContent}"`)) { c.score += 80; }
    if (c.textContent && elementName.includes(c.textContent)) { c.score += 60; }
    // Placeholder match: '<input> [/path/to/codebase]'
    if (c.placeholder && elementName.includes(c.placeholder)) { c.score += 70; }
    if (c.placeholder && elementName.includes(`[${c.placeholder}]`)) { c.score += 75; }
    // Aria label match
    if (c.ariaLabel && elementName.includes(c.ariaLabel)) { c.score += 70; }
    // Tag type match
    if (c.type && elementName.startsWith(`<${c.type}>`)) { c.score += 10; }
    if (c.type && elementName.startsWith(`<${c.type} `)) { c.score += 10; }
    // onClick handler name match
    if (c.handler.name && elementName.includes(c.handler.name)) { c.score += 50; }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].handler;
}

function buildMockEvent(eventName: string, inputValue?: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    preventDefault: () => {},
    stopPropagation: () => {},
    type: eventName.replace(/^on/, "").toLowerCase(),
    target: {
      value: inputValue ?? "",
      checked: false,
      name: "",
      type: "text",
    },
    currentTarget: {
      value: inputValue ?? "",
      checked: false,
      name: "",
      type: "text",
    },
    nativeEvent: {},
    bubbles: true,
    cancelable: true,
  };

  return base;
}

function parseInitialValue(raw: string | undefined): unknown {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw === "undefined") return undefined;
  if (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`")) {
    return raw.slice(1, -1);
  }
  const num = Number(raw);
  if (!isNaN(num)) return num;
  if (raw === "[]") return [];
  if (raw === "{}") return {};
  return raw;
}
