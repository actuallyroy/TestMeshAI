import CDP from "chrome-remote-interface";
import type {
  EntitySummary,
  GraphEdge,
  ProjectScanResult,
  TriggerEventResult,
  StateSnapshot,
  StateChange
} from "../../shared/types.js";

// Injection scripts
import {
  FIBER_EXTRACTOR_SCRIPT,
  TRIGGER_EVENT_SCRIPT,
  GET_STATE_SCRIPT,
  WATCH_STATE_SCRIPT
} from "./react-fiber-extractor.js";

let client: CDP.Client | null = null;
let connectedUrl = "";

export type CdpStatus = "disconnected" | "connecting" | "connected" | "error";
let status: CdpStatus = "disconnected";
let lastError = "";

// State change callback for push notifications
let onStateChangeCallback: ((changes: StateChange[]) => void) | null = null;

// ── Connection ──────────────────────────────────────────────

export async function connect(host: string, port: number, targetUrl?: string): Promise<{ status: CdpStatus; error?: string }> {
  try {
    status = "connecting";

    // List available targets
    const targets = await CDP.List({ host, port });

    // Find the right tab
    let target = targets.find((t: { type: string; url: string }) =>
      t.type === "page" && (!targetUrl || t.url.includes(targetUrl))
    );

    if (!target) {
      target = targets.find((t: { type: string }) => t.type === "page");
    }

    if (!target) {
      status = "error";
      lastError = "No browser tab found. Make sure your React app is open.";
      return { status, error: lastError };
    }

    client = await CDP({ host, port, target: target as CDP.Target });

    // Enable domains we need
    await client.Runtime.enable();
    await client.DOM.enable();

    connectedUrl = (target as { url?: string }).url ?? "";
    status = "connected";

    // Set up console listener for state change notifications
    client.Runtime.on("consoleAPICalled", (params: { type: string; args: Array<{ value?: string }> }) => {
      if (params.type === "log" && params.args[0]?.value?.startsWith("__TESTMESH_STATE_CHANGE__")) {
        try {
          const json = params.args[0].value.replace("__TESTMESH_STATE_CHANGE__", "");
          const changes = JSON.parse(json) as StateChange[];
          if (onStateChangeCallback) onStateChangeCallback(changes);
        } catch { /* ignore parse errors */ }
      }
    });

    return { status };
  } catch (err) {
    status = "error";
    lastError = err instanceof Error ? err.message : String(err);
    return { status, error: lastError };
  }
}

export async function disconnect(): Promise<void> {
  if (client) {
    try { await client.close(); } catch { /* ignore */ }
    client = null;
  }
  status = "disconnected";
  connectedUrl = "";
}

export function getStatus(): { status: CdpStatus; url: string; error?: string } {
  return { status, url: connectedUrl, error: status === "error" ? lastError : undefined };
}

export function setStateChangeCallback(cb: ((changes: StateChange[]) => void) | null): void {
  onStateChangeCallback = cb;
}

// ── Live Scan ───────────────────────────────────────────────

export async function scanLive(): Promise<ProjectScanResult> {
  if (!client || status !== "connected") {
    throw new Error("Not connected to a browser. Connect first.");
  }

  // Inject the fiber extractor and run it
  const result = await client.Runtime.evaluate({
    expression: `(function() { ${FIBER_EXTRACTOR_SCRIPT}; return __testmesh_extractFibers(); })()`,
    returnByValue: true,
    awaitPromise: false,
  });

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.text ??
      result.exceptionDetails.exception?.description ?? "Unknown error";
    throw new Error(`Fiber extraction failed: ${errMsg}`);
  }

  const data = result.result.value as { entities: EntitySummary[]; edges: GraphEdge[] } | null;
  if (!data) {
    throw new Error("Fiber extraction returned no data. Is this a React app in dev mode?");
  }

  // Probe each UI element to discover triggers edges
  await probeEventFlows(data.entities, data.edges);

  return {
    projectPath: connectedUrl,
    entityCount: data.entities.length,
    entities: data.entities,
    edges: data.edges,
  };
}

// ── Edge Probing ────────────────────────────────────────────

