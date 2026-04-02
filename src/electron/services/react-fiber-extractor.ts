/**
 * Scripts injected into the target page via CDP Runtime.evaluate.
 * They walk React's fiber tree to extract entities and handle events.
 *
 * These are plain strings containing browser-side JavaScript.
 */

// ── Fiber Tree Extraction ───────────────────────────────────

export const FIBER_EXTRACTOR_SCRIPT = `
function __testmesh_extractFibers() {
  var entities = [];
  var edges = [];
  var entityMap = {};
  var fiberToEntityId = new WeakMap();
  var CHILD_KINDS = { "ui-element": 1, "state": 1, "ref": 1, "effect": 1, "memo": 1 };

  // Find the React root
  var rootFiber = __testmesh_findRootFiber();
  if (!rootFiber) return null;

  // Walk the tree
  __testmesh_walkFiber(rootFiber, null);

  // Store entities/edges globally so the trigger script can find them later
  window.__testmesh_entities = entities;
  window.__testmesh_edges = edges;
  window.__testmesh_entityMap = entityMap;

  return { entities: entities, edges: edges };

  function __testmesh_findRootFiber() {
    // Method 1: React DevTools hook
    var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && hook.renderers) {
      var renderers = hook.renderers;
      var keys = [];
      if (typeof renderers.keys === "function") {
        var iter = renderers.keys();
        var k = iter.next();
        while (!k.done) { keys.push(k.value); k = iter.next(); }
      } else if (typeof renderers.forEach === "function") {
        renderers.forEach(function(v, k) { keys.push(k); });
      }
      for (var i = 0; i < keys.length; i++) {
        var fiberRoots = hook.getFiberRoots ? hook.getFiberRoots(keys[i]) : null;
        if (fiberRoots && fiberRoots.size > 0) {
          var first = fiberRoots.values().next().value;
          if (first && first.current) return first.current;
        }
      }
    }

    // Method 2: Walk DOM looking for React internal key
    var rootEl = document.getElementById("root") || document.getElementById("app") || document.querySelector("[data-reactroot]");
    if (rootEl) {
      var keys2 = Object.keys(rootEl);
      for (var j = 0; j < keys2.length; j++) {
        // React 18+: __reactContainer$ on the root element
        if (keys2[j].startsWith("__reactContainer$")) {
          var container = rootEl[keys2[j]];
          if (container) {
            // container might be a stale fiber. The real tree is at stateNode.current
            if (container.stateNode && container.stateNode.current) {
              return container.stateNode.current;
            }
            // Or try alternate which might have the active tree
            if (container.alternate && container.alternate.child) {
              return container.alternate;
            }
            // Fallback: walk up
            while (container.return) container = container.return;
            return container;
          }
        }
        // React 16-17: __reactFiber$ or __reactInternalInstance$ on root or child elements
        if (keys2[j].startsWith("__reactFiber$") || keys2[j].startsWith("__reactInternalInstance$")) {
          var fiber = rootEl[keys2[j]];
          while (fiber.return) fiber = fiber.return;
          return fiber;
        }
      }
      // Method 3: Check first child element for fiber key
      if (rootEl.children && rootEl.children.length > 0) {
        var child = rootEl.children[0];
        var keys3 = Object.keys(child);
        for (var k = 0; k < keys3.length; k++) {
          if (keys3[k].startsWith("__reactFiber$") || keys3[k].startsWith("__reactInternalInstance$")) {
            var fiberChild = child[keys3[k]];
            while (fiberChild.return) fiberChild = fiberChild.return;
            return fiberChild;
          }
        }
      }
    }

    // Method 4: Scan ALL elements for any React fiber (Next.js, etc.)
    var allEls = document.querySelectorAll("*");
    for (var m = 0; m < Math.min(allEls.length, 100); m++) {
      var elKeys = Object.keys(allEls[m]);
      for (var n = 0; n < elKeys.length; n++) {
        if (elKeys[n].startsWith("__reactContainer$")) {
          var cont = allEls[m][elKeys[n]];
          if (cont && cont.stateNode && cont.stateNode.current) return cont.stateNode.current;
          if (cont && cont.alternate && cont.alternate.child) return cont.alternate;
          while (cont && cont.return) cont = cont.return;
          return cont;
        }
        if (elKeys[n].startsWith("__reactFiber$") || elKeys[n].startsWith("__reactInternalInstance$")) {
          var fib = allEls[m][elKeys[n]];
          while (fib.return) fib = fib.return;
          return fib;
        }
      }
    }

    return null;
  }

  function __testmesh_walkFiber(fiber, parentComponentId, inheritedParent) {
    if (!fiber) return;
    // inheritedParent = the parent context that siblings should use
    if (inheritedParent === undefined) inheritedParent = parentComponentId;

    var type = fiber.type;
    var tag = fiber.tag;

    // Function component (tag 0) or Class component (tag 1)
    if ((tag === 0 || tag === 1) && type && typeof type === "function") {
      var compName = type.displayName || type.name || "Anonymous";
      if (compName && compName !== "Anonymous" && compName.charAt(0) === compName.charAt(0).toUpperCase()) {
        var compId = "component:" + compName + ":" + entities.length;
        fiberToEntityId.set(fiber, compId);

        var entity = {
          id: compId,
          kind: "component",
          name: compName,
          filePath: __testmesh_getSource(fiber) || "",
          exportName: compName,
          params: __testmesh_extractProps(fiber),
          dependencies: [],
          eventHandlers: []
        };
        entities.push(entity);

        // Extract hooks (useState, useRef, etc.)
        __testmesh_extractHooks(fiber, compId, entity);

        // Parent → child component edge
        if (parentComponentId) {
          edges.push({ from: parentComponentId, to: compId, type: "contains" });
          var parentEntity = entityMap[parentComponentId];
          if (parentEntity) parentEntity.dependencies.push(compId);
        }

        entityMap[compId] = entity;
        parentComponentId = compId;
      }
    }

    // Host elements (div, button, input, etc.) — tag 5
    if (tag === 5 && typeof type === "string") {
      var interactiveTags = { button: 1, input: 1, textarea: 1, select: 1, form: 1, a: 1, details: 1, dialog: 1, label: 1 };
      if (interactiveTags[type] && parentComponentId) {
        var props = fiber.memoizedProps || {};
        var label = __testmesh_elementLabel(type, props, fiber);
        var elId = "ui-element:" + type + ":" + label + ":" + entities.length;
        fiberToEntityId.set(fiber, elId);

        // Extract event handlers
        var eventHandlers = [];
        var eventNames = ["onClick", "onChange", "onInput", "onSubmit", "onBlur", "onFocus", "onKeyDown", "onKeyUp"];
        for (var ei = 0; ei < eventNames.length; ei++) {
          var evtName = eventNames[ei];
          if (typeof props[evtName] === "function") {
            var handlerName = props[evtName].name || evtName;
            eventHandlers.push({
              eventName: evtName,
              handlerName: handlerName,
              targetStateIds: [],
              setterPatterns: []
            });
          }
        }

        var elEntity = {
          id: elId,
          kind: "ui-element",
          name: __testmesh_elementDisplayName(type, props, fiber),
          filePath: entityMap[parentComponentId] ? entityMap[parentComponentId].filePath : "",
          params: __testmesh_elementActions(type),
          dependencies: [],
          eventHandlers: eventHandlers.length > 0 ? eventHandlers : undefined,
          _domNode: true
        };
        entities.push(elEntity);
        entityMap[elId] = elEntity;

        edges.push({ from: parentComponentId, to: elId, type: "contains" });
        var parentEnt = entityMap[parentComponentId];
        if (parentEnt) parentEnt.dependencies.push(elId);

        // Store fiber reference for later event dispatch
        if (!window.__testmesh_fiberMap) window.__testmesh_fiberMap = {};
        window.__testmesh_fiberMap[elId] = fiber;
      }
    }

    // Recurse: children use the (possibly updated) parentComponentId
    __testmesh_walkFiber(fiber.child, parentComponentId, parentComponentId);
    // Siblings use the inherited parent (the parent BEFORE this node potentially became one)
    __testmesh_walkFiber(fiber.sibling, inheritedParent, inheritedParent);
  }

  function __testmesh_extractHooks(fiber, compId, compEntity) {
    var hook = fiber.memoizedState;
    var hookIdx = 0;
    while (hook) {
      var queue = hook.queue;
      if (queue && typeof queue.dispatch === "function") {
        // This is a useState or useReducer hook
        var varName = "state" + hookIdx;
        var value = hook.memoizedState;
        var hookId = compId + ".useState:" + varName;

        // Try to infer the variable name from the dispatch function
        var dispatchName = queue.dispatch.name || ("set_state" + hookIdx);

        var stateEntity = {
          id: hookId,
          kind: "state",
          name: "useState(" + __testmesh_serialize(value) + ")",
          filePath: compEntity.filePath,
          params: [
            { name: varName, type: typeof value },
            { name: dispatchName, type: "(value) => void" }
          ],
          dependencies: [],
          setterName: dispatchName,
          initialValue: __testmesh_serialize(value)
        };
        entities.push(stateEntity);
        entityMap[hookId] = stateEntity;

        edges.push({ from: compId, to: hookId, type: "contains" });
        compEntity.dependencies.push(hookId);

        // Store dispatch for later use
        if (!window.__testmesh_dispatchers) window.__testmesh_dispatchers = {};
        window.__testmesh_dispatchers[hookId] = queue.dispatch;
        if (!window.__testmesh_hookFibers) window.__testmesh_hookFibers = {};
        window.__testmesh_hookFibers[hookId] = { fiber: fiber, hookIndex: hookIdx };
      }

      hook = hook.next;
      hookIdx++;
    }
  }

  function __testmesh_getSource(fiber) {
    // React DevTools sometimes stores source info
    if (fiber._debugSource) {
      return fiber._debugSource.fileName || "";
    }
    if (fiber.type && fiber.type.__source) {
      return fiber.type.__source.fileName || "";
    }
    return "";
  }

  function __testmesh_extractProps(fiber) {
    var props = fiber.memoizedProps || {};
    var result = [];
    var keys = Object.keys(props);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === "children") continue;
      var v = props[k];
      result.push({ name: k, type: typeof v });
    }
    return result;
  }

  function __testmesh_elementLabel(type, props, fiber) {
    if (props.id) return props.id;
    if (props.name) return props.name;
    if (props["aria-label"]) return props["aria-label"];
    if (props.placeholder) return props.placeholder;
    // Get text content
    var text = __testmesh_fiberTextContent(fiber);
    if (text) return text.substring(0, 25);
    if (props.className) return props.className.split(" ")[0];
    return type + entities.length;
  }

  function __testmesh_elementDisplayName(type, props, fiber) {
    var text = __testmesh_fiberTextContent(fiber);
    if (text) return "<" + type + '> "' + text + '"';
    if (props["aria-label"]) return "<" + type + '> "' + props["aria-label"] + '"';
    if (props.placeholder) return "<" + type + "> [" + props.placeholder + "]";
    if (props.type) return "<" + type + ' type="' + props.type + '">';
    if (props.id) return "<" + type + "#" + props.id + ">";
    return "<" + type + ">";
  }

  function __testmesh_fiberTextContent(fiber) {
    var props = fiber.memoizedProps || {};

    // Method 1: children prop is a simple string
    if (typeof props.children === "string") {
      return props.children.trim().substring(0, 30) || null;
    }

    // Method 2: children is an array with string elements
    if (Array.isArray(props.children)) {
      var strs = props.children.filter(function(c) { return typeof c === "string" || typeof c === "number"; });
      if (strs.length > 0) return strs.join(" ").trim().substring(0, 30) || null;
    }

    // Method 3: Walk child fibers for text nodes (tag 6)
    var child = fiber.child;
    var texts = [];
    while (child) {
      if (child.tag === 6 && typeof child.memoizedProps === "string") {
        texts.push(child.memoizedProps);
      }
      child = child.sibling;
    }
    if (texts.length > 0) return texts.join(" ").trim().substring(0, 30) || null;

    // Method 4: DOM textContent fallback
    if (fiber.stateNode && fiber.stateNode.textContent) {
      var t = fiber.stateNode.textContent.trim();
      if (t.length > 0 && t.length < 40) return t;
    }

    return null;
  }

  function __testmesh_elementActions(type) {
    var actions = {
      button: [{ name: "click", type: "() => void" }],
      input: [{ name: "type", type: "(value: string) => void" }, { name: "clear", type: "() => void" }],
      textarea: [{ name: "type", type: "(value: string) => void" }],
      select: [{ name: "select", type: "(value: string) => void" }],
      form: [{ name: "submit", type: "() => void" }],
      a: [{ name: "click", type: "() => void" }]
    };
    return actions[type] || [{ name: "interact", type: "() => void" }];
  }

  function __testmesh_serialize(val) {
    if (val === null) return "null";
    if (val === undefined) return "undefined";
    try {
      var s = JSON.stringify(val);
      return s.length > 50 ? s.substring(0, 47) + "..." : s;
    } catch(e) {
      return String(val);
    }
  }
}
`;

