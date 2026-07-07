import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import {
  ensureDataFile,
  mergeElement,
  newId,
  normalizeBoard,
  normalizeElement,
  readBoard,
  updateBoard,
  writeBoard,
  getWorkspaceDir,
  appendLlmContext,
  replaceLlmContext,
  readLlmContext,
  consumeLlmContext,
  clearLlmContext,
  readChat,
  appendChatMessage,
  readProviders,
  writeProviders,
  PLANE_FILE,
  NOTIFY_FILE
} from "./store.js";
import { listProviders, testProvider } from "./providers.js";
import { runAgent, regionSnapshot } from "./agent.js";
import { syncBoardFromWorkspace, isHiddenWorkspaceFile, isPlaneFileName } from "./workspaceSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "..", "public");
const host = process.env.HOST || "0.0.0.0";
const port = Number(process.env.PORT || 8080);
const clients = new Set();

await ensureDataFile();

const IMAGE_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon"
};
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, host, () => {
  console.log(`zmtki is running at http://${host}:${port}`);
  console.log(`Workspace: ${getWorkspaceDir()}`);
});

let watchTimer = null;
let watchSelfWrite = false;
let lastPlaneMtime = 0;
let lastNotifyMtime = 0;

function scheduleWorkspaceBroadcast() {
  if (watchSelfWrite) return;
  clearTimeout(watchTimer);
  watchTimer = setTimeout(() => broadcast("workspace:changed", { ts: Date.now() }), 120);
}

let syncTimer = null;

function scheduleWorkspaceSync() {
  if (watchSelfWrite) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      watchSelfWrite = true;
      const board = await readBoard();
      const { board: synced, stats } = await syncBoardFromWorkspace(board, { merge: true });
      if (stats.added || stats.updated) {
        await writeBoard(synced);
        broadcast("workspace:synced", stats);
      }
    } catch (error) {
      console.warn("workspace sync:", error.message);
    } finally {
      setTimeout(() => { watchSelfWrite = false; }, 400);
    }
  }, 300);
}

try {
  fs.watch(getWorkspaceDir(), { recursive: true }, (_event, filename) => {
    const name = String(filename || "");
    if (name && (isPlaneFileName(name) || isHiddenWorkspaceFile(name) && name.startsWith(".zmtki"))) {
      scheduleWorkspaceBroadcast();
      return;
    }
    scheduleWorkspaceSync();
    scheduleWorkspaceBroadcast();
  });
} catch (error) {
  console.warn(`Workspace watch unavailable: ${error.message}`);
}

function planeFilePath() {
  return path.join(getWorkspaceDir(), PLANE_FILE);
}

function notifyFilePath() {
  return path.join(getWorkspaceDir(), NOTIFY_FILE);
}

async function refreshWorkspaceWatchState() {
  try {
    const planeStat = await fs.stat(planeFilePath());
    lastPlaneMtime = planeStat.mtimeMs;
  } catch {
    lastPlaneMtime = 0;
  }
  try {
    const notifyStat = await fs.stat(notifyFilePath());
    lastNotifyMtime = notifyStat.mtimeMs;
  } catch {
    lastNotifyMtime = 0;
  }
}

await refreshWorkspaceWatchState();