const PROBE_SCRIPT = `
function __testmesh_findDomNode(fiber) {
  if (fiber.stateNode && fiber.stateNode.nodeType) return fiber.stateNode;
  if (fiber.alternate && fiber.alternate.stateNode && fiber.alternate.stateNode.nodeType) return fiber.alternate.stateNode;
  var current = fiber.child;
  var depth = 0;
  while (current && depth < 20) {
    if (current.stateNode && current.stateNode.nodeType) return current.stateNode;
    if (current.alternate && current.alternate.stateNode && current.alternate.stateNode.nodeType) return current.alternate.stateNode;
    current = current.child;
    depth++;
  }
  if (typeof fiber.type === "string" && fiber.memoizedProps) {
    var props = fiber.memoizedProps;
    var selector = fiber.type;
    if (props.id) selector += "#" + CSS.escape(props.id);
    if (props.name) selector += "[name=" + JSON.stringify(props.name) + "]";
    if (props.type && fiber.type === "input") selector += "[type=" + JSON.stringify(props.type) + "]";
    if (props.placeholder) selector += "[placeholder=" + JSON.stringify(props.placeholder) + "]";
    var found = document.querySelector(selector);
    if (found) return found;
    var all = document.querySelectorAll(fiber.type);
    for (var i = 0; i < all.length; i++) {
      if (props.placeholder && all[i].placeholder === props.placeholder) return all[i];
      if (props.id && all[i].id === props.id) return all[i];
      if (typeof props.children === "string" && all[i].textContent && all[i].textContent.trim() === props.children.trim()) return all[i];
    }
  }
  return null;
}

async function __testmesh_probeElement(entityId, eventName) {
  var fiberMap = window.__testmesh_fiberMap || {};
  var hookFibers = window.__testmesh_hookFibers || {};
  var fiber = fiberMap[entityId];
  if (!fiber) return [];

  var domNode = __testmesh_findDomNode(fiber);
  if (!domNode) return [];
  var hookIds = Object.keys(hookFibers);

  // 1. Snapshot state
  var before = {};
  for (var i = 0; i < hookIds.length; i++) {
    var hid = hookIds[i];
    var info = hookFibers[hid];
    var hook = info.fiber.memoizedState;
    var idx = 0;
    while (hook && idx < info.hookIndex) { hook = hook.next; idx++; }
    if (hook) {
      try { before[hid] = JSON.stringify(hook.memoizedState); }
      catch(e) { before[hid] = "__unstringifiable__"; }
    }
  }

  // 2. Trigger the event
  try {
    if (eventName === "onClick") {
      domNode.click();
    } else if (eventName === "onChange" || eventName === "onInput") {
      var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (nativeSetter && nativeSetter.set) nativeSetter.set.call(domNode, "test");
      domNode.dispatchEvent(new Event("input", { bubbles: true }));
      domNode.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      var evtType = eventName.replace(/^on/, "").toLowerCase();
      domNode.dispatchEvent(new Event(evtType, { bubbles: true }));
    }
  } catch(e) { return []; }

  // 3. Wait for React to process
  await new Promise(function(r) { setTimeout(r, 80); });

  // 4. Diff state
  var changedHookIds = [];
  for (var j = 0; j < hookIds.length; j++) {
    var hid2 = hookIds[j];
    var info2 = hookFibers[hid2];
    // Re-read from the fiber (may be the alternate now after re-render)
    var fib = info2.fiber.alternate || info2.fiber;
    var hook2 = fib.memoizedState;
    var idx2 = 0;
    while (hook2 && idx2 < info2.hookIndex) { hook2 = hook2.next; idx2++; }
    if (hook2) {
      var after;
      try { after = JSON.stringify(hook2.memoizedState); }
      catch(e) { after = "__unstringifiable__"; }
      if (before[hid2] !== after) {
        changedHookIds.push(hid2);
      }
    }
  }

  // 5. Restore state by re-reading original values and dispatching them
  for (var k = 0; k < hookIds.length; k++) {
    var hid3 = hookIds[k];
    var info3 = hookFibers[hid3];
    var hook3 = info3.fiber.memoizedState;
    var idx3 = 0;
    while (hook3 && idx3 < info3.hookIndex) { hook3 = hook3.next; idx3++; }
    if (hook3 && hook3.queue && hook3.queue.dispatch && before[hid3] && before[hid3] !== "__unstringifiable__") {
      try {
        hook3.queue.dispatch(JSON.parse(before[hid3]));
      } catch(e) {}
    }
  }

  // Wait for restore
  await new Promise(function(r) { setTimeout(r, 50); });

  return changedHookIds;
}
`;

