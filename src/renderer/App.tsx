import { useMemo, useState } from "react";
import type {
  EntitySummary,
  ProjectScanResult,
  RunEntityResult
} from "../shared/types";
import { GraphPanel } from "./GraphPanel";

declare global {
  interface Window {
    desktop: import("../shared/types").DesktopApi;
  }
}

const KIND_ICONS: Record<string, string> = {
  function: "fn",
  "class-method": "cls",
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

type RightTab = "details" | "output";

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

  async function handlePickProject() {
    const result = await window.desktop.pickProjectPath();
    if (result) setProjectPath(result);
  }

  async function handleScan() {
    if (!projectPath) { setErrorMessage("Choose a project path first."); return; }
    setErrorMessage(""); setRunResult(null); setIsScanning(true);
    try {
      const result = await window.desktop.scanProject(projectPath);
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
      const result = await window.desktop.runEntity({ entityId: selectedEntityId, inputJson });
      setRunResult(result);
      setRightTab("output");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally { setIsRunning(false); }
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

        <button className="btn btn-accent" onClick={handleScan} disabled={isScanning}>
          {isScanning ? (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              Scanning...
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              Scan
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
                      <span className="detail-label">JSON Input</span>
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

                    <pre className="result-output">{JSON.stringify(runResult.output ?? runResult.error, null, 2)}</pre>
                  </>
                ) : (
                  <div className="sidebar-empty">
                    <p>No output yet</p>
                    <span>Run an entity to see results here</span>
                  </div>
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