// ── Event Triggering ────────────────────────────────────────

export const TRIGGER_EVENT_SCRIPT = `
function __testmesh_findDomNode(fiber) {
  // 1. Direct stateNode check (and alternate)
  if (fiber.stateNode && fiber.stateNode.nodeType) return fiber.stateNode;
  if (fiber.alternate && fiber.alternate.stateNode && fiber.alternate.stateNode.nodeType) return fiber.alternate.stateNode;

  // 2. Walk down child fibers
  var current = fiber.child;
  var depth = 0;
  while (current && depth < 20) {
    if (current.stateNode && current.stateNode.nodeType) return current.stateNode;
    if (current.alternate && current.alternate.stateNode && current.alternate.stateNode.nodeType) return current.alternate.stateNode;
    current = current.child;
    depth++;
  }

  // 3. Fallback: search DOM by matching element type and props
  if (typeof fiber.type === "string" && fiber.memoizedProps) {
    var props = fiber.memoizedProps;
    var selector = fiber.type;
    if (props.id) selector += "#" + CSS.escape(props.id);
    if (props.name) selector += "[name=" + JSON.stringify(props.name) + "]";
    if (props.type && fiber.type === "input") selector += "[type=" + JSON.stringify(props.type) + "]";
    if (props.placeholder) selector += "[placeholder=" + JSON.stringify(props.placeholder) + "]";

    var found = document.querySelector(selector);
    if (found) return found;

    // Broader search
    var all = document.querySelectorAll(fiber.type);
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (props.placeholder && el.placeholder === props.placeholder) return el;
      if (props.id && el.id === props.id) return el;
      if (props.name && el.getAttribute("name") === props.name) return el;
      if (typeof props.children === "string" && el.textContent && el.textContent.trim() === props.children.trim()) return el;
    }
  }

  return null;
}

async function __testmesh_triggerEvent(entityId, eventName, inputValue) {
  // 1. Get state snapshot before
  var stateBefore = __testmesh_captureAllState();

  // 2. Find the DOM element
  var fiberMap = window.__testmesh_fiberMap || {};
  var fiber = fiberMap[entityId];
  if (!fiber) {
    return { stateChanges: [], handlerName: eventName, success: false, error: "Element not found in fiber map" };
  }

  var domNode = __testmesh_findDomNode(fiber);
  if (!domNode || !domNode.dispatchEvent) {
    return { stateChanges: [], handlerName: eventName, success: false, error: "No DOM node for element" };
  }

  // 3. For input/change events, set the value first
  if ((eventName === "onChange" || eventName === "onInput") && inputValue !== undefined) {
    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value"
    );
    if (nativeInputValueSetter && nativeInputValueSetter.set) {
      nativeInputValueSetter.set.call(domNode, inputValue);
    } else {
      domNode.value = inputValue;
    }
  }

  // 4. Dispatch the event
  var eventType = eventName.replace(/^on/, "").toLowerCase();
  var handlerName = eventName;

  try {
    if (eventType === "click") {
      domNode.click();
    } else if (eventType === "change" || eventType === "input") {
      var evt = new Event(eventType, { bubbles: true, cancelable: true });
      domNode.dispatchEvent(evt);
    } else if (eventType === "submit") {
      var submitEvt = new Event("submit", { bubbles: true, cancelable: true });
      domNode.dispatchEvent(submitEvt);
    } else if (eventType === "focus") {
      domNode.focus();
    } else if (eventType === "blur") {
      domNode.blur();
    } else {
      var genericEvt = new Event(eventType, { bubbles: true });
      domNode.dispatchEvent(genericEvt);
    }

    // Get handler name from fiber props
    var props = fiber.memoizedProps || {};
    if (props[eventName] && props[eventName].name) {
      handlerName = props[eventName].name;
    }
  } catch(e) {
    return { stateChanges: [], handlerName: handlerName, success: false, error: e.message };
  }

  // 5. Wait for React to process (microtask + rAF)
  await new Promise(function(resolve) { setTimeout(resolve, 50); });

  // 6. Get state after and diff
  var stateAfter = __testmesh_captureAllState();
  var changes = __testmesh_diffState(stateBefore, stateAfter);

  return { stateChanges: changes, handlerName: handlerName, success: true };
}

function __testmesh_captureAllState() {
  var state = {};
  var hookFibers = window.__testmesh_hookFibers || {};
  var keys = Object.keys(hookFibers);
  for (var i = 0; i < keys.length; i++) {
    var hookId = keys[i];
    var info = hookFibers[hookId];
    var hook = info.fiber.memoizedState;
    var idx = 0;
    while (hook && idx < info.hookIndex) { hook = hook.next; idx++; }
    if (hook) {
      try {
        state[hookId] = JSON.parse(JSON.stringify(hook.memoizedState));
      } catch(e) {
        state[hookId] = String(hook.memoizedState);
      }
    }
  }
  return state;
}

function __testmesh_diffState(before, after) {
  var changes = [];
  var keys = Object.keys(after);
  for (var i = 0; i < keys.length; i++) {
    var hookId = keys[i];
    var prev = before[hookId];
    var next = after[hookId];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      // Extract variable name from hookId: "component:App:0.useState:state0" -> "state0"
      var parts = hookId.split(".");
      var varName = parts.length > 1 ? parts[parts.length - 1].replace("useState:", "") : hookId;
      changes.push({
        stateEntityId: hookId,
        variableName: varName,
        previousValue: prev,
        newValue: next,
        setterExpression: "live update"
      });
    }
  }
  return changes;
}
`;

