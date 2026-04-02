import { useCallback, useEffect, useRef, useState } from "react";
import type { EntitySummary, GraphEdge } from "../shared/types";

interface Props {
  entities: EntitySummary[];
  edges: GraphEdge[];
  selectedEntityId: string;
  onSelectEntity: (id: string) => void;
}

interface NodeLayout {
  id: string;
  label: string;
  kind: string;
  filePath: string;
  x: number;
  y: number;
}

/* ── Node card sizing ── */
const NODE_W = 180;
const NODE_H = 56;
const CHILD_W = 150;
const CHILD_H = 42;
const PORT_R = 5;
const CORNER_R = 8;

/* ── Layout spacing ── */
const FILE_GAP_X = 100;       // horizontal gap between file groups
const FILE_GAP_Y = 60;        // vertical gap between file group rows
const CHILD_GAP_X = 16;       // horizontal gap between child nodes
const CHILD_GAP_Y = 14;       // vertical gap between child rows
const CHILD_OFFSET_Y = 24;    // vertical offset from parent to first child row
const GROUP_PAD_X = 20;       // horizontal padding inside file group box
const GROUP_PAD_TOP = 36;     // top padding for file group label
const GROUP_PAD_BOTTOM = 20;
const CHILDREN_PER_ROW = 3;   // child nodes per row under a parent

const KIND_COLORS: Record<string, { accent: string; bg: string; icon: string }> = {
  function:       { accent: "#5b9df9", bg: "#1e2d4a", icon: "fn" },
  "class":        { accent: "#c084fc", bg: "#2d1e4a", icon: "C" },
  "class-method": { accent: "#b07ce8", bg: "#2d1e4a", icon: "m" },
  "api-handler":  { accent: "#3dd9a0", bg: "#1e3a2d", icon: "api" },
  module:         { accent: "#f0b449", bg: "#3a2d1e", icon: "mod" },
  component:      { accent: "#e06cf0", bg: "#3a1e3d", icon: "ui" },
  "ui-element":   { accent: "#f07c6c", bg: "#3a221e", icon: "el" },
  state:          { accent: "#ff9f43", bg: "#3a2e1e", icon: "st" },
  ref:            { accent: "#78d4f0", bg: "#1e2e3a", icon: "ref" },
  effect:         { accent: "#ffd166", bg: "#3a351e", icon: "fx" },
  memo:           { accent: "#45e6b0", bg: "#1e3a2b", icon: "mem" },
  variable:       { accent: "#a0a4b8", bg: "#2a2a36", icon: "var" },
};

const DEFAULT_COLOR = { accent: "#5b9df9", bg: "#1e2d4a", icon: "?" };

/* Children = entities that are nested under a parent component */
const CHILD_KINDS = new Set(["ui-element", "state", "ref", "effect", "memo", "class-method"]);

/* ── Structured layout engine ── */

interface FileGroup {
  filePath: string;
  /** Top-level entities in this file (components, functions, api-handlers, variables) */
  parents: EntitySummary[];
  /** Map from parent entity id → child entities */
  childrenOf: Map<string, EntitySummary[]>;
  /** Computed bounding box */
  x: number;
  y: number;
  w: number;
  h: number;
}

