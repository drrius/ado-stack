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
  --muted: #6f6862;
  --faint: #948c84;
  --line: #cbc3b6;
  --card: #fffdf8;
  --card-border: #e2dbcd;
  --card-shadow: 0 1px 2px rgba(28, 25, 23, 0.06);
  --synced: #15803d;
  --restack: #b45309;
  --conflict: #b91c1c;
  --diverge: #6d28d9;
  --trunk: #57534e;
  --link: #1d4ed8;
  --accent: #1d4ed8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1917;
    --fg: #f2efec;
    --muted: #a8a199;
    --faint: #7d766f;
    --line: #45403b;
    --card: #262220;
    --card-border: #38332f;
    --card-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
    --synced: #4cc477;
    --restack: #e8a33d;
    --conflict: #f07d70;
    --diverge: #b7a4f2;
    --trunk: #a8a199;
    --link: #8fb4f5;
    --accent: #8fb4f5;
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
  padding: 24px 32px 16px;
}
.masthead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.repo {
  color: var(--faint);
  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--card-border);
  border-radius: 999px;
  background: var(--card);
  color: var(--muted);
  font-size: 12px;
}
.chip b {
  color: var(--fg);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
.chip.warn { color: var(--restack); border-color: color-mix(in srgb, var(--restack) 35%, var(--card-border)); }
.chip.warn b { color: var(--restack); }
.chip.bad { color: var(--conflict); border-color: color-mix(in srgb, var(--conflict) 35%, var(--card-border)); }
.chip.bad b { color: var(--conflict); }
.chip .mono {
  font: 11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--fg);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-top: 14px;
  color: var(--faint);
  font-size: 11.5px;
}
.legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.legend svg {
  display: inline;
}
.canvas {
  width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
}
.plane {
  position: relative;
}
.edges {
  position: absolute;
  inset: 0;
  display: block;
}
.edges path {
  fill: none;
  stroke: var(--line);
  stroke-width: 1.5;
}
.card {
  position: absolute;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--card-border);
  border-radius: 8px;
  background: var(--card);
  box-shadow: var(--card-shadow);
  transition: border-color 120ms ease;
}
.card:hover {
  border-color: color-mix(in srgb, var(--fg) 25%, var(--card-border));
}
.card.s-conflict {
  border-color: color-mix(in srgb, var(--conflict) 35%, var(--card-border));
}
.card.current {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent), var(--card-shadow);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.glyph {
  flex: none;
  display: block;
}
.s-synced .glyph { color: var(--synced); }
.s-restack .glyph { color: var(--restack); }
.s-conflict .glyph { color: var(--conflict); }
.s-diverge .glyph { color: var(--diverge); }
.s-trunk .glyph { color: var(--trunk); }
.branch {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 12.5px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.badge {
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--bg);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--muted);
}
.meta a {
  color: var(--link);
  text-decoration: none;
  font-variant-numeric: tabular-nums;
}
.meta a:hover {
  text-decoration: underline;
}
.state {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
}
.state-open { color: var(--muted); }
.state-approved { color: var(--synced); }
.state-rejected { color: var(--conflict); }
.state-completed { color: var(--diverge); }
.state-abandoned, .state-none, .state-unknown { color: var(--faint); }
.drift {
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: var(--diverge);
}
.pre {
  margin-top: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--muted);
}
.pre-conflict {
  color: var(--conflict);
  font-weight: 600;
}
.pre-error {
  color: var(--restack);
}
.files {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--conflict) 18%, transparent);
}
.file {
  display: flex;
  min-width: 0;
  font: 11px/16px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.file-dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--conflict) 45%, var(--muted));
}
.file-base {
  flex: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--conflict) 80%, var(--fg));
}
</style>
</head>
<body>
<header>
  <div class="masthead">
    <h1>ado-stack</h1>
    <span class="repo" id="repo"></span>
  </div>
  <div class="chips" id="summary"></div>
  <div class="legend" id="legend"></div>
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
const CARD_W = 324;
const COL = CARD_W + 44;
const GAP = 18;
const PAD_X = 32;
const PAD_Y = 20;
const FILE_ROW = 16;
const ANCHOR = 21;
const SVG_NS = "http://www.w3.org/2000/svg";
const nodes = [];

