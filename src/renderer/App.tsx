import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CdpStatus,
  DiscoveredTarget,
  EntitySummary,
  LiveInstance,
  ProjectScanResult,
  RunEntityResult,
  RuntimeState,
  StateSnapshot,
  StateChange,
  TriggerEventResult
} from "../shared/types";
import { GraphPanel } from "./GraphPanel";

declare global {
  interface Window {
    desktop: import("../shared/types").DesktopApi;
  }
}

const KIND_ICONS: Record<string, string> = {
  function: "fn",
  "class": "C",
  "class-method": "m",
  "api-handler": "api",
  module: "mod",
  component: "ui",
  "ui-element": "el",
  state: "st",
  ref: "ref",
  effect: "fx",
  memo: "mem",
  variable: "var",
};

/** Generate a JSON template from entity params with inline comments */
function generateTemplate(entity: EntitySummary): string {
  if (!entity.params.length) return "[]";

  const lines = entity.params.map((p) => {
    const t = (p.type ?? "").toLowerCase().trim();
    let value: string;

    if (t === "number" || t === "int" || t === "float") value = "0";
    else if (t === "string") value = '""';
    else if (t === "boolean" || t === "bool") value = "false";
    else if (t.includes("|")) {
      const match = t.match(/"([^"]+)"/);
      value = match ? `"${match[1]}"` : "null";
    }
    else if (t.startsWith("array") || t.includes("[]")) value = "[]";
    else if (t === "object" || t.startsWith("{")) value = "{}";
    else if (t === "null") value = "null";
    else if (/^[A-Z]/.test(p.type ?? "")) value = p.type!.split("<")[0].split("[")[0].trim();
    else value = "null";

    return `  ${value}  /* ${p.name}${p.type ? ": " + p.type : ""} */`;
  });

  return `[\n${lines.join(",\n")}\n]`;
}

type RightTab = "details" | "output" | "interact";