function computeLayout(entities: EntitySummary[], edges: GraphEdge[]): NodeLayout[] {
  // 1. Group entities by file
  const fileMap = new Map<string, EntitySummary[]>();
  for (const e of entities) {
    const list = fileMap.get(e.filePath) ?? [];
    list.push(e);
    fileMap.set(e.filePath, list);
  }

  // 2. Build parent→child mapping from "contains" edges
  const containsEdges = new Set<string>();
  for (const edge of edges) {
    if (edge.type === "contains") containsEdges.add(edge.to);
  }

  // Also use dependency lists from components
  for (const e of entities) {
    if (e.kind === "component") {
      for (const depId of e.dependencies) {
        const dep = entities.find((d) => d.id === depId);
        if (dep && CHILD_KINDS.has(dep.kind)) containsEdges.add(depId);
      }
    }
  }

  // 3. Build file groups
  const fileGroups: FileGroup[] = [];
  for (const [filePath, fileEntities] of fileMap) {
    const parents = fileEntities.filter((e) => !containsEdges.has(e.id));
    const childrenOf = new Map<string, EntitySummary[]>();

    // Assign children to their parent component
    for (const parent of parents) {
      if (parent.kind === "component" || parent.kind === "class") {
        const kids = parent.dependencies
          .map((depId) => fileEntities.find((e) => e.id === depId))
          .filter((e): e is EntitySummary => !!e && CHILD_KINDS.has(e.kind));
        if (kids.length > 0) childrenOf.set(parent.id, kids);
      }
    }

    fileGroups.push({ filePath, parents, childrenOf, x: 0, y: 0, w: 0, h: 0 });
  }

  // 4. Compute size of each file group
  for (const group of fileGroups) {
    let maxBlockW = 0;
    let totalH = 0;

    for (const parent of group.parents) {
      let blockW = NODE_W;
      let blockH = NODE_H;

      const children = group.childrenOf.get(parent.id);
      if (children && children.length > 0) {
        const rows = Math.ceil(children.length / CHILDREN_PER_ROW);
        const colsInLastRow = children.length % CHILDREN_PER_ROW || CHILDREN_PER_ROW;
        const maxCols = Math.min(children.length, CHILDREN_PER_ROW);
        const childrenW = maxCols * CHILD_W + (maxCols - 1) * CHILD_GAP_X;
        blockW = Math.max(blockW, childrenW);
        blockH += CHILD_OFFSET_Y + rows * CHILD_H + (rows - 1) * CHILD_GAP_Y;
      }

      maxBlockW = Math.max(maxBlockW, blockW);
      totalH += blockH + 20; // gap between parents
    }

    group.w = maxBlockW + GROUP_PAD_X * 2;
    group.h = GROUP_PAD_TOP + totalH + GROUP_PAD_BOTTOM;
  }

  // 5. Arrange file groups in a grid (left to right, wrapping)
  const MAX_ROW_W = 1800;
  let curX = 60;
  let curY = 60;
  let rowH = 0;

  for (const group of fileGroups) {
    if (curX + group.w > MAX_ROW_W && curX > 60) {
      curX = 60;
      curY += rowH + FILE_GAP_Y;
      rowH = 0;
    }
    group.x = curX;
    group.y = curY;
    curX += group.w + FILE_GAP_X;
    rowH = Math.max(rowH, group.h);
  }

  // 6. Place nodes within their file groups
  const nodes: NodeLayout[] = [];
  const placed = new Set<string>();

  for (const group of fileGroups) {
    let py = group.y + GROUP_PAD_TOP;

    for (const parent of group.parents) {
      const parentX = group.x + group.w / 2;
      const parentY = py + NODE_H / 2;

      nodes.push({
        id: parent.id,
        label: parent.name,
        kind: parent.kind,
        filePath: parent.filePath,
        x: parentX,
        y: parentY,
      });
      placed.add(parent.id);

      const children = group.childrenOf.get(parent.id);
      if (children && children.length > 0) {
        const rows = Math.ceil(children.length / CHILDREN_PER_ROW);
        let childIdx = 0;

        for (let row = 0; row < rows; row++) {
          const colsThisRow = Math.min(CHILDREN_PER_ROW, children.length - childIdx);
          const rowW = colsThisRow * CHILD_W + (colsThisRow - 1) * CHILD_GAP_X;
          const rowStartX = parentX - rowW / 2 + CHILD_W / 2;
          const rowY = parentY + NODE_H / 2 + CHILD_OFFSET_Y + row * (CHILD_H + CHILD_GAP_Y) + CHILD_H / 2;

          for (let col = 0; col < colsThisRow; col++) {
            const child = children[childIdx++];
            nodes.push({
              id: child.id,
              label: child.name,
              kind: child.kind,
              filePath: child.filePath,
              x: rowStartX + col * (CHILD_W + CHILD_GAP_X),
              y: rowY,
            });
            placed.add(child.id);
          }
        }

        py += NODE_H + CHILD_OFFSET_Y + rows * (CHILD_H + CHILD_GAP_Y) + 20;
      } else {
        py += NODE_H + 20;
      }
    }
  }

  // Place any orphaned entities that weren't placed
  let orphanX = curX + 60;
  let orphanY = 60;
  for (const e of entities) {
    if (!placed.has(e.id)) {
      nodes.push({ id: e.id, label: e.name, kind: e.kind, filePath: e.filePath, x: orphanX, y: orphanY });
      orphanY += NODE_H + 16;
    }
  }

  return nodes;
}

