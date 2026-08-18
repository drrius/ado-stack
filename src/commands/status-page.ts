import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { StatusJson } from "./status-render.ts";

export function statusPagePath(gitDir: string): string {
  return `${gitDir.replace(/\/+$/, "")}/ado-stack/status.html`;
}

export function renderStatusHtml(model: StatusJson): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ado-stack</title>
<style>
:root {
  --bg: #f4f1ea;
  --fg: #1c1917;
  --muted: #57534e;
  --line: #a8a29e;
  --card: #fffcf6;
  --synced: #15803d;
  --restack: #b45309;
  --conflict: #b91c1c;
  --diverge: #6d28d9;
  --trunk: #44403c;
  --link: #1d4ed8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1917;
    --fg: #f5f5f4;
    --muted: #a8a29e;
    --line: #57534e;
    --card: #292524;
    --synced: #4ade80;
    --restack: #fbbf24;
    --conflict: #f87171;
    --diverge: #c4b5fd;
    --trunk: #d6d3d1;
    --link: #93c5fd;
  }
}
html, body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.45 ui-sans-serif, system-ui, sans-serif;
  overflow-x: hidden;
}
header {
  padding: 20px 24px 8px;
}
h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}
.sub {
  color: var(--muted);
  margin-top: 4px;
}
.canvas {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}
svg {
  display: block;
}
.node-title {
  font-weight: 650;
  font-size: 13px;
}
.node-meta, .node-preflight, .node-files {
  fill: var(--muted);
  font-size: 11px;
}
.node-files {
  fill: var(--conflict);
}
a {
  fill: var(--link);
}
</style>
</head>
<body>
<header>
  <h1>ado-stack</h1>
  <div class="sub" id="summary"></div>
</header>
<div class="canvas" id="canvas"></div>
<script type="application/json" id="model">${embedJson(model)}</script>
<script>
${pageScript()}
</script>
</body>
</html>
`;
}

export async function writeStatusPage(dest: string, model: StatusJson): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  await Bun.write(dest, renderStatusHtml(model));
  return dest;
}

export async function openStatusPage(path: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", path]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", path]
        : ["xdg-open", path];
  const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`${command[0]} exited ${exitCode}.`);
  }
}

function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function pageScript(): string {
  return `const model = JSON.parse(document.getElementById("model").textContent);
const COL = 260;
const ROW = 128;
const FILE_ROW = 14;
const nodes = [];

function blockHeight(node) {
  const files = node.preflight && node.preflight.kind === "conflicts" ? node.preflight.files.length : 0;
  return Math.max(ROW, 80 + files * FILE_ROW);
}

function walk(node, depth) {
  const children = (node.children || []).map((child) => walk(child, depth + 1));
  const childSpan = children.reduce((sum, child) => sum + child.height, 0);
  const height = children.length === 0 ? blockHeight(node) : Math.max(blockHeight(node), childSpan);
  const laid = { ...node, depth, children, height };
  nodes.push(laid);
  return laid;
}

const forest = (model.forest || []).map((node) => walk(node, 1));
const trunk = {
  branch: model.defaultBranch,
  parent: "",
  current: model.currentBranch === model.defaultBranch,
  pullRequestNumber: null,
  pullRequestStatus: "trunk",
  title: null,
  url: null,
  needsRestack: false,
  diverged: false,
  ahead: 0,
  behind: 0,
  preflight: { kind: "not-needed" },
  depth: 0,
  children: forest,
  height: forest.length === 0 ? ROW : forest.reduce((sum, node) => sum + node.height, 0),
};
nodes.unshift(trunk);

function place(node, y0) {
  let y = y0;
  const childYs = [];
  for (const child of node.children) {
    place(child, y);
    childYs.push(child.y);
    y += child.height;
  }
  node.x = node.depth * COL + 48;
  node.y = childYs.length ? (childYs[0] + childYs[childYs.length - 1]) / 2 : y0 + 56;
}

place(trunk, 24);

const width = Math.max(...nodes.map((node) => node.x)) + 220;
const height = Math.max(trunk.height + 48, 200);
const canvas = document.getElementById("canvas");
const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
svg.setAttribute("width", String(width));
svg.setAttribute("height", String(height));
svg.setAttribute("viewBox", "0 0 " + width + " " + height);
canvas.appendChild(svg);

