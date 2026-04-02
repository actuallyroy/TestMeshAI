import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";

export interface DiscoveredTarget {
  type: "cdp" | "devserver";
  host: string;
  port: number;
  url?: string;
  title?: string;
  framework?: string;
}

const CDP_PORTS = [9222, 9229, 9230, 9333];
const DEV_SERVER_PORTS = [3000, 3001, 3002, 3456, 4200, 5173, 5174, 8000, 8080, 8081, 8888];

/** Discover all running dev servers and Chrome debugging instances */
export async function discoverTargets(host = "localhost"): Promise<DiscoveredTarget[]> {
  const results: DiscoveredTarget[] = [];

  // Check CDP ports
  const cdpChecks = CDP_PORTS.map(async (port) => {
    const tabs = await fetchCdpTabs(host, port);
    if (tabs) {
      for (const tab of tabs) {
        if (tab.type === "page") {
          results.push({
            type: "cdp",
            host,
            port,
            url: tab.url,
            title: tab.title,
          });
        }
      }
    }
  });

  // Check dev server ports
  const devChecks = DEV_SERVER_PORTS.map(async (port) => {
    const info = await probeDevServer(host, port);
    if (info) {
      results.push({
        type: "devserver",
        host,
        port,
        url: `http://${host}:${port}`,
        title: info.title,
        framework: info.framework,
      });
    }
  });

  await Promise.allSettled([...cdpChecks, ...devChecks]);

  // Deduplicate: if a CDP tab points to a dev server we found, merge them
  const cdpUrls = new Set(results.filter(r => r.type === "cdp").map(r => r.url));
  const deduped = results.filter(r => {
    if (r.type === "devserver" && cdpUrls.has(r.url)) return false;
    return true;
  });

  return deduped;
}

async function fetchCdpTabs(host: string, port: number): Promise<Array<{ type: string; url: string; title: string }> | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}/json`, { timeout: 800 }, (res) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function probeDevServer(host: string, port: number): Promise<{ title: string; framework: string } | null> {
  // First check if port is open
  const isOpen = await checkPort(host, port);
  if (!isOpen) return null;

  // Try to GET the page and detect framework
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${port}`, { timeout: 1000 }, (res) => {
      let data = "";
      res.on("data", (chunk: string) => { data += chunk; });
      res.on("end", () => {
        const title = extractTitle(data) || `Server on :${port}`;
        const framework = detectFramework(data);
        resolve({ title, framework });
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function checkPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

/** Launch Chrome with remote debugging and wait for it to be ready */
export async function launchChromeWithDebugging(
  targetUrl: string,
  cdpPort = 9222
): Promise<{ success: boolean; error?: string }> {
  const chromePaths = [
    "google-chrome",
    "google-chrome-stable",
    "chromium-browser",
    "chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];

  // Find which Chrome binary exists
  let chromeBin: string | null = null;
  for (const bin of chromePaths) {
    try {
      const which = spawn("which", [bin]);
      const found = await new Promise<boolean>((resolve) => {
        which.on("close", (code) => resolve(code === 0));
        which.on("error", () => resolve(false));
      });
      if (found) { chromeBin = bin; break; }
    } catch { continue; }
  }

  if (!chromeBin) {
    return { success: false, error: "Chrome/Chromium not found on this system" };
  }

  // Launch Chrome
  const userDataDir = `/tmp/testmesh-cdp-${cdpPort}`;
  const child = spawn(chromeBin, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    targetUrl,
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait for CDP port to become available (up to 8 seconds)
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const tabs = await fetchCdpTabs("localhost", cdpPort);
    if (tabs && tabs.some((t: { type: string }) => t.type === "page")) {
      return { success: true };
    }
  }

  return { success: false, error: "Chrome launched but CDP port not responding after 8s" };
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

function detectFramework(html: string): string {
  if (html.includes("__NEXT_DATA__") || html.includes("/_next/")) return "Next.js";
  if (html.includes("ng-version") || html.includes("ng-app")) return "Angular";
  if (html.includes("/src/main.tsx") || html.includes("/src/main.ts") || html.includes("/@vite")) return "Vite";
  if (html.includes("bundle.js") || html.includes("/static/js/")) return "React (CRA)";
  if (html.includes("react")) return "React";
  if (html.includes("vue")) return "Vue";
  if (html.includes("svelte")) return "Svelte";
  return "Unknown";
}