// ── State Reading ───────────────────────────────────────────

export const GET_STATE_SCRIPT = `
function __testmesh_getState(componentEntityId) {
  var variables = [];
  var hookFibers = window.__testmesh_hookFibers || {};
  var keys = Object.keys(hookFibers);
  for (var i = 0; i < keys.length; i++) {
    var hookId = keys[i];
    // Match hooks belonging to this component
    if (!hookId.startsWith(componentEntityId + ".")) continue;

    var info = hookFibers[hookId];
    var hook = info.fiber.memoizedState;
    var idx = 0;
    while (hook && idx < info.hookIndex) { hook = hook.next; idx++; }
    if (hook) {
      var parts = hookId.split(".");
      var varName = parts.length > 1 ? parts[parts.length - 1].replace("useState:", "") : hookId;
      var val;
      try { val = JSON.parse(JSON.stringify(hook.memoizedState)); } catch(e) { val = String(hook.memoizedState); }
      variables.push({
        stateEntityId: hookId,
        variableName: varName,
        currentValue: val,
        initialValue: val,
        type: typeof val
      });
    }
  }
  return { componentId: componentEntityId, variables: variables };
}
`;

// ── State Watching ──────────────────────────────────────────

export const WATCH_STATE_SCRIPT = `
function __testmesh_watchState() {
  var hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return;

  var prevState = __testmesh_captureAllState ? __testmesh_captureAllState() : {};

  // Patch onCommitFiberRoot to detect changes
  var originalOnCommit = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function(rendererID, fiberRoot) {
    if (originalOnCommit) originalOnCommit.call(this, rendererID, fiberRoot);

    // Diff state
    try {
      var newState = __testmesh_captureAllState();
      var changes = __testmesh_diffState(prevState, newState);
      if (changes.length > 0) {
        console.log("__TESTMESH_STATE_CHANGE__" + JSON.stringify(changes));
        prevState = newState;
      }
    } catch(e) {}
  };
}
`;