async function probeEventFlows(entities: EntitySummary[], edges: GraphEdge[]): Promise<void> {
  if (!client) return;

  // Inject the probe script
  await client.Runtime.evaluate({
    expression: PROBE_SCRIPT,
    returnByValue: true,
  });

  const uiElements = entities.filter(e => e.kind === "ui-element" && e.eventHandlers && e.eventHandlers.length > 0);
  const edgeSet = new Set(edges.map(e => `${e.from}→${e.to}`));

  for (const el of uiElements) {
    for (const handler of el.eventHandlers!) {
      const safeId = JSON.stringify(el.id);
      const safeEvent = JSON.stringify(handler.eventName);

      try {
        const result = await client.Runtime.evaluate({
          expression: `__testmesh_probeElement(${safeId}, ${safeEvent})`,
          returnByValue: true,
          awaitPromise: true,
        });

        if (result.result.value && Array.isArray(result.result.value)) {
          const changedStateIds = result.result.value as string[];
          for (const stateId of changedStateIds) {
            const key = `${el.id}→${stateId}`;
            if (!edgeSet.has(key)) {
              edgeSet.add(key);
              edges.push({ from: el.id, to: stateId, type: "triggers" });
              handler.targetStateIds.push(stateId);
              el.dependencies.push(stateId);
            }
          }
        }
      } catch {
        // Skip elements that fail to probe
      }
    }
  }
}

// ── Event Triggering ────────────────────────────────────────

export async function triggerEventLive(
  elementEntityId: string,
  eventName: string,
  inputValue?: string
): Promise<TriggerEventResult> {
  if (!client || status !== "connected") {
    throw new Error("Not connected");
  }

  const safeId = JSON.stringify(elementEntityId);
  const safeEvent = JSON.stringify(eventName);
  const safeInput = JSON.stringify(inputValue ?? "");

  // Inject: get state before, trigger event, get state after, return diff
  const result = await client.Runtime.evaluate({
    expression: `(async function() {
      ${TRIGGER_EVENT_SCRIPT};
      return await __testmesh_triggerEvent(${safeId}, ${safeEvent}, ${safeInput});
    })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (result.exceptionDetails) {
    return {
      stateChanges: [],
      handlerName: eventName,
      success: false,
      error: result.exceptionDetails.text ?? result.exceptionDetails.exception?.description ?? "Unknown error",
    };
  }

  return result.result.value as TriggerEventResult ?? {
    stateChanges: [],
    handlerName: eventName,
    success: false,
    error: "No result returned",
  };
}

// ── State Reading ───────────────────────────────────────────

export async function getStateLive(componentEntityId: string): Promise<StateSnapshot> {
  if (!client || status !== "connected") {
    throw new Error("Not connected");
  }

  const safeId = JSON.stringify(componentEntityId);

  const result = await client.Runtime.evaluate({
    expression: `(function() { ${GET_STATE_SCRIPT}; return __testmesh_getState(${safeId}); })()`,
    returnByValue: true,
    awaitPromise: false,
  });

  if (result.exceptionDetails || !result.result.value) {
    return { componentId: componentEntityId, variables: [] };
  }

  return result.result.value as StateSnapshot;
}

// ── State Watching ──────────────────────────────────────────

export async function startWatching(): Promise<void> {
  if (!client || status !== "connected") return;

  await client.Runtime.evaluate({
    expression: `(function() { ${WATCH_STATE_SCRIPT}; __testmesh_watchState(); })()`,
    returnByValue: true,
    awaitPromise: false,
  });
}