function statusOf(node) {
  if (node.pullRequestStatus === "trunk") return "trunk";
  if (node.preflight && node.preflight.kind === "conflicts") return "conflict";
  if (node.needsRestack) return "restack";
  if (node.diverged) return "diverge";
  return "synced";
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

function cardHeight(node) {
  if (statusOf(node) === "trunk") return 40;
  const files = node.preflight && node.preflight.kind === "conflicts" ? node.preflight.files.length : 0;
  const base = preflightLabel(node) ? 82 : 62;
  return base + (files ? files * FILE_ROW + 11 : 0);
}

function blockHeight(node) {
  return cardHeight(node) + GAP;
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
  height: forest.length === 0 ? 60 : forest.reduce((sum, node) => sum + node.height, 0),
};
nodes.unshift(trunk);

const TRUNK_SPAN = 160;

function columnX(depth) {
  return depth === 0 ? PAD_X : PAD_X + TRUNK_SPAN + (depth - 1) * COL;
}

function place(node, y0) {
  let y = y0;
  const anchors = [];
  for (const child of node.children) {
    place(child, y);
    anchors.push(child.anchor);
    y += child.height;
  }
  node.x = columnX(node.depth);
  node.anchor = anchors.length
    ? (anchors[0] + anchors[anchors.length - 1]) / 2
    : y0 + ANCHOR;
  node.top = node.anchor - ANCHOR;
}

place(trunk, PAD_Y);

const width = Math.max(...nodes.map((node) => node.x)) + CARD_W + PAD_X;
const height = Math.max(trunk.height + PAD_Y * 2, 160);
const canvas = document.getElementById("canvas");
const plane = document.createElement("div");
plane.className = "plane";
plane.style.width = width + "px";
plane.style.height = height + "px";
canvas.appendChild(plane);

const edges = document.createElementNS(SVG_NS, "svg");
edges.setAttribute("class", "edges");
edges.setAttribute("width", String(width));
edges.setAttribute("height", String(height));
edges.setAttribute("viewBox", "0 0 " + width + " " + height);
plane.appendChild(edges);

function glyph(status, current) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "glyph");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 14 14");
  let shape;
  if (status === "conflict") {
    shape = document.createElementNS(SVG_NS, "rect");
    shape.setAttribute("x", "2");
    shape.setAttribute("y", "2");
    shape.setAttribute("width", "10");
    shape.setAttribute("height", "10");
    shape.setAttribute("rx", "2");
    shape.setAttribute("fill", "currentColor");
  } else if (status === "restack") {
    shape = document.createElementNS(SVG_NS, "polygon");
    shape.setAttribute("points", "7,0.8 13.2,7 7,13.2 0.8,7");
    shape.setAttribute("fill", "currentColor");
  } else if (status === "diverge") {
    shape = document.createElementNS(SVG_NS, "circle");
    shape.setAttribute("cx", "7");
    shape.setAttribute("cy", "7");
    shape.setAttribute("r", "4.75");
    shape.setAttribute("fill", "none");
    shape.setAttribute("stroke", "currentColor");
    shape.setAttribute("stroke-width", "2.5");
  } else {
    shape = document.createElementNS(SVG_NS, "circle");
    shape.setAttribute("cx", "7");
    shape.setAttribute("cy", "7");
    shape.setAttribute("r", status === "trunk" ? "4" : "5.5");
    shape.setAttribute("fill", "currentColor");
  }
  svg.appendChild(shape);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stateLabel(node) {
  const status = node.pullRequestStatus;
  if (status === "none") return "LOCAL";
  if (status === "unknown") return "UNKNOWN";
  return String(status || "").toUpperCase();
}