setInterval(async () => {
  if (watchSelfWrite) return;
  try {
    let changed = false;
    try {
      const planeStat = await fs.stat(planeFilePath());
      if (lastPlaneMtime && planeStat.mtimeMs !== lastPlaneMtime) changed = true;
      lastPlaneMtime = planeStat.mtimeMs;
    } catch {
      lastPlaneMtime = 0;
    }
    try {
      const notifyStat = await fs.stat(notifyFilePath());
      if (lastNotifyMtime && notifyStat.mtimeMs !== lastNotifyMtime) changed = true;
      lastNotifyMtime = notifyStat.mtimeMs;
    } catch {
      lastNotifyMtime = 0;
    }
    if (changed) scheduleWorkspaceBroadcast();
  } catch {
    // ignore poll errors
  }
}, 800);

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/board") {
    let board = await readBoard();
    if (url.searchParams.get("sync") === "1") {
      const synced = await syncBoardFromWorkspace(board, { merge: true });
      board = synced.board;
      if (synced.stats.added || synced.stats.updated) {
        watchSelfWrite = true;
        try { board = await writeBoard(board); } finally {
          setTimeout(() => { watchSelfWrite = false; }, 400);
        }
      }
    }
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    res.end(JSON.stringify(board));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/workspace/sync") {
    const board = await readBoard();
    const { board: synced, stats } = await syncBoardFromWorkspace(board, { merge: true });
    watchSelfWrite = true;
    let saved = synced;
    try { saved = await writeBoard(synced); } finally {
      setTimeout(() => { watchSelfWrite = false; }, 400);
    }
    sendJson(res, 200, { ok: true, stats, board: saved });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workspace/file") {
    const name = String(url.searchParams.get("name") || "");
    if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) {
      sendJson(res, 400, { error: "invalid file name" });
      return;
    }
    const filePath = path.join(getWorkspaceDir(), name);
    try {
      const data = await fs.readFile(filePath);
      const ext = path.extname(name).slice(1).toLowerCase();
      const type = IMAGE_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: "file not found" });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workspace") {
    sendJson(res, 200, { path: getWorkspaceDir() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/open-folder") {
    openInExplorer(getWorkspaceDir());
    sendJson(res, 200, { ok: true, path: getWorkspaceDir() });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/board/revision") {
    const board = await readBoard();
    const ids = board.elements.map((element) => element.id).sort().join(",");
    sendJson(res, 200, {
      updatedAt: board.updatedAt,
      elementCount: board.elements.length,
      signature: `${board.updatedAt}|${ids}`
    });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/board") {
    const board = normalizeBoard(await readBody(req));
    const current = await readBoard();
    const incomingTs = Date.parse(board.updatedAt || 0);
    const currentTs = Date.parse(current.updatedAt || 0);
    if (currentTs && (!incomingTs || incomingTs < currentTs)) {
      sendJson(res, 409, {
        error: "conflict",
        message: "Server board is newer than the client copy.",
        board: current
      });
      return;
    }
    const saved = await persistBoard(board);
    sendJson(res, 200, saved);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/elements") {
    const body = await readBody(req);
    let created;
    const saved = await persistUpdate((board) => {
      created = normalizeElement({ ...body, id: body.id || newId(body.type || "el") });
      board.elements.push(created);
      return board;
    });
    sendJson(res, 201, created);
    return;
  }

  const elementMatch = url.pathname.match(/^\/api\/elements\/([^/]+)$/);
  if (elementMatch && req.method === "PATCH") {
    const id = decodeURIComponent(elementMatch[1]);
    const patch = await readBody(req);
    let updated = null;
    await persistUpdate((board) => {
      board.elements = board.elements.map((element) => {
        if (element.id !== id) return element;
        updated = mergeElement(element, patch);
        return updated;
      });
      return board;
    });
    if (!updated) {
      sendJson(res, 404, { error: "Element not found" });
      return;
    }
    sendJson(res, 200, updated);
    return;
  }

  if (elementMatch && req.method === "DELETE") {
    const id = decodeURIComponent(elementMatch[1]);
    let removed = false;
    await persistUpdate((board) => {
      const before = board.elements.length;
      board.elements = board.elements.filter((element) => element.id !== id);
      removed = board.elements.length !== before;
      return board;
    });
    if (!removed) {
      sendJson(res, 404, { error: "Element not found" });
      return;
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reset") {
    const saved = await persistBoard({ version: 1, name: "Local board", elements: [] });
    sendJson(res, 200, saved);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload") {
    await handleUpload(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/notify") {
    broadcast("workspace:changed", { ts: Date.now(), source: "notify" });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/llm-context") {
    const body = await readBody(req);
    let items = [];
    if (Array.isArray(body.items)) {
      items = body.items
        .filter((it) => it && (typeof it === "object"))
        .map((it) => ({
          id: String(it.id || `item_${Date.now().toString(36)}`),
          kind: String(it.kind || "element"),
          title: String(it.title || ""),
          text: String(it.text || ""),
          meta: it.meta || null
        }));
    } else if (Array.isArray(body.ids)) {
      // Resolve ids against the current board so the client can send just ids.
      const board = await readBoard();
      const wanted = new Set(body.ids.map(String));
      items = board.elements
        .filter((e) => wanted.has(String(e.id)))
        .map((e) => elementToContextItem(e));
    }
    let count;
    if (items.length && body.replace) count = await replaceLlmContext(items);
    else if (items.length) count = await appendLlmContext(items);
    else count = (await readLlmContext()).length;
    broadcast("llm-context:changed", { count });
    sendJson(res, 200, { ok: true, count });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/llm-context") {
    const peek = url.searchParams.get("peek") === "1" || url.searchParams.get("peek") === "true";
    const items = await consumeLlmContext({ peek });
    sendJson(res, 200, { count: items.length, items });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/llm-context/clear") {
    await clearLlmContext();
    broadcast("llm-context:changed", { count: 0 });
    sendJson(res, 200, { ok: true });
    return;
  }

  // ---------- providers (settings) ----------
  if (req.method === "GET" && url.pathname === "/api/providers") {
    sendJson(res, 200, await listProviders());
    return;
  }
  if (req.method === "PUT" && url.pathname === "/api/providers") {
    const body = await readBody(req);
    // Body shape: { providers: [{...}], activeId } — keys come back masked from
    // the UI; preserve real keys for entries that weren't edited.
    const current = await readProviders();
    const incoming = Array.isArray(body.providers) ? body.providers : [];
    const byId = new Map(current.providers.map((p) => [p.id, p]));
    const merged = incoming.map((p) => {
      const prev = byId.get(p.id);
      // Treat a masked key ("xxxx…xxxx") as "unchanged".
      const keyChanged = typeof p.apiKey === "string" && !/^[•x]{2,}…[•x]{2,}$/.test(p.apiKey) && p.apiKey !== "";
      return {
        id: String(p.id || `prov_${Date.now().toString(36)}`),
        kind: String(p.kind || "openai"),
        name: String(p.name || "Provider"),
        baseUrl: String(p.baseUrl || ""),
        apiKey: keyChanged ? p.apiKey : (prev?.apiKey || ""),
        model: String(p.model || ""),
        extraHeaders: prev?.extraHeaders || {}
      };
    });
    const saved = await writeProviders({ providers: merged, activeId: body.activeId || "" });
    broadcast("providers:changed", { activeId: saved.activeId });
    sendJson(res, 200, await listProviders());
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/providers/test") {
    const body = await readBody(req);
    // The UI sends a full record (possibly with a masked key); resolve the real key.
    const current = await readProviders();
    let provider = null;
    if (body.id) provider = current.providers.find((p) => p.id === body.id);
    if (!provider) provider = { ...body };
    else Object.assign(provider, body);
    const result = await testProvider(provider);
    sendJson(res, 200, result);
    return;
  }

  // ---------- chat (shared + per-agent) ----------
  if (req.method === "GET" && url.pathname === "/api/chat") {
    const channel = url.searchParams.get("channel") || "general";
    const all = await readChat();
    const filtered = all.filter((m) => channel === "*" || m.channel === channel);
    sendJson(res, 200, { channel, count: filtered.length, messages: filtered });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readBody(req);
    const channel = String(body.channel || "general");
    const msg = await appendChatMessage({
      channel,
      role: String(body.role || "user"),
      author: String(body.author || ""),
      text: String(body.text || "")
    });
    broadcast("chat:message", msg);
    sendJson(res, 201, msg);
    return;
  }

  // ---------- agents ----------
  if (req.method === "POST" && url.pathname === "/api/agents/run") {
    const body = await readBody(req);
    const agentId = String(body.agentId || "");
    if (!agentId) { sendJson(res, 400, { error: "agentId is required" }); return; }
    // Run asynchronously so the request returns immediately; results stream back
    // through the board + chat (SSE broadcasts). This keeps long agent loops from
    // blocking the HTTP response, and the UI shows live progress on the element.
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, queued: true, agentId }));
    runAgent(agentId, { input: String(body.input || ""), images: body.images || [], snapshotRenderer: regionSnapshotForRun })
      .catch((error) => console.error("agent run failed:", error));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    res.write(`event: ready\ndata: {}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function persistBoard(board) {
  watchSelfWrite = true;
  try {
    const saved = await writeBoard(board);
    broadcast("workspace:changed", { ts: Date.now(), source: "api" });
    await refreshWorkspaceWatchState();
    return saved;
  } finally {
    setTimeout(() => { watchSelfWrite = false; }, 400);
  }
}

async function persistUpdate(mutator) {
  watchSelfWrite = true;
  try {
    const saved = await updateBoard(mutator);
    broadcast("workspace:changed", { ts: Date.now(), source: "api" });
    await refreshWorkspaceWatchState();
    return saved;
  } finally {
    setTimeout(() => { watchSelfWrite = false; }, 400);
  }
}

function openInExplorer(dir) {
  const quoted = `"${dir}"`;
  if (process.platform === "win32") exec(`explorer ${quoted}`);
  else if (process.platform === "darwin") exec(`open ${quoted}`);
  else exec(`xdg-open ${quoted}`);
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);

  if (requestedPath.startsWith("/workspace/")) {
    const rel = requestedPath.slice("/workspace".length);
    const root = getWorkspaceDir();
    const filePath = path.resolve(root, `.${rel}`);
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error("Not a file");
      res.writeHead(200, { "Content-Type": mimeType(filePath), "Cache-Control": "no-cache" });
      res.end(await fs.readFile(filePath));
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
    return;
  }

  const filePath = path.resolve(publicDir, `.${requestedPath}`);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "Content-Type": mimeType(filePath) });
    res.end(await fs.readFile(filePath));
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function parseMultipart(buffer, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = buffer.indexOf(delim, start);
    if (idx === -1) break;
    const next = buffer.indexOf(delim, idx + delim.length);
    if (next === -1) break;
    parts.push(buffer.slice(idx + delim.length, next));
    start = next;
  }
  const fields = {};
  const files = [];
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString("utf8");
    let body = part.slice(headerEnd + 4);
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.slice(0, -2);
    }
    const disp = headerText.match(/Content-Disposition: form-data;[^\r\n]*/i);
    if (!disp) continue;
    const nameMatch = disp[0].match(/name="([^"]*)"/);
    const fileMatch = disp[0].match(/filename="([^"]*)"/);
    const typeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
    const name = nameMatch ? nameMatch[1] : "";
    if (fileMatch) {
      files.push({
        name,
        filename: fileMatch[1],
        type: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
        data: body
      });
    } else {
      fields[name] = body.toString("utf8");
    }
  }
  return { fields, files };
}

async function handleUpload(req, res) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundaryMatch) {
    sendJson(res, 400, { error: "Expected multipart/form-data" });
    return;
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) { tooLarge = true; break; }
    chunks.push(chunk);
  }
  if (tooLarge) {
    sendJson(res, 413, { error: "File too large (max 12 MB)" });
    return;
  }
  const buffer = Buffer.concat(chunks);
  const { files } = parseMultipart(buffer, boundary);
  const file = files[0];
  if (!file || !file.filename) {
    sendJson(res, 400, { error: "No file uploaded" });
    return;
  }
  const ext = (path.extname(file.filename).slice(1) || "").toLowerCase();
  const knownType = IMAGE_TYPES[ext];
  const isImage = !!knownType || file.type.startsWith("image/");
  if (!isImage) {
    sendJson(res, 415, { error: "Only image files are allowed" });
    return;
  }
  const safeExt = ext || guessExt(file.type) || "bin";
  const storedName = sanitizeUploadName(file.filename) || `${Date.now().toString(36)}.${safeExt}`;
  const storedPath = path.resolve(getWorkspaceDir(), storedName);
  watchSelfWrite = true;
  try {
    await fs.writeFile(storedPath, file.data);
    broadcast("workspace:changed", { ts: Date.now() });
    sendJson(res, 201, { url: `/workspace/${encodeURIComponent(storedName)}`, filename: storedName, size: file.data.length });
  } finally {
    setTimeout(() => { watchSelfWrite = false; }, 400);
  }
}

function sanitizeUploadName(name) {
  return String(name || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").trim();
}

function guessExt(type) {
  const map = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([e, t]) => [t, e]));
  return map[type] || "";
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

// Render the agent's working field to an SVG data URL. A DOM-less server can't
// produce a true raster screenshot, so we emit a compact SVG — vision-capable
// models accept image/svg+xml. The client may also supply richer canvas snapshots
// via the run request's `images` field.
async function regionSnapshotForRun(field) {
  return regionSnapshot(field);
}

// Compress a board element into a compact, LLM-friendly context item: keep the
// text-heavy fields and drop pure presentation (fill/stroke/points/…).
function elementToContextItem(element) {
  const e = element || {};
  const meta = e.meta && typeof e.meta === "object" ? e.meta : {};
  const item = {
    id: String(e.id || ""),
    kind: String(e.type || e.kind || "element"),
    title: String(meta.title || meta.fileName || ""),
    text: String(e.text || ""),
    meta: null
  };
  // Keep just the descriptive bits of meta, not geometry/layout flags.
  const pickedMeta = {};
  if (meta.caption) pickedMeta.caption = meta.caption;
  if (meta.sourceFile) pickedMeta.sourceFile = meta.sourceFile;
  if (meta.image) pickedMeta.image = meta.image;
  if (e.url) pickedMeta.url = e.url;
  if (Object.keys(pickedMeta).length) item.meta = pickedMeta;
  return item;
}

function broadcast(event, payload) {
  const data = JSON.stringify(payload);
  for (const client of clients) {
    client.write(`event: ${event}\ndata: ${data}\n\n`);
  }
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8"
  }[ext] || "application/octet-stream";
}