/* ── Component ── */

export function GraphPanel({ entities, edges, selectedEntityId, onSelectEntity }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<NodeLayout[]>([]);
  const animRef = useRef<number>(0);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; origOx: number; origOy: number } | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 });

  // Compute layout when entities/edges change
  useEffect(() => {
    const newNodes = computeLayout(entities, edges);

    // Preserve positions of manually dragged nodes
    const existing = new Map(nodesRef.current.map((n) => [n.id, n]));
    for (const n of newNodes) {
      const prev = existing.get(n.id);
      if (prev && prev.x !== 0 && prev.y !== 0) {
        // Only keep position if it was dragged (we mark this below)
      }
    }

    nodesRef.current = newNodes;

    // Auto-fit: center the content
    if (newNodes.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of newNodes) {
        minX = Math.min(minX, n.x - NODE_W);
        minY = Math.min(minY, n.y - NODE_H);
        maxX = Math.max(maxX, n.x + NODE_W);
        maxY = Math.max(maxY, n.y + NODE_H);
      }
      const contentW = maxX - minX;
      const contentH = maxY - minY;
      const scaleX = (dimensions.w - 40) / contentW;
      const scaleY = (dimensions.h - 40) / contentH;
      const scale = Math.min(1, Math.min(scaleX, scaleY));
      scaleRef.current = scale;
      offsetRef.current.x = (dimensions.w - contentW * scale) / 2 - minX * scale;
      offsetRef.current.y = (dimensions.h - contentH * scale) / 2 - minY * scale;
    }
  }, [entities, edges, dimensions]);

  // Resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas?.parentElement) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) setDimensions({ w: Math.floor(width), h: Math.floor(height) });
      }
    });
    ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, []);

  // Render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = devicePixelRatio;
    canvas.width = dimensions.w * dpr;
    canvas.height = dimensions.h * dpr;
    canvas.style.width = `${dimensions.w}px`;
    canvas.style.height = `${dimensions.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let running = true;
    const nodeMap = new Map(nodesRef.current.map((n) => [n.id, n]));

    function draw() {
      if (!running) return;
      const now = performance.now();
      const nodes = nodesRef.current;
      const scale = scaleRef.current;
      const ox = offsetRef.current.x;
      const oy = offsetRef.current.y;

      ctx!.clearRect(0, 0, dimensions.w, dimensions.h);
      ctx!.save();
      ctx!.translate(ox, oy);
      ctx!.scale(scale, scale);

      // ── File group backgrounds ──
      const fileGroups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
      for (const n of nodes) {
        const isChild = CHILD_KINDS.has(n.kind);
        const hw = isChild ? CHILD_W / 2 : NODE_W / 2;
        const hh = isChild ? CHILD_H / 2 : NODE_H / 2;
        const g = fileGroups.get(n.filePath);
        if (g) {
          g.minX = Math.min(g.minX, n.x - hw);
          g.minY = Math.min(g.minY, n.y - hh);
          g.maxX = Math.max(g.maxX, n.x + hw);
          g.maxY = Math.max(g.maxY, n.y + hh);
        } else {
          fileGroups.set(n.filePath, { minX: n.x - hw, minY: n.y - hh, maxX: n.x + hw, maxY: n.y + hh });
        }
      }

      for (const [filePath, bounds] of fileGroups) {
        const pad = 24;
        const x = bounds.minX - pad;
        const y = bounds.minY - pad - 20;
        const w = bounds.maxX - bounds.minX + pad * 2;
        const h = bounds.maxY - bounds.minY + pad * 2 + 20;

        ctx!.beginPath();
        ctx!.roundRect(x, y, w, h, 12);
        ctx!.fillStyle = "rgba(255,255,255,0.02)";
        ctx!.fill();
        ctx!.strokeStyle = "rgba(255,255,255,0.05)";
        ctx!.lineWidth = 1;
        ctx!.stroke();

        // File label
        ctx!.font = `500 10px 'JetBrains Mono', monospace`;
        ctx!.fillStyle = "rgba(255,255,255,0.25)";
        ctx!.textAlign = "left";
        ctx!.textBaseline = "top";
        const shortPath = filePath.length > 45 ? "..." + filePath.slice(-42) : filePath;
        ctx!.fillText(shortPath, x + 10, y + 8);
      }

      // ── Edges ──
      for (const edge of edges) {
        const a = nodeMap.get(edge.from), b = nodeMap.get(edge.to);
        if (!a || !b) continue;

        const isHi = edge.from === selectedEntityId || edge.to === selectedEntityId;
        const colA = KIND_COLORS[a.kind] ?? DEFAULT_COLOR;
        const isContains = edge.type === "contains";
        const isTriggers = edge.type === "triggers";
        const isCalls = edge.type === "calls";

        const aW = CHILD_KINDS.has(a.kind) ? CHILD_W : NODE_W;
        const bW = CHILD_KINDS.has(b.kind) ? CHILD_W : NODE_W;
        const aH = CHILD_KINDS.has(a.kind) ? CHILD_H : NODE_H;
        const bH = CHILD_KINDS.has(b.kind) ? CHILD_H : NODE_H;

        let startX: number, startY: number, endX: number, endY: number;

        if ((isContains || isTriggers) && !isCalls) {
          // Vertical: parent→child (contains) or element→state (triggers)
          startX = a.x;
          startY = a.y + aH / 2;
          endX = b.x;
          endY = b.y - bH / 2;

          ctx!.beginPath();
          ctx!.moveTo(startX, startY);
          const midY = (startY + endY) / 2;
          ctx!.bezierCurveTo(startX, midY, endX, midY, endX, endY);

          if (isTriggers) {
            ctx!.strokeStyle = isHi ? "#ff9f43" : "rgba(255,159,67,0.25)";
            ctx!.lineWidth = isHi ? 2 : 1.5;
            ctx!.setLineDash([6, 4]);
          } else {
            ctx!.strokeStyle = isHi ? colA.accent + "80" : "rgba(255,255,255,0.06)";
            ctx!.lineWidth = isHi ? 1.5 : 1;
            ctx!.setLineDash([4, 3]);
          }
          ctx!.stroke();
          ctx!.setLineDash([]);

          // Arrow tip for triggers
          if (isTriggers && isHi) {
            const angle = Math.atan2(endY - midY, endX - endX) || Math.PI / 2;
            ctx!.beginPath();
            ctx!.moveTo(endX, endY);
            ctx!.lineTo(endX - 5, endY - 8);
            ctx!.lineTo(endX + 5, endY - 8);
            ctx!.closePath();
            ctx!.fillStyle = "#ff9f43";
            ctx!.fill();
          }
        } else {
          // Import/calls edge: right side of A → left side of B
          startX = a.x + aW / 2;
          startY = a.y;
          endX = b.x - bW / 2;
          endY = b.y;

          const cpOffset = Math.abs(endX - startX) * 0.4 + 60;

          ctx!.beginPath();
          ctx!.moveTo(startX, startY);
          ctx!.bezierCurveTo(startX + cpOffset, startY, endX - cpOffset, endY, endX, endY);
          if (isCalls) {
            ctx!.strokeStyle = isHi ? "#5b9df9" : "rgba(91,157,249,0.15)";
          } else {
            ctx!.strokeStyle = isHi ? colA.accent : "rgba(255,255,255,0.08)";
          }
          ctx!.lineWidth = isHi ? 2 : 1.5;
          ctx!.stroke();

          // Animated flow dots on highlighted edges
          if (isHi) {
            const t = ((now / 2000) % 1);
            for (let d = 0; d < 3; d++) {
              const tt = (t + d * 0.33) % 1;
              const px = bezierPoint(startX, startX + cpOffset, endX - cpOffset, endX, tt);
              const py = bezierPoint(startY, startY, endY, endY, tt);
              ctx!.beginPath();
              ctx!.arc(px, py, 3, 0, Math.PI * 2);
              ctx!.fillStyle = colA.accent;
              ctx!.fill();
            }
          }

          // Port dots
          ctx!.beginPath();
          ctx!.arc(startX, startY, PORT_R, 0, Math.PI * 2);
          ctx!.fillStyle = isHi ? colA.accent : "rgba(255,255,255,0.12)";
          ctx!.fill();

          ctx!.beginPath();
          ctx!.arc(endX, endY, PORT_R, 0, Math.PI * 2);
          ctx!.fillStyle = isHi ? colA.accent : "rgba(255,255,255,0.12)";
          ctx!.fill();
        }
      }

      // ── Nodes ──
      for (const n of nodes) {
        const isChild = CHILD_KINDS.has(n.kind);
        const nw = isChild ? CHILD_W : NODE_W;
        const nh = isChild ? CHILD_H : NODE_H;
        const isSelected = n.id === selectedEntityId;
        const col = KIND_COLORS[n.kind] ?? DEFAULT_COLOR;

        const nx = n.x - nw / 2;
        const ny = n.y - nh / 2;

        // Shadow for selected
        if (isSelected) {
          ctx!.shadowColor = col.accent + "44";
          ctx!.shadowBlur = 16;
          ctx!.shadowOffsetY = 3;
        }

        // Card body
        ctx!.beginPath();
        ctx!.roundRect(nx, ny, nw, nh, CORNER_R);
        ctx!.fillStyle = col.bg;
        ctx!.fill();
        ctx!.strokeStyle = isSelected ? col.accent : "rgba(255,255,255,0.08)";
        ctx!.lineWidth = isSelected ? 2 : 1;
        ctx!.stroke();

        ctx!.shadowColor = "transparent";
        ctx!.shadowBlur = 0;
        ctx!.shadowOffsetY = 0;

        // Accent left stripe
        ctx!.beginPath();
        ctx!.roundRect(nx, ny, 4, nh, [CORNER_R, 0, 0, CORNER_R]);
        ctx!.fillStyle = col.accent;
        ctx!.fill();

        if (isChild) {
          // Compact child card
          ctx!.font = `600 9px 'DM Sans', sans-serif`;
          ctx!.fillStyle = col.accent;
          ctx!.textAlign = "left";
          ctx!.textBaseline = "middle";
          ctx!.fillText(col.icon.toUpperCase(), nx + 12, n.y - 4);

          ctx!.font = `500 10.5px 'DM Sans', sans-serif`;
          ctx!.fillStyle = "#ddddf0";
          const label = truncateText(ctx!, n.label, nw - 36);
          ctx!.fillText(label, nx + 12, n.y + 9);
        } else {
          // Full-size parent card
          // Icon square
          const iconX = nx + 12;
          const iconY = n.y - 12;
          ctx!.beginPath();
          ctx!.roundRect(iconX, iconY, 24, 24, 5);
          ctx!.fillStyle = col.accent + "22";
          ctx!.fill();
          ctx!.font = `700 9px 'DM Sans', sans-serif`;
          ctx!.fillStyle = col.accent;
          ctx!.textAlign = "center";
          ctx!.textBaseline = "middle";
          ctx!.fillText(col.icon.toUpperCase(), iconX + 12, iconY + 12);

          // Label
          ctx!.font = `500 12px 'DM Sans', sans-serif`;
          ctx!.fillStyle = "#eeeef5";
          ctx!.textAlign = "left";
          ctx!.textBaseline = "middle";
          const maxLabelW = nw - 54;
          const label = truncateText(ctx!, n.label, maxLabelW);
          ctx!.fillText(label, iconX + 32, n.y - 5);

          // File path subtitle
          ctx!.font = `400 9px 'JetBrains Mono', monospace`;
          ctx!.fillStyle = "#6c6c8a";
          const shortPath = n.filePath.length > 20 ? "..." + n.filePath.slice(-17) : n.filePath;
          ctx!.fillText(shortPath, iconX + 32, n.y + 10);
        }
      }

      ctx!.restore();
      animRef.current = requestAnimationFrame(draw);
    }

    animRef.current = requestAnimationFrame(draw);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [dimensions, edges, selectedEntityId]);

  // ── Interaction ──

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - offsetRef.current.x) / scaleRef.current,
      y: (clientY - rect.top - offsetRef.current.y) / scaleRef.current,
    };
  }, []);

  const hitTest = useCallback((wx: number, wy: number): NodeLayout | null => {
    const nodes = nodesRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const isChild = CHILD_KINDS.has(n.kind);
      const hw = (isChild ? CHILD_W : NODE_W) / 2;
      const hh = (isChild ? CHILD_H : NODE_H) / 2;
      if (wx >= n.x - hw && wx <= n.x + hw && wy >= n.y - hh && wy <= n.y + hh) {
        return n;
      }
    }
    return null;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    const node = hitTest(x, y);
    if (node) {
      dragRef.current = { nodeId: node.id, offsetX: x - node.x, offsetY: y - node.y };
      onSelectEntity(node.id);
    } else {
      panRef.current = {
        startX: e.clientX, startY: e.clientY,
        origOx: offsetRef.current.x, origOy: offsetRef.current.y,
      };
    }
    canvasRef.current!.setPointerCapture(e.pointerId);
  }, [screenToWorld, hitTest, onSelectEntity]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      const { x, y } = screenToWorld(e.clientX, e.clientY);
      const node = nodesRef.current.find((n) => n.id === dragRef.current!.nodeId);
      if (node) {
        node.x = x - dragRef.current.offsetX;
        node.y = y - dragRef.current.offsetY;
      }
    } else if (panRef.current) {
      offsetRef.current.x = panRef.current.origOx + (e.clientX - panRef.current.startX);
      offsetRef.current.y = panRef.current.origOy + (e.clientY - panRef.current.startY);
    }
  }, [screenToWorld]);

  const handlePointerUp = useCallback(() => {
    dragRef.current = null;
    panRef.current = null;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const oldScale = scaleRef.current;
    const zoom = e.deltaY < 0 ? 1.08 : 1 / 1.08;
    const newScale = Math.max(0.15, Math.min(3, oldScale * zoom));
    offsetRef.current.x = mx - (mx - offsetRef.current.x) * (newScale / oldScale);
    offsetRef.current.y = my - (my - offsetRef.current.y) * (newScale / oldScale);
    scaleRef.current = newScale;
  }, []);

  return (
    <div className="canvas-area">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
        style={{ width: "100%", height: "100%" }}
      />

      {entities.length === 0 && (
        <div className="canvas-empty">
          <div className="canvas-empty-icon">&#x2b21;</div>
          <p>No entities yet</p>
          <span>Choose a project and scan to visualize the mesh</span>
        </div>
      )}

      {entities.length > 0 && (
        <div className="canvas-legend">
          {Object.entries(KIND_COLORS).map(([kind, c]) => (
            <span key={kind} className="legend-item">
              <span className="legend-dot" style={{ background: c.accent }} />
              {kind}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Helpers ── */

function bezierPoint(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "...").width > maxW) t = t.slice(0, -1);
  return t + "...";
}