export function App() {
  const [projectPath, setProjectPath] = useState("");
  const [scanResult, setScanResult] = useState<ProjectScanResult | null>(null);
  const [selectedEntityId, setSelectedEntityId] = useState("");
  const [inputJson, setInputJson] = useState("[]");
  const [runResult, setRunResult] = useState<RunEntityResult | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [kindFilter, setKindFilter] = useState("all");
  const [rightTab, setRightTab] = useState<RightTab>("details");
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [stateSnapshot, setStateSnapshot] = useState<StateSnapshot | null>(null);
  const [lastChanges, setLastChanges] = useState<StateChange[]>([]);
  const [eventInputs, setEventInputs] = useState<Record<string, string>>({});
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [runtimeState, setRuntimeState] = useState<RuntimeState | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");

  // CDP connection state
  const [cdpStatus, setCdpStatus] = useState<CdpStatus>("disconnected");
  const [cdpUrl, setCdpUrl] = useState("");
  const isLive = cdpStatus === "connected";
  const [targets, setTargets] = useState<DiscoveredTarget[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [showTargets, setShowTargets] = useState(false);

  const selectedEntity = useMemo<EntitySummary | null>(() => {
    if (!scanResult || !selectedEntityId) return null;
    return scanResult.entities.find((e) => e.id === selectedEntityId) ?? null;
  }, [scanResult, selectedEntityId]);

  const filteredEntities = useMemo(() => {
    if (!scanResult) return [];
    if (kindFilter === "all") return scanResult.entities;
    return scanResult.entities.filter((e) => e.kind === kindFilter);
  }, [scanResult, kindFilter]);

  const kindCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const e of scanResult?.entities ?? []) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [scanResult]);

  // Find parent component for a child entity
  const parentComponent = useMemo(() => {
    if (!scanResult || !selectedEntity) return null;
    if (selectedEntity.kind === "component") return selectedEntity;
    return scanResult.entities.find(
      (e) => e.kind === "component" && e.dependencies.includes(selectedEntityId)
    ) ?? null;
  }, [scanResult, selectedEntity, selectedEntityId]);

  // Load state when selecting a UI element or component
  const loadState = useCallback(async (compId: string) => {
    try {
      const snap = isLive
        ? await window.desktop.getStateLive(compId)
        : await window.desktop.getState(compId);
      setStateSnapshot(snap);
    } catch { /* ignore */ }
  }, [isLive]);

  useEffect(() => {
    if (parentComponent) loadState(parentComponent.id);
  }, [parentComponent, loadState]);

  async function handleTriggerEvent(eventName: string) {
    if (!selectedEntity || !parentComponent) return;
    setErrorMessage("");
    setIsRunning(true);
    try {
      let result: TriggerEventResult;
      if (isLive) {
        result = await window.desktop.triggerEventLive(selectedEntityId, eventName, eventInputs[eventName]);
      } else {
        result = await window.desktop.triggerEvent({
          componentId: parentComponent.id,
          uiElementId: selectedEntityId,
          eventName,
          inputValue: eventInputs[eventName],
        });
      }
      setLastChanges(result.stateChanges);

      // Flash changed state nodes
      const changedIds = new Set(result.stateChanges.map((c) => c.stateEntityId));
      setFlashIds(changedIds);
      setTimeout(() => setFlashIds(new Set()), 1200);

      // Reload state
      await loadState(parentComponent.id);

      if (!result.success && result.error) {
        setErrorMessage(result.error);
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }

  async function handleResetState() {
    if (!parentComponent) return;
    try {
      const snap = await window.desktop.resetState(parentComponent.id);
      setStateSnapshot(snap);
      setLastChanges([]);
    } catch { /* ignore */ }
  }

  async function handleDiscover() {
    setIsDiscovering(true);
    setShowTargets(true);
    try {
      const found = await window.desktop.discoverTargets();
      setTargets(found);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDiscovering(false);
    }
  }

  async function handleConnectTarget(target: DiscoveredTarget) {
    setErrorMessage("");
    setShowTargets(false);
    setCdpStatus("connecting");
    try {
      if (target.type === "cdp") {
        // CDP target — connect directly
        const result = await window.desktop.connectCdp({
          host: target.host,
          port: target.port,
          targetUrl: target.url,
        });
        setCdpStatus(result.status);
        setCdpUrl(result.url);
        if (result.error) setErrorMessage(result.error);
      } else {
        // Dev server — try existing CDP ports first, then auto-launch Chrome
        let connected = false;
        for (const cdpPort of [9222, 9229, 9333]) {
          try {
            const result = await window.desktop.connectCdp({
              host: target.host,
              port: cdpPort,
              targetUrl: target.url,
            });
            if (result.status === "connected") {
              setCdpStatus(result.status);
              setCdpUrl(result.url);
              connected = true;
              break;
            }
          } catch { /* try next port */ }
        }

        if (!connected) {
          // Auto-launch Chrome with debugging
          setErrorMessage("");
          const launchResult = await window.desktop.launchChrome(target.url ?? `http://${target.host}:${target.port}`, 9222);
          if (launchResult.success) {
            // Now connect
            const result = await window.desktop.connectCdp({
              host: "localhost",
              port: 9222,
              targetUrl: target.url,
            });
            setCdpStatus(result.status);
            setCdpUrl(result.url);
            if (result.error) setErrorMessage(result.error);
          } else {
            setCdpStatus("error");
            setErrorMessage(launchResult.error ?? "Failed to launch Chrome");
          }
        }
      }
    } catch (err) {
      setCdpStatus("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCdpDisconnect() {
    await window.desktop.disconnectCdp();
    setCdpStatus("disconnected");
    setCdpUrl("");
    setScanResult(null);
  }

  async function handlePickProject() {
    const result = await window.desktop.pickProjectPath();
    if (result) setProjectPath(result);
  }

  async function handleScan() {
    setErrorMessage(""); setRunResult(null); setIsScanning(true);
    try {
      let result: ProjectScanResult;
      if (isLive) {
        result = await window.desktop.scanLive();
      } else {
        if (!projectPath) { setErrorMessage("Choose a project path first."); setIsScanning(false); return; }
        result = await window.desktop.scanProject(projectPath);
      }
      setScanResult(result);
      setSelectedEntityId(result.entities[0]?.id ?? "");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally { setIsScanning(false); }
  }

  async function handleRun() {
    if (!selectedEntityId) { setErrorMessage("Select an entity to run."); return; }
    setErrorMessage(""); setIsRunning(true);
    try {
      const result = await window.desktop.runEntity({
        entityId: selectedEntityId,
        inputJson,
        instanceId: selectedInstanceId || undefined,
      });
      setRunResult(result);
      if (result.instanceId) setSelectedInstanceId(result.instanceId);
      // Refresh runtime state
      const state = await window.desktop.getRuntimeState();
      setRuntimeState(state);
      setRightTab("output");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally { setIsRunning(false); }
  }

  async function handleResetRuntime() {
    await window.desktop.resetRuntime();
    setRuntimeState(null);
    setSelectedInstanceId("");
    setRunResult(null);
  }

  function handleSelectEntity(id: string) {
    setSelectedEntityId(id);
    setRightTab("details");
    if (!rightOpen) setRightOpen(true);
  }

  return (
    <div className="app-shell">
      {/* ── Top bar ── */}
      <header className="topbar">
        <div className="logo">
          <div className="logo-mark">T</div>
          <div className="logo-text">TestMesh<span>AI</span></div>
        </div>

        <div className="topbar-divider" />

        {/* CDP Connection */}
        <div className="cdp-controls">
          <span className={`cdp-dot ${cdpStatus}`} />
          {isLive ? (
            <>
              <span className="cdp-url">{cdpUrl.length > 35 ? "..." + cdpUrl.slice(-32) : cdpUrl}</span>
              <button className="btn" onClick={handleCdpDisconnect} style={{ height: 30, fontSize: 11 }}>
                Disconnect
              </button>
            </>
          ) : (
            <div className="discover-wrapper">
              <button className="btn btn-accent" onClick={handleDiscover} disabled={isDiscovering} style={{ height: 30, fontSize: 11 }}>
                {isDiscovering ? "Scanning..." : "Find Dev Servers"}
              </button>
              {showTargets && (
                <div className="discover-dropdown">
                  {targets.length === 0 && !isDiscovering && (
                    <div className="discover-empty">
                      No servers found. Start your React app or launch Chrome with:
                      <code>google-chrome --remote-debugging-port=9222 http://localhost:3000</code>
                    </div>
                  )}
                  {targets.map((t, i) => (
                    <button key={i} className="discover-item" onClick={() => handleConnectTarget(t)}>
                      <span className={`discover-type ${t.type}`}>{t.type === "cdp" ? "CDP" : "DEV"}</span>
                      <div className="discover-info">
                        <span className="discover-title">{t.title || `Port ${t.port}`}</span>
                        <span className="discover-meta">
                          {t.host}:{t.port}
                          {t.framework && <> &middot; {t.framework}</>}
                        </span>
                      </div>
                    </button>
                  ))}
                  <button className="discover-close" onClick={() => setShowTargets(false)}>Close</button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="topbar-divider" />

        {/* File-based controls (hidden when live) */}
        {!isLive && (
          <>
            <button className="btn" onClick={handlePickProject}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
              Open
            </button>

            <input
              className="project-path-input"
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              placeholder="/path/to/project"
            />
          </>
        )}

        <button className="btn btn-accent" onClick={handleScan} disabled={isScanning}>
          {isScanning ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              Scanning...
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              {isLive ? "Live Scan" : "Scan"}
            </>
          )}
        </button>

        <div className="topbar-actions">
          {scanResult && (
            <div className="entity-count-badge">
              <strong>{scanResult.entityCount}</strong> entities
              {scanResult.edges.length > 0 && (
                <>&nbsp;&middot;&nbsp;<strong>{scanResult.edges.length}</strong> edges</>
              )}
            </div>
          )}

          <button
            className="btn btn-icon"
            onClick={() => setLeftOpen((v) => !v)}
            title="Toggle entity panel"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>
          </button>
          <button
            className="btn btn-icon"
            onClick={() => setRightOpen((v) => !v)}
            title="Toggle details panel"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></svg>
          </button>
        </div>
      </header>

      {/* ── Main area ── */}
      {errorMessage && cdpStatus !== "connected" && (
        <div className="topbar-error">{errorMessage}</div>
      )}

      <div className="main-area">
        {/* Left sidebar: entity list */}
        <aside className={`sidebar-left${leftOpen ? "" : " collapsed"}`}>
          <div className="sidebar-header">
            <h2>Entities</h2>
          </div>

          {scanResult && (
            <div className="kind-pills">
              <button
                className={`kind-pill${kindFilter === "all" ? " active" : ""}`}
                onClick={() => setKindFilter("all")}
              >
                All {scanResult.entityCount}
              </button>
              {Object.entries(kindCounts).map(([kind, count]) => (
                <button
                  key={kind}
                  className={`kind-pill${kindFilter === kind ? " active" : ""}`}
                  onClick={() => setKindFilter(kind)}
                >
                  {kind} {count}
                </button>
              ))}
            </div>
          )}

          <div className="entity-list">
            {filteredEntities.map((entity) => (
              <button
                key={entity.id}
                className={`entity-item${entity.id === selectedEntityId ? " active" : ""}`}
                onClick={() => handleSelectEntity(entity.id)}
              >
                <div className="entity-icon" data-kind={entity.kind}>
                  {KIND_ICONS[entity.kind] ?? "?"}
                </div>
                <div className="entity-info">
                  <span className="entity-name">{entity.name}</span>
                  <span className="entity-path">{entity.filePath}</span>
                </div>
              </button>
            ))}
            {!scanResult && (
              <div className="sidebar-empty">
                <p>No project scanned</p>
                <span>Open a folder and click Scan</span>
              </div>
            )}
          </div>
        </aside>

        {/* Center: graph canvas */}
        <GraphPanel
          entities={scanResult?.entities ?? []}
          edges={scanResult?.edges ?? []}
          selectedEntityId={selectedEntityId}
          onSelectEntity={handleSelectEntity}
        />

        {/* Right sidebar: details + output */}
        <aside className={`sidebar-right${rightOpen ? "" : " collapsed"}`}>
          <div className="detail-tabs">
            <button
              className={`detail-tab${rightTab === "details" ? " active" : ""}`}
              onClick={() => setRightTab("details")}
            >
              Details
            </button>
            <button
              className={`detail-tab${rightTab === "interact" ? " active" : ""}`}
              onClick={() => setRightTab("interact")}
            >
              Interact
            </button>
            <button
              className={`detail-tab${rightTab === "output" ? " active" : ""}`}
              onClick={() => setRightTab("output")}
            >
              Output
            </button>
          </div>

          <div className="sidebar-right-scroll">
            {rightTab === "details" && (
              <>
                {selectedEntity ? (
                  <div className="detail-section">
                    <div className="detail-field">
                      <span className="detail-label">Name</span>
                      <span className="detail-value">{selectedEntity.name}</span>
                    </div>

                    <div className="detail-field">
                      <span className="detail-label">Kind</span>
                      <span className="detail-kind-badge" data-kind={selectedEntity.kind}>
                        {selectedEntity.kind}
                      </span>
                    </div>

                    <div className="detail-field">
                      <span className="detail-label">File</span>
                      <span className="detail-value">
                        <code>{selectedEntity.filePath}</code>
                      </span>
                    </div>

                    <div className="detail-field">
                      <span className="detail-label">Parameters</span>
                      <span className="detail-value">
                        <code>
                          {selectedEntity.params.length
                            ? selectedEntity.params.map((p) => (p.type ? `${p.name}: ${p.type}` : p.name)).join(", ")
                            : "none"}
                        </code>
                      </span>
                    </div>

                    {selectedEntity.returnType && (
                      <div className="detail-field">
                        <span className="detail-label">Returns</span>
                        <span className="detail-value"><code>{selectedEntity.returnType}</code></span>
                      </div>
                    )}

                    {selectedEntity.initialValue && (
                      <div className="detail-field">
                        <span className="detail-label">Value</span>
                        <pre className="result-output" style={{ marginTop: 4 }}>{selectedEntity.initialValue}</pre>
                      </div>
                    )}

                    {selectedEntity.dependencies.length > 0 && (
                      <div className="detail-field">
                        <span className="detail-label">Dependencies</span>
                        <div className="dep-chips">
                          {selectedEntity.dependencies.map((dep) => (
                            <button key={dep} className="dep-chip" onClick={() => handleSelectEntity(dep)}>
                              {dep.split("#")[1] ?? dep}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="detail-section-title" style={{ marginTop: 18 }}>Execute</div>

                    <div className="json-input-area">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span className="detail-label">JSON Input</span>
                        <button
                          className="btn"
                          style={{ height: 22, fontSize: 10, padding: "0 8px" }}
                          onClick={() => setInputJson(generateTemplate(selectedEntity))}
                        >
                          Template
                        </button>
                      </div>

                      {/* Parameter hints */}
                      {selectedEntity.params.length > 0 && (
                        <div className="param-hints">
                          {selectedEntity.params.map((p, i) => (
                            <span key={i} className="param-hint">
                              <span className="param-hint-name">{p.name}</span>
                              {p.type && <span className="param-hint-type">{p.type}</span>}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Live instance quick-insert buttons */}
                      {runtimeState && runtimeState.instances.length > 0 && (
                        <div className="instance-hints">
                          {runtimeState.instances.map((inst) => (
                            <button
                              key={inst.instanceId}
                              className="instance-hint-btn"
                              onClick={() => {
                                // Insert instance ref at cursor or append
                                const textarea = document.querySelector(".json-input-area textarea") as HTMLTextAreaElement;
                                if (textarea) {
                                  const start = textarea.selectionStart;
                                  const end = textarea.selectionEnd;
                                  const newVal = inputJson.slice(0, start) + inst.instanceId + inputJson.slice(end);
                                  setInputJson(newVal);
                                } else {
                                  setInputJson(inputJson + inst.instanceId);
                                }
                              }}
                            >
                              {inst.instanceId}
                            </button>
                          ))}
                        </div>
                      )}

                      <textarea
                        value={inputJson}
                        onChange={(e) => setInputJson(e.target.value)}
                        spellCheck={false}
                      />
                    </div>

                    <div className="run-bar">
                      <button className="btn btn-run" onClick={handleRun} disabled={isRunning}>
                        {isRunning ? (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                            Running...
                          </>
                        ) : (
                          <>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                            Run
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="sidebar-empty">
                    <p>No entity selected</p>
                    <span>Click a node on the canvas or pick from the list</span>
                  </div>
                )}
              </>
            )}

            {rightTab === "interact" && (
              <div className="detail-section">
                {selectedEntity?.kind === "ui-element" && selectedEntity.eventHandlers && selectedEntity.eventHandlers.length > 0 ? (
                  <>
                    <div className="detail-section-title">Events</div>
                    {selectedEntity.eventHandlers.map((handler) => {
                      const isInputEvent = ["onChange", "onInput"].includes(handler.eventName);
                      const isTriggering = isRunning;
                      return (
                        <div key={handler.eventName} className="event-row">
                          <div className="event-header">
                            <span className="event-name">{handler.eventName}</span>
                            <span className="event-handler-name">{handler.handlerName}</span>
                          </div>

                          {isInputEvent && (
                            <input
                              className="event-input"
                              placeholder="Value to pass as e.target.value..."
                              value={eventInputs[handler.eventName] ?? ""}
                              onChange={(e) => setEventInputs((prev) => ({ ...prev, [handler.eventName]: e.target.value }))}
                            />
                          )}

                          <button
                            className="btn btn-trigger"
                            onClick={() => handleTriggerEvent(handler.eventName)}
                            disabled={isTriggering}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                            {isTriggering ? "Executing..." : "Execute"}
                          </button>
                        </div>
                      );
                    })}

                    {errorMessage && <div className="error-banner">{errorMessage}</div>}

                    {/* Show last execution results */}
                    {lastChanges.length > 0 && (
                      <>
                        <div className="detail-section-title" style={{ marginTop: 14 }}>Last Execution Result</div>
                        {lastChanges.map((change, i) => (
                          <div key={i} className="state-change-row">
                            <span className="state-change-name">{change.variableName}</span>
                            <div className="state-change-values">
                              <span className="state-change-prev">{JSON.stringify(change.previousValue)}</span>
                              <span className="state-change-arrow">&rarr;</span>
                              <span className="state-change-next">{JSON.stringify(change.newValue)}</span>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                ) : selectedEntity?.kind === "ui-element" ? (
                  <div className="sidebar-empty">
                    <p>No event handlers detected</p>
                    <span>This element has no onClick, onChange, etc.</span>
                  </div>
                ) : (
                  <div className="sidebar-empty">
                    <p>Select a UI element</p>
                    <span>Pick a button, input, or other interactive element</span>
                  </div>
                )}

                {/* State panel — always visible when a component context exists */}
                {stateSnapshot && stateSnapshot.variables.length > 0 && (
                  <>
                    <div className="detail-section-title" style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span>Component State</span>
                      <button className="btn" style={{ height: 24, fontSize: 10, padding: "0 8px" }} onClick={handleResetState}>
                        Reset
                      </button>
                    </div>

                    {stateSnapshot.variables.map((v) => {
                      const isChanged = lastChanges.some((c) => c.stateEntityId === v.stateEntityId);
                      const isFlashing = flashIds.has(v.stateEntityId);
                      return (
                        <div
                          key={v.stateEntityId}
                          className={`state-var-row${isFlashing ? " flash" : ""}${isChanged ? " changed" : ""}`}
                          onClick={() => handleSelectEntity(v.stateEntityId)}
                        >
                          <div className="state-var-header">
                            <span className="state-var-name">{v.variableName}</span>
                            <span className="state-var-type">{v.type}</span>
                          </div>
                          <div className="state-var-value">
                            {JSON.stringify(v.currentValue)}
                          </div>
                          {isChanged && (
                            <div className="state-var-prev">
                              was: {JSON.stringify(lastChanges.find((c) => c.stateEntityId === v.stateEntityId)?.previousValue)}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}

            {rightTab === "output" && (
              <div className="result-section">
                {errorMessage && <div className="error-banner">{errorMessage}</div>}

                {runResult ? (
                  <>
                    <div className="detail-field">
                      <span className="detail-label">Status</span>
                      <span className={`result-status ${runResult.status}`}>
                        {runResult.status === "passed" ? (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        ) : (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                        )}
                        {runResult.status}
                      </span>
                    </div>

                    <div className="result-duration">
                      Completed in <strong>{runResult.durationMs}ms</strong>
                    </div>

                    {runResult.instanceId && (
                      <div className="detail-field">
                        <span className="detail-label">Instance</span>
                        <span className="detail-value"><code>{runResult.instanceId}</code></span>
                      </div>
                    )}

                    <pre className="result-output">{JSON.stringify(runResult.output ?? runResult.error, null, 2)}</pre>

                    {/* Module state after execution */}
                    {runResult.moduleState && Object.keys(runResult.moduleState).length > 0 && (
                      <>
                        <div className="detail-section-title" style={{ marginTop: 14 }}>Module State (after execution)</div>
                        {Object.entries(runResult.moduleState).map(([file, vars]) => (
                          <div key={file} className="module-state-group">
                            <span className="module-state-file">{file}</span>
                            {typeof vars === "object" && vars !== null && Object.entries(vars as Record<string, unknown>).map(([name, value]) => (
                              <div key={name} className="module-state-var">
                                <span className="module-state-name">{name}</span>
                                <span className="module-state-value">{JSON.stringify(value)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    )}
                  </>
                ) : (
                  <div className="sidebar-empty">
                    <p>No output yet</p>
                    <span>Run an entity to see results here</span>
                  </div>
                )}

                {/* Runtime State */}
                {runtimeState && (
                  <>
                    {/* Live Instances */}
                    {runtimeState.instances.length > 0 && (
                      <>
                        <div className="detail-section-title" style={{ marginTop: 16, display: "flex", justifyContent: "space-between" }}>
                          <span>Live Instances</span>
                          <button className="btn" style={{ height: 24, fontSize: 10, padding: "0 8px" }} onClick={handleResetRuntime}>Reset All</button>
                        </div>
                        {runtimeState.instances.map((inst) => (
                          <div
                            key={inst.instanceId}
                            className={`instance-card${selectedInstanceId === inst.instanceId ? " active" : ""}`}
                            onClick={() => setSelectedInstanceId(inst.instanceId)}
                          >
                            <div className="instance-header">
                              <span className="instance-class">{inst.className}</span>
                              <span className="instance-id">{inst.instanceId}</span>
                            </div>
                            <div className="instance-props">
                              {Object.entries(inst.properties).map(([k, v]) => (
                                <div key={k} className="instance-prop">
                                  <span className="instance-prop-key">{k}</span>
                                  <span className="instance-prop-val">{JSON.stringify(v)}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </>
                    )}

                    {/* Module Variables */}
                    {Object.keys(runtimeState.moduleVariables).length > 0 && (
                      <>
                        <div className="detail-section-title" style={{ marginTop: 16 }}>Module State</div>
                        {Object.entries(runtimeState.moduleVariables).map(([file, vars]) => (
                          <div key={file} className="module-state-group">
                            <span className="module-state-file">{file}</span>
                            {Object.entries(vars).map(([name, value]) => (
                              <div key={name} className="module-state-var">
                                <span className="module-state-name">{name}</span>
                                <span className="module-state-value">{JSON.stringify(value)}</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* Spin keyframe for loading buttons */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