function color(node) {
  if (node.preflight && node.preflight.kind === "conflicts") return "var(--conflict)";
  if (node.needsRestack) return "var(--restack)";
  if (node.diverged) return "var(--diverge)";
  if (node.pullRequestStatus === "trunk") return "var(--trunk)";
  return "var(--synced)";
}

function shape(svgRoot, node) {
  const fill = color(node);
  if (node.preflight && node.preflight.kind === "conflicts") {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(node.x - 8));
    rect.setAttribute("y", String(node.y - 8));
    rect.setAttribute("width", "16");
    rect.setAttribute("height", "16");
    rect.setAttribute("rx", "2");
    rect.setAttribute("fill", fill);
    svgRoot.appendChild(rect);
    return;
  }
  if (node.needsRestack) {
    const diamond = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    diamond.setAttribute(
      "points",
      (node.x) + "," + (node.y - 9) + " " +
      (node.x + 9) + "," + (node.y) + " " +
      (node.x) + "," + (node.y + 9) + " " +
      (node.x - 9) + "," + (node.y),
    );
    diamond.setAttribute("fill", fill);
    svgRoot.appendChild(diamond);
    return;
  }
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  circle.setAttribute("cx", String(node.x));
  circle.setAttribute("cy", String(node.y));
  circle.setAttribute("r", node.current ? "8" : "7");
  circle.setAttribute("fill", fill);
  if (node.diverged) {
    circle.setAttribute("stroke", "var(--diverge)");
    circle.setAttribute("stroke-width", "3");
  }
  svgRoot.appendChild(circle);
}

for (const node of nodes) {
  for (const child of node.children) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const mid = (node.x + child.x) / 2;
    path.setAttribute(
      "d",
      "M " + node.x + " " + node.y + " C " + mid + " " + node.y + " " + mid + " " + child.y + " " + child.x + " " + child.y,
    );
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "var(--line)");
    path.setAttribute("stroke-width", "1.5");
    svg.appendChild(path);
  }
}

function text(x, y, value, className) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("class", className);
  el.textContent = value;
  svg.appendChild(el);
}

function preflightLabel(node) {
  const preflight = node.preflight;
  if (!preflight) return "";
  if (preflight.kind === "clean") return "restacks clean";
  if (preflight.kind === "conflicts") {
    return "conflicts in " + preflight.files.length + " file" + (preflight.files.length === 1 ? "" : "s");
  }
  if (preflight.kind === "error") return preflight.message;
  return "";
}

for (const node of nodes) {
  shape(svg, node);
  const labelX = node.x + 16;
  text(labelX, node.y - 10, node.branch, "node-title");
  const pr = node.pullRequestNumber ? "#" + node.pullRequestNumber : node.pullRequestStatus === "trunk" ? "trunk" : "no-pr";
  if (node.url) {
    const a = document.createElementNS("http://www.w3.org/2000/svg", "a");
    a.setAttribute("href", node.url);
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", String(labelX));
    t.setAttribute("y", String(node.y + 8));
    t.setAttribute("class", "node-meta");
    t.textContent = pr + "  " + String(node.pullRequestStatus || "").toUpperCase();
    a.appendChild(t);
    svg.appendChild(a);
  } else {
    text(labelX, node.y + 8, pr + (node.pullRequestStatus === "trunk" ? "" : "  " + String(node.pullRequestStatus || "").toUpperCase()), "node-meta");
  }
  const extra = preflightLabel(node);
  if (extra) {
    text(labelX, node.y + 24, extra, "node-preflight");
  }
  if (node.preflight && node.preflight.kind === "conflicts") {
    node.preflight.files.forEach((file, index) => {
      text(labelX, node.y + 38 + index * 14, file, "node-files");
    });
  }
}

const restack = nodes.filter((node) => node.needsRestack).length;
const conflicts = nodes.filter((node) => node.preflight && node.preflight.kind === "conflicts").length;
document.getElementById("summary").textContent =
  model.forest.length + " branches from " + model.defaultBranch +
  (restack ? " · " + restack + " need a restack" : "") +
  (conflicts ? " · " + conflicts + " conflict" : "") +
  " · current " + model.currentBranch;
`;
}