function card(node) {
  const status = statusOf(node);
  const root = el("div", "card s-" + status + (node.current ? " current" : ""));
  root.style.left = node.x + "px";
  root.style.top = node.top + "px";
  root.style.width = (status === "trunk" ? TRUNK_SPAN - 40 : CARD_W) + "px";

  const head = el("div", "card-head");
  head.appendChild(glyph(status, node.current));
  const branch = el("span", "branch", node.branch);
  branch.title = node.branch;
  head.appendChild(branch);
  if (node.current) head.appendChild(el("span", "badge", "current"));
  root.appendChild(head);

  if (status === "trunk") {
    const meta = el("div", "meta");
    meta.appendChild(el("span", "", "trunk"));
    root.appendChild(meta);
    root.style.width = "auto";
    root.style.maxWidth = TRUNK_SPAN - 24 + "px";
    root.style.paddingRight = "16px";
    return root;
  }

  const meta = el("div", "meta");
  const pr = node.pullRequestNumber ? "#" + node.pullRequestNumber : "no-pr";
  if (node.url) {
    const link = document.createElement("a");
    link.href = node.url;
    link.textContent = pr;
    meta.appendChild(link);
  } else {
    meta.appendChild(el("span", "", pr));
  }
  meta.appendChild(el("span", "state state-" + node.pullRequestStatus, stateLabel(node)));
  if (node.diverged) {
    meta.appendChild(el("span", "drift", "\\u2191" + node.ahead + " \\u2193" + node.behind));
  }
  root.appendChild(meta);

  const preflight = node.preflight;
  const label = preflightLabel(node);
  if (label) {
    const kind = preflight.kind === "conflicts" ? "pre-conflict" : preflight.kind === "error" ? "pre-error" : "pre-clean";
    const row = el("div", "pre " + kind, label);
    row.title = label;
    root.appendChild(row);
  }
  if (preflight && preflight.kind === "conflicts") {
    const files = el("div", "files");
    for (const file of preflight.files) {
      const row = el("div", "file");
      row.title = file;
      const slash = file.lastIndexOf("/");
      if (slash > 0) {
        row.appendChild(el("span", "file-dir", file.slice(0, slash + 1)));
        row.appendChild(el("span", "file-base", file.slice(slash + 1)));
      } else {
        row.appendChild(el("span", "file-base", file));
      }
      files.appendChild(row);
    }
    root.appendChild(files);
  }
  return root;
}

const cardByBranch = new Map();
for (const node of nodes) {
  const rendered = card(node);
  plane.appendChild(rendered);
  cardByBranch.set(node.branch, rendered);
}

for (const node of nodes) {
  const fromCard = cardByBranch.get(node.branch);
  const fromX = node.x + (fromCard ? fromCard.offsetWidth : CARD_W);
  for (const child of node.children) {
    const path = document.createElementNS(SVG_NS, "path");
    const mid = (fromX + child.x) / 2;
    path.setAttribute(
      "d",
      "M " + fromX + " " + node.anchor + " C " + mid + " " + node.anchor + " " + mid + " " + child.anchor + " " + child.x + " " + child.anchor,
    );
    edges.appendChild(path);
  }
}

function chip(parent, html, cls) {
  const item = el("span", "chip" + (cls ? " " + cls : ""));
  item.innerHTML = html;
  parent.appendChild(item);
  return item;
}

function esc(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const branchCount = nodes.length - 1;
const restack = nodes.filter((node) => node.needsRestack).length;
const conflicts = nodes.filter((node) => node.preflight && node.preflight.kind === "conflicts").length;
const clean = nodes.filter((node) => node.depth > 0 && statusOf(node) === "synced").length;

document.getElementById("repo").textContent = model.project + " / " + model.repository;

const summary = document.getElementById("summary");
chip(summary, "<b>" + branchCount + "</b> branch" + (branchCount === 1 ? "" : "es") + " from <span class=\\"mono\\">" + esc(model.defaultBranch) + "</span>");
if (clean) chip(summary, "<b>" + clean + "</b> synced");
if (restack) chip(summary, "<b>" + restack + "</b> need" + (restack === 1 ? "s" : "") + " restack", "warn");
if (conflicts) chip(summary, "<b>" + conflicts + "</b> conflict" + (conflicts === 1 ? "" : "s"), "bad");
chip(summary, "on <span class=\\"mono\\">" + esc(model.currentBranch) + "</span>");

const LEGEND = [
  ["synced", "synced"],
  ["restack", "needs restack"],
  ["conflict", "conflicts"],
  ["diverge", "diverged"],
];
const legend = document.getElementById("legend");
for (const [status, label] of LEGEND) {
  const item = el("span", "s-" + status);
  item.appendChild(glyph(status, false));
  item.appendChild(document.createTextNode(label));
  legend.appendChild(item);
}
`;
}
