// Sync workspace folder files → board plane elements.
// Layout lives in zmtki-plane.json; file *content* stays on disk (.md, images, etc.).

import path from "node:path";
import { promises as fs } from "node:fs";
import {
  getWorkspaceDir,
  PLANE_FILE,
  newId,
  normalizeElement,
  nowIso
} from "./store.js";

const PLANE_PREFIX = "zmtki-plane";
const LEGACY_PLANE_PREFIX = "codex-miro-plane";
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);

export function isHiddenWorkspaceFile(name) {
  const n = String(name || "");
  return n.startsWith(".") || n.startsWith("_");
}

export function isPlaneFileName(name) {
  return (
    name === PLANE_FILE
    || ((name.startsWith(PLANE_PREFIX) || name.startsWith(LEGACY_PLANE_PREFIX)) && name.endsWith(".json"))
  );
}

export function workspaceFileUrl(name) {
  return `/api/workspace/file?name=${encodeURIComponent(name)}`;
}

function extensionOf(name) {
  const m = String(name).match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : "";
}

function isImageName(name) {
  return IMAGE_EXT.has(extensionOf(name));
}

function layoutPoint(index) {
  const cols = 4;
  return {
    x: -360 + (index % cols) * 220,
    y: -240 + Math.floor(index / cols) * 180
  };
}

function stripExtension(name) {
  return String(name || "file").replace(/\.[^.]+$/, "");
}

function firstMarkdownHeading(body) {
  const m = String(body || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

function parseFrontmatterScalar(value) {
  const v = String(value || "").trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseMdFile(text) {
  const raw = String(text || "").replace(/\r\n?/g, "\n");
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw };
  const end = raw.indexOf("\n---", 4);
  if (end < 0) return { meta: {}, body: raw };
  const fm = raw.slice(4, end).trim();
  const meta = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    meta[m[1]] = parseFrontmatterScalar(m[2]);
  }
  return { meta, body: raw.slice(end + 4).replace(/^\n/, "") };
}

function collectMdImageRefs(parsedItems) {
  const refs = new Set();
  for (const parsed of parsedItems) {
    const image = parsed.meta?.image;
    if (image && !/^https?:/i.test(String(image))) refs.add(path.basename(String(image)));
    const text = parsed.body || "";
    for (const match of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      const ref = match[1];
      if (ref && !/^https?:/i.test(ref)) refs.add(path.basename(ref));
    }
  }
  return refs;
}

export async function listWorkspaceFileNames(dir = getWorkspaceDir()) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && !isHiddenWorkspaceFile(e.name) && !isPlaneFileName(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * Merge disk files into board.elements. Preserves x/y/size for known sourceFile keys.
 * Freehand elements (no sourceFile) are kept when merge=true.
 */
export async function syncBoardFromWorkspace(board, { merge = true } = {}) {
  const dir = getWorkspaceDir();
  const files = await listWorkspaceFileNames(dir);
  const mdFiles = files.filter((n) => extensionOf(n) === "md");
  const imageFiles = files.filter((n) => isImageName(n));
  const otherFiles = files.filter((n) => extensionOf(n) !== "md" && !isImageName(n));

  const mdItems = [];
  for (const name of mdFiles) {
    try {
      const text = await fs.readFile(path.join(dir, name), "utf8");
      mdItems.push({ name, parsed: parseMdFile(text) });
    } catch { /* skip unreadable */ }
  }
  const referencedImages = collectMdImageRefs(mdItems.map((i) => i.parsed));

  const bySource = new Map();
  const freehand = [];
  for (const element of board.elements || []) {
    const key = element.meta?.sourceFile;
    if (key) bySource.set(key, element);
    else freehand.push(element);
  }

  const next = merge ? [...freehand] : [];
  let index = next.length;
  let added = 0;
  let updated = 0;

  for (const { name, parsed } of mdItems) {
    const existing = bySource.get(name);
    const point = existing ? { x: existing.x, y: existing.y } : layoutPoint(index++);
    const imageRef = parsed.meta?.image ? path.basename(String(parsed.meta.image)) : "";
    const card = existing && existing.type === "card"
      ? { ...existing }
      : normalizeElement({
        id: newId("card"),
        type: "card",
        x: point.x,
        y: point.y,
        text: parsed.body,
        meta: { title: "", caption: "", sourceFile: name }
      });
    if (existing) updated++; else added++;
    card.x = point.x;
    card.y = point.y;
    if (existing) {
      card.width = existing.width;
      card.height = existing.height;
      card.rotation = existing.rotation || 0;
      card.id = existing.id;
    }
    card.text = parsed.body;
    card.meta = {
      ...(card.meta || {}),
      title: parsed.meta.title || firstMarkdownHeading(parsed.body) || stripExtension(name),
      caption: parsed.meta.caption || "",
      image: imageRef ? workspaceFileUrl(imageRef) : (parsed.meta.image || ""),
      imageFile: imageRef || "",
      sourceFile: name,
      planeHidden: existing?.meta?.planeHidden || false
    };
    next.push(card);
    bySource.delete(name);
  }

  for (const name of imageFiles) {
    const referenced = referencedImages.has(name);
    const existing = bySource.get(name);
    const point = existing ? { x: existing.x, y: existing.y } : layoutPoint(index++);
    const image = existing && existing.type === "image"
      ? { ...existing }
      : normalizeElement({
        id: newId("image"),
        type: "image",
        x: point.x,
        y: point.y,
        url: workspaceFileUrl(name),
        text: name,
        meta: { sourceFile: name }
      });
    if (existing) updated++; else added++;
    image.x = point.x;
    image.y = point.y;
    if (existing) {
      image.width = existing.width;
      image.height = existing.height;
      image.rotation = existing.rotation || 0;
      image.id = existing.id;
    }
    image.url = workspaceFileUrl(name);
    image.text = name;
    image.meta = {
      ...(image.meta || {}),
      sourceFile: name,
      planeHidden: existing ? Boolean(existing.meta?.planeHidden) : referenced
    };
    next.push(image);
    bySource.delete(name);
  }

  for (const name of otherFiles) {
    const existing = bySource.get(name);
    const point = existing ? { x: existing.x, y: existing.y } : layoutPoint(index++);
    const fileEl = existing && existing.type === "file"
      ? { ...existing }
      : normalizeElement({
        id: newId("file"),
        type: "file",
        x: point.x,
        y: point.y,
        text: name,
        meta: { fileName: name, extension: extensionOf(name), sourceFile: name }
      });
    if (existing) updated++; else added++;
    fileEl.x = point.x;
    fileEl.y = point.y;
    if (existing) {
      fileEl.width = existing.width;
      fileEl.height = existing.height;
      fileEl.rotation = existing.rotation || 0;
      fileEl.id = existing.id;
    }
    fileEl.text = name;
    fileEl.meta = {
      ...(fileEl.meta || {}),
      fileName: name,
      extension: extensionOf(name),
      sourceFile: name,
      planeHidden: existing?.meta?.planeHidden || false
    };
    next.push(fileEl);
    bySource.delete(name);
  }

  if (merge) {
    for (const orphan of bySource.values()) next.push(orphan);
  }

  const removed = merge ? 0 : bySource.size;
  return {
    board: {
      ...board,
      updatedAt: nowIso(),
      elements: next.map((e) => normalizeElement(e)).filter(Boolean)
    },
    stats: { added, updated, removed, fileCount: files.length }
  };
}
