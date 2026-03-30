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
  vx: number;
  vy: number;
}

/* ── n8n-style node dimensions ── */
const NODE_W = 172;
const NODE_H = 60;
const PORT_R = 5;
const HEADER_H = 22;
const CORNER_R = 8;

const KIND_COLORS: Record<string, { accent: string; bg: string; icon: string }> = {
  function:       { accent: "#5b9df9", bg: "#1e2d4a", icon: "fn" },
  "class-method": { accent: "#b07ce8", bg: "#2d1e4a", icon: "cls" },
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

export function GraphPanel({ entities, edges, selectedEntityId, onSelectEntity }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nodesRef = useRef<NodeLayout[]>([]);
  const animRef = useRef<number>(0);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; origOx: number; origOy: number } | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const [dimensions, setDimensions] = useState({ w: 800, h: 600 });
  const tickCountRef = useRef(0);

  // Sync nodes
  useEffect(() => {
    const existing = new Map(nodesRef.current.map((n) => [n.id, n]));
    const cols = Math.max(Math.ceil(Math.sqrt(entities.length)), 1);

    nodesRef.current = entities.map((e, i) => {
      const prev = existing.get(e.id);
      if (prev) {
        prev.label = e.name;
        prev.kind = e.kind;
        prev.filePath = e.filePath;
        return prev;
      }
      const col = i % cols;
      const row = Math.floor(i / cols);
      return {
        id: e.id,
        label: e.name,
        kind: e.kind,
        filePath: e.filePath,
        x: 100 + col * 220 + (Math.random() - 0.5) * 40,
        y: 100 + row * 120 + (Math.random() - 0.5) * 30,
        vx: 0,
        vy: 0,
      };
    });
    tickCountRef.current = 0;
  }, [entities]);

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

  // Animation loop
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
    let frameTime = performance.now();

    function tick() {
      if (!running) return;
      const now = performance.now();
      frameTime = now;
      const nodes = nodesRef.current;
      const scale = scaleRef.current;
      const ox = offsetRef.current.x;
      const oy = offsetRef.current.y;

      // Physics (settle after ~300 ticks)
      if (tickCountRef.current < 350) {
        tickCountRef.current++;
        const damping = tickCountRef.current > 250 ? 0.7 : 0.88;

        // Repulsion
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i], b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const force = 8000 / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx; a.vy -= fy;
            b.vx += fx; b.vy += fy;
          }
        }

        // Springs
        for (const edge of edges) {
          const a = nodeMap.get(edge.from), b = nodeMap.get(edge.to);
          if (!a || !b) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const spring = (dist - 240) * 0.003;
          const fx = (dx / dist) * spring, fy = (dy / dist) * spring;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }

        // Gravity to center
        const cx = dimensions.w / 2 / scale - ox / scale;
        const cy = dimensions.h / 2 / scale - oy / scale;
        for (const n of nodes) {
          n.vx += (cx - n.x) * 0.0006;
          n.vy += (cy - n.y) * 0.0006;
        }

        for (const n of nodes) {
          if (dragRef.current?.nodeId === n.id) { n.vx = 0; n.vy = 0; continue; }
          n.vx *= damping; n.vy *= damping;
          n.x += n.vx; n.y += n.vy;
        }
      }

      // ── Drawing ──
      ctx!.clearRect(0, 0, dimensions.w, dimensions.h);
      ctx!.save();
      ctx!.translate(ox, oy);
      ctx!.scale(scale, scale);

      // Edges (smooth bezier)
      for (const edge of edges) {
        const a = nodeMap.get(edge.from), b = nodeMap.get(edge.to);
        if (!a || !b) continue;
        const isHi = edge.from === selectedEntityId || edge.to === selectedEntityId;
        const colA = KIND_COLORS[a.kind] ?? DEFAULT_COLOR;

        const startX = a.x + NODE_W / 2;
        const startY = a.y + NODE_H / 2;
        const endX = b.x - NODE_W / 2;
        const endY = b.y + NODE_H / 2;
        const cpOffset = Math.abs(endX - startX) * 0.45 + 50;

        ctx!.beginPath();
        ctx!.moveTo(startX, startY);
        ctx!.bezierCurveTo(startX + cpOffset, startY, endX - cpOffset, endY, endX, endY);
        ctx!.strokeStyle = isHi ? colA.accent : "rgba(255,255,255,0.08)";
        ctx!.lineWidth = isHi ? 2 : 1.5;
        ctx!.stroke();

        // Animated flow dots
        if (isHi) {
          const t = ((now / 1800) % 1);
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

        // End port dot
        ctx!.beginPath();
        ctx!.arc(endX, endY, PORT_R, 0, Math.PI * 2);
        ctx!.fillStyle = isHi ? colA.accent : "rgba(255,255,255,0.15)";
        ctx!.fill();
      }

      // Nodes (n8n-style rounded rect cards)
      for (const n of nodes) {
        const isSelected = n.id === selectedEntityId;
        const col = KIND_COLORS[n.kind] ?? DEFAULT_COLOR;

        // Shadow
        if (isSelected) {
          ctx!.shadowColor = col.accent + "44";
          ctx!.shadowBlur = 20;
          ctx!.shadowOffsetY = 4;
        }

        // Card body
        roundRect(ctx!, n.x - NODE_W / 2, n.y - NODE_H / 2, NODE_W, NODE_H, CORNER_R);
        ctx!.fillStyle = col.bg;
        ctx!.fill();
        ctx!.strokeStyle = isSelected ? col.accent : "rgba(255,255,255,0.1)";
        ctx!.lineWidth = isSelected ? 2 : 1;
        ctx!.stroke();

        ctx!.shadowColor = "transparent";
        ctx!.shadowBlur = 0;
        ctx!.shadowOffsetY = 0;

        // Header stripe
        ctx!.save();
        ctx!.beginPath();
        ctx!.roundRect(n.x - NODE_W / 2, n.y - NODE_H / 2, NODE_W, HEADER_H, [CORNER_R, CORNER_R, 0, 0]);
        ctx!.fillStyle = col.accent + "20";
        ctx!.fill();
        ctx!.restore();

        // Icon square
        const iconX = n.x - NODE_W / 2 + 10;
        const iconY = n.y - NODE_H / 2 + (NODE_H - 28) / 2 + 3;
        roundRect(ctx!, iconX, iconY, 28, 28, 5);
        ctx!.fillStyle = col.accent + "22";
        ctx!.fill();
        ctx!.font = `600 10px 'DM Sans', sans-serif`;
        ctx!.fillStyle = col.accent;
        ctx!.textAlign = "center";
        ctx!.textBaseline = "middle";
        ctx!.fillText(col.icon.toUpperCase(), iconX + 14, iconY + 14);

        // Label
        ctx!.font = `500 12px 'DM Sans', sans-serif`;
        ctx!.fillStyle = "#eeeef5";
        ctx!.textAlign = "left";
        ctx!.textBaseline = "middle";
        const maxLabelW = NODE_W - 58;
        const label = truncateText(ctx!, n.label, maxLabelW);
        ctx!.fillText(label, iconX + 36, n.y - 3);

        // Subtitle (file path)
        ctx!.font = `400 9.5px 'JetBrains Mono', monospace`;
        ctx!.fillStyle = "#6c6c8a";
        const shortPath = n.filePath.length > 22 ? "..." + n.filePath.slice(-19) : n.filePath;
        ctx!.fillText(shortPath, iconX + 36, n.y + 11);

        // Connection ports (left & right)
        // Left port
        ctx!.beginPath();
        ctx!.arc(n.x - NODE_W / 2, n.y + NODE_H / 2, PORT_R, 0, Math.PI * 2);
        ctx!.fillStyle = col.bg;
        ctx!.fill();
        ctx!.strokeStyle = isSelected ? col.accent : "rgba(255,255,255,0.2)";
        ctx!.lineWidth = 1.5;
        ctx!.stroke();

        // Right port
        ctx!.beginPath();
        ctx!.arc(n.x + NODE_W / 2, n.y + NODE_H / 2, PORT_R, 0, Math.PI * 2);
        ctx!.fillStyle = col.bg;
        ctx!.fill();
        ctx!.strokeStyle = isSelected ? col.accent : "rgba(255,255,255,0.2)";
        ctx!.stroke();
      }

      ctx!.restore();
      animRef.current = requestAnimationFrame(tick);
    }

    animRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(animRef.current); };
  }, [dimensions, edges, selectedEntityId]);

  // Hit testing helper
  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
      x: (sx - offsetRef.current.x) / scaleRef.current,
      y: (sy - offsetRef.current.y) / scaleRef.current,
    };
  }, []);

  const hitTest = useCallback((wx: number, wy: number): NodeLayout | null => {
    const nodes = nodesRef.current;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (wx >= n.x - NODE_W / 2 && wx <= n.x + NODE_W / 2 && wy >= n.y - NODE_H / 2 && wy <= n.y + NODE_H / 2) {
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
      tickCountRef.current = 0; // re-run physics briefly
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
    const newScale = Math.max(0.2, Math.min(3, oldScale * zoom));
    // Zoom toward cursor
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function bezierPoint(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "...").width > maxW) {
    t = t.slice(0, -1);
  }
  return t + "...";
}
