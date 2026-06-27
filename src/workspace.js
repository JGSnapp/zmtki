import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

let workspaceDir = path.resolve(process.env.WORKSPACE_DIR || path.join(process.cwd(), "workspace"));

export function getWorkspaceDir() {
  return workspaceDir;
}

export function setWorkspaceDir(next) {
  const resolved = path.resolve(String(next || "").trim());
  if (!resolved) throw new Error("workspace path is required");
  workspaceDir = resolved;
  process.env.WORKSPACE_DIR = resolved;
  return workspaceDir;
}

/** @deprecated use getWorkspaceDir() */
export const WORKSPACE_DIR = workspaceDir;
export const PLANE_FILE = "codex-miro-plane.json";
export const NOTIFY_FILE = ".codex-miro-notify";
const PLANE_PREFIX = "codex-miro-plane";

let notifyTimer = null;
export function touchWorkspaceNotify() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(async () => {
    try {
      await fs.mkdir(getWorkspaceDir(), { recursive: true });
      await fs.writeFile(path.join(getWorkspaceDir(), NOTIFY_FILE), `${Date.now()}\n`, "utf8");
    } catch {
      // ignore notify failures
    }
    try {
      const port = Number(process.env.NOTIFY_PORT || process.env.PORT || 8080);
      await fetch(`http://127.0.0.1:${port}/api/notify`, {
        method: "POST",
        signal: AbortSignal.timeout(500)
      });
    } catch {
      // server may be offline while MCP writes to disk
    }
  }, 40);
}

const DEFAULT_BOARD = {
  version: 1,
  name: "Local board",
  updatedAt: new Date().toISOString(),
  elements: []
};

export function newId(prefix = "el") {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export async function ensureWorkspace() {
  await fs.mkdir(getWorkspaceDir(), { recursive: true });
  const planePath = await resolvePlanePath();
  try {
    await fs.access(planePath);
  } catch {
    await writeBoard(DEFAULT_BOARD);
  }
}

async function resolvePlanePath() {
  const fixed = path.join(getWorkspaceDir(), PLANE_FILE);
  try {
    await fs.access(fixed);
    return fixed;
  } catch {
    // fall through
  }
  let entries = [];
  try {
    entries = await fs.readdir(getWorkspaceDir());
  } catch {
    return fixed;
  }
  const legacy = entries
    .filter((name) => name.startsWith(PLANE_PREFIX) && name.endsWith(".json") && name !== PLANE_FILE)
    .sort()
    .reverse();
  if (legacy.length) return path.join(getWorkspaceDir(), legacy[0]);
  return fixed;
}

export async function readBoard() {
  await ensureWorkspace();
  const planePath = await resolvePlanePath();
  const raw = await fs.readFile(planePath, "utf8");
  return normalizeBoard(JSON.parse(raw));
}

export async function writeBoard(board) {
  const normalized = normalizeBoard(board);
  normalized.updatedAt = nowIso();
  await fs.mkdir(getWorkspaceDir(), { recursive: true });
  const planePath = path.join(getWorkspaceDir(), PLANE_FILE);
  const tmp = `${planePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tmp, planePath);
  await syncCardsToMarkdown(normalized.elements);
  touchWorkspaceNotify();
  return normalized;
}

export async function updateBoard(mutator) {
  const board = await readBoard();
  const result = await mutator(board);
  const next = result && result.version ? result : board;
  return writeBoard(next);
}

async function syncCardsToMarkdown(elements) {
  for (const element of elements) {
    if (element.type !== "card") continue;
    await writeCardMarkdown(element);
  }
}

export async function writeCardMarkdown(card) {
  if (!card || card.type !== "card") return;
  const meta = card.meta || {};
  const fileName = meta.sourceFile || `${safeFileBase(meta.title || card.id || "card")}.md`;
  meta.sourceFile = fileName;
  const filePath = path.join(getWorkspaceDir(), fileName);
  const lines = ["---"];
  if (meta.title) lines.push(`title: ${JSON.stringify(meta.title)}`);
  if (meta.caption) lines.push(`caption: ${JSON.stringify(meta.caption)}`);
  const imageRef = meta.imageFile || (meta.image && !/^https?:/i.test(meta.image) ? meta.image : "");
  if (imageRef) lines.push(`image: ${JSON.stringify(imageRef)}`);
  lines.push("---", "");
  const body = `${lines.join("\n")}${card.text || ""}\n`;
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, filePath);
}

function safeFileBase(name) {
  return sanitizeFileName(String(name || "card")).replace(/\.[^.]+$/, "").slice(0, 60) || "card";
}

function sanitizeFileName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "file";
}

export function normalizeBoard(input = {}) {
  const board = {
    version: Number(input.version) || 1,
    name: typeof input.name === "string" ? input.name : "Local board",
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : nowIso(),
    elements: Array.isArray(input.elements) ? input.elements.map(normalizeElement).filter(Boolean) : [],
    selectedIds: normalizeStringArray(input.selectedIds)
  };
  return board;
}

const TYPE_DEFAULTS = {
  card: { width: 260, height: 180, fill: "#ffffff", stroke: "#cbd5e1", strokeWidth: 1 },
  file: { width: 150, height: 132, fill: "#ffffff", stroke: "#cbd5e1", strokeWidth: 1 },
  image: { width: 240, height: 160, fill: "transparent" }
};

export function normalizeElement(input = {}) {
  if (!input || typeof input !== "object") return null;
  const type = String(input.type || "rect");
  const id = String(input.id || newId(type));
  const def = TYPE_DEFAULTS[type] || {};
  const base = {
    id,
    type,
    x: num(input.x, 0),
    y: num(input.y, 0),
    width: num(input.width, def.width ?? 160),
    height: num(input.height, def.height ?? 96),
    rotation: num(input.rotation, 0),
    fill: str(input.fill, def.fill ?? "#ffffff"),
    stroke: str(input.stroke, def.stroke ?? "#1f2937"),
    strokeWidth: num(input.strokeWidth, def.strokeWidth ?? 2),
    opacity: clamp(num(input.opacity, 1), 0, 1),
    text: str(input.text, ""),
    fontSize: num(input.fontSize, 18),
    fontFamily: str(input.fontFamily, "Inter, Arial, sans-serif"),
    points: Array.isArray(input.points) ? input.points.map(normalizePoint).filter(Boolean) : [],
    start: normalizePoint(input.start) || null,
    end: normalizePoint(input.end) || null,
    url: str(input.url, ""),
    createdAt: str(input.createdAt, nowIso()),
    updatedAt: nowIso(),
    meta: normalizeMeta(input.meta, type)
  };
  return base;
}

function normalizeMeta(meta, type) {
  const base = meta && typeof meta === "object" ? { ...meta } : {};
  if (type === "card") {
    return {
      ...base,
      title: str(base.title, ""),
      caption: str(base.caption, ""),
      image: str(base.image, ""),
      imageFile: str(base.imageFile, ""),
      sourceFile: str(base.sourceFile, ""),
      planeHidden: Boolean(base.planeHidden)
    };
  }
  if (type === "image" || type === "file") {
    return {
      ...base,
      sourceFile: str(base.sourceFile, ""),
      planeHidden: Boolean(base.planeHidden)
    };
  }
  return base;
}

export function mergeElement(existing, patch) {
  const mergedMeta = patch.meta && typeof patch.meta === "object"
    ? { ...(existing.meta || {}), ...patch.meta }
    : existing.meta;
  return normalizeElement({
    ...existing,
    ...patch,
    id: existing.id,
    type: patch.type || existing.type,
    createdAt: existing.createdAt || patch.createdAt,
    meta: mergedMeta
  });
}

function normalizePoint(point) {
  if (!point || typeof point !== "object") return null;
  return { x: num(point.x, 0), y: num(point.y, 0) };
}

function normalizeStringArray(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (typeof item === "string" && item && !seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
