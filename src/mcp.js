import { appendFileSync } from "node:fs";
import {
  ensureDataFile,
  getWorkspaceDir,
  setWorkspaceDir,
  PLANE_FILE,
  LLM_CONTEXT_FILE,
  mergeElement,
  newId,
  normalizeBoard,
  normalizeElement,
  readBoard,
  updateBoard,
  writeBoard,
  readLlmContext,
  consumeLlmContext,
  clearLlmContext
} from "./store.js";

await ensureDataFile();
debugLog("server started");

const tools = [
  {
    name: "get_board",
    description: "Return the complete current board JSON.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "set_board",
    description: "Replace the whole board. Use with care.",
    inputSchema: {
      type: "object",
      properties: {
        board: { type: "object", description: "Board object with an elements array." }
      },
      required: ["board"],
      additionalProperties: false
    }
  },
  {
    name: "get_workspace",
    description: "Return the workspace folder path used by MCP for zmtki-plane.json and card .md files. The browser server (npm start) must use the same WORKSPACE_DIR, or open that folder via the UI tab.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "set_workspace",
    description: "Switch MCP to another workspace folder (absolute path). Creates the folder if missing. Does not change the running HTTP server — restart npm start with the same WORKSPACE_DIR or open that folder in the browser.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the workspace directory." }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "list_elements",
    description: "List elements, optionally filtered by type.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Optional element type filter." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_element",
    description: "Return one element by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "create_element",
    description: "Create a board element. Supported types: rect, ellipse, diamond, sticky, text, frame, line, arrow, pen, image, card. A card is a small markdown document shown on the board; its markdown body goes in `text` and its header (title, caption, image) goes in `meta`.",
    inputSchema: {
      type: "object",
      properties: {
        element: {
          type: "object",
          description: "Element fields. id is optional. Common fields: type, x, y, width, height, fill, stroke, text, fontSize, points, url, meta. For type 'card': set `text` to the markdown body and meta.title/meta.caption/meta.image for the header."
        }
      },
      required: ["element"],
      additionalProperties: false
    }
  },
  {
    name: "update_element",
    description: "Patch one element. The id and createdAt fields are preserved.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        patch: { type: "object" }
      },
      required: ["id", "patch"],
      additionalProperties: false
    }
  },
  {
    name: "delete_element",
    description: "Delete one element by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "list_cards",
    description: "List all card elements (markdown documents) on the board with their id, header (meta.title/caption/image) and a short markdown preview.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "get_card",
    description: "Return one card element by id, including its full markdown body.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "create_card",
    description: "Create a card (markdown document) on the board. `markdown` is the body; `title`, `caption`, `image` configure the card header shown on the board.",
    inputSchema: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "Markdown body of the card." },
        title: { type: "string", description: "Optional card header title." },
        caption: { type: "string", description: "Optional card header caption/subtitle." },
        image: { type: "string", description: "Optional card header image (URL or data URI)." },
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        id: { type: "string" }
      },
      required: ["markdown"],
      additionalProperties: false
    }
  },
  {
    name: "update_card",
    description: "Patch a card's markdown body and/or header. Any of markdown/title/caption/image is optional; only provided fields change.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        markdown: { type: "string" },
        title: { type: "string" },
        caption: { type: "string" },
        image: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "delete_card",
    description: "Delete a card by id. Convenience wrapper around delete_element.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }
      },
      required: ["id"],
      additionalProperties: false
    }
  },
  {
    name: "clear_board",
    description: "Remove all elements from the board.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "search_text",
    description: "Find elements whose text contains a query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "select_in_area",
    description: "Select every element whose bounding box intersects the given rectangular area. Selection is stored on the board (board.selectedIds) so a UI can highlight or act on the chosen elements. Use mode 'intersect' (default) to select elements that touch the area, or 'contain' to select only elements fully inside the area.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "Left edge of the area (board coordinates)." },
        y: { type: "number", description: "Top edge of the area (board coordinates)." },
        width: { type: "number", description: "Width of the area." },
        height: { type: "number", description: "Height of the area." },
        mode: { type: "string", enum: ["intersect", "contain"], default: "intersect" }
      },
      required: ["x", "y", "width", "height"],
      additionalProperties: false
    }
  },
  {
    name: "create_connector",
    description: "Create a line or arrow connector between two points.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["line", "arrow"], default: "arrow" },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        startElementId: { type: "string", description: "Optional element id to bind the connector start to." },
        startAnchor: { type: "string", description: "Optional start anchor: nw, n, ne, e, se, s, sw, w, c." },
        endElementId: { type: "string", description: "Optional element id to bind the connector end to." },
        endAnchor: { type: "string", description: "Optional end anchor: nw, n, ne, e, se, s, sw, w, c." },
        stroke: { type: "string", default: "#1f2937" },
        strokeWidth: { type: "number", default: 2 },
        text: { type: "string", default: "" }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_llm_context",
    description: "Return the LLM context buffer that the user populated from the board (the \"Add to LLM context\" button). Each item has { id, kind, title, text, meta }. By default the buffer is consumed (cleared) after reading. Pass peek: true to read without clearing.",
    inputSchema: {
      type: "object",
      properties: {
        peek: { type: "boolean", default: false, description: "If true, return the buffer without clearing it." }
      },
      additionalProperties: false
    }
  },
  {
    name: "clear_llm_context",
    description: "Empty the LLM context buffer.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

const handlers = {
  async get_board() {
    return readBoard();
  },

  async get_workspace() {
    return {
      path: getWorkspaceDir(),
      planeFile: PLANE_FILE,
      hint: "Server and browser must use this same folder to see MCP changes live."
    };
  },

  async set_workspace(args) {
    const dir = setWorkspaceDir(args.path);
    await ensureDataFile();
    return { ok: true, path: dir, planeFile: PLANE_FILE };
  },

  async set_board(args) {
    return writeBoard(normalizeBoard(args.board));
  },

  async list_elements(args = {}) {
    const board = await readBoard();
    const elements = args.type ? board.elements.filter((element) => element.type === args.type) : board.elements;
    return { count: elements.length, elements };
  },

  async get_element(args) {
    const board = await readBoard();
    const element = board.elements.find((item) => item.id === args.id);
    if (!element) throw new Error(`Element not found: ${args.id}`);
    return element;
  },

  async create_element(args) {
    let created;
    await updateBoard((board) => {
      created = normalizeElement({
        ...args.element,
        id: args.element.id || newId(args.element.type || "el")
      });
      board.elements.push(created);
      return board;
    });
    return created;
  },

  async update_element(args) {
    let updated = null;
    await updateBoard((board) => {
      board.elements = board.elements.map((element) => {
        if (element.id !== args.id) return element;
        updated = mergeElement(element, args.patch || {});
        return updated;
      });
      return board;
    });
    if (!updated) throw new Error(`Element not found: ${args.id}`);
    return updated;
  },

  async delete_element(args) {
    let removed = false;
    await updateBoard((board) => {
      const before = board.elements.length;
      board.elements = board.elements.filter((element) => element.id !== args.id);
      removed = board.elements.length !== before;
      return board;
    });
    if (!removed) throw new Error(`Element not found: ${args.id}`);
    return { ok: true, id: args.id };
  },

  async clear_board() {
    return writeBoard({ version: 1, name: "Local board", elements: [] });
  },

  async search_text(args) {
    const query = String(args.query || "").toLowerCase();
    const board = await readBoard();
    const elements = board.elements.filter((element) => String(element.text || "").toLowerCase().includes(query));
    return { count: elements.length, elements };
  },

  async list_cards() {
    const board = await readBoard();
    const cards = board.elements.filter((element) => element.type === "card");
    return {
      count: cards.length,
      cards: cards.map((card) => ({
        id: card.id,
        title: card.meta?.title || "",
        caption: card.meta?.caption || "",
        hasImage: Boolean(card.meta?.image),
        x: card.x,
        y: card.y,
        width: card.width,
        height: card.height,
        preview: String(card.text || "").slice(0, 140)
      }))
    };
  },

  async get_card(args) {
    const board = await readBoard();
    const card = board.elements.find((element) => element.id === args.id && element.type === "card");
    if (!card) throw new Error(`Card not found: ${args.id}`);
    return card;
  },

  async create_card(args) {
    let created;
    await updateBoard((board) => {
      created = normalizeElement({
        id: args.id || newId("card"),
        type: "card",
        x: Number(args.x) || 0,
        y: Number(args.y) || 0,
        width: Number(args.width) || 260,
        height: Number(args.height) || 180,
        text: String(args.markdown ?? ""),
        meta: {
          title: args.title || "",
          caption: args.caption || "",
          image: args.image || ""
        }
      });
      board.elements.push(created);
      return board;
    });
    return created;
  },

  async update_card(args) {
    const patch = {};
    if (args.markdown !== undefined) patch.text = String(args.markdown);
    const headerFields = {};
    if (args.title !== undefined) headerFields.title = args.title;
    if (args.caption !== undefined) headerFields.caption = args.caption;
    if (args.image !== undefined) headerFields.image = args.image;
    let updated = null;
    let isCard = false;
    await updateBoard((board) => {
      board.elements = board.elements.map((element) => {
        if (element.id !== args.id) return element;
        if (element.type !== "card") {
          isCard = false;
          return element;
        }
        isCard = true;
        // merge header fields into the existing meta instead of replacing it,
        // so partial patches (e.g. only title) keep caption/image intact.
        const next = { ...element };
        if (args.markdown !== undefined) next.text = String(args.markdown);
        if (Object.keys(headerFields).length) {
          next.meta = { ...(element.meta || {}), ...headerFields };
        }
        updated = normalizeElement({ ...next, id: element.id, type: "card", createdAt: element.createdAt });
        return updated;
      });
      return board;
    });
    if (!isCard) throw new Error(`Card not found: ${args.id}`);
    return updated;
  },

  async delete_card(args) {
    let removed = false;
    await updateBoard((board) => {
      const before = board.elements.length;
      board.elements = board.elements.filter((element) => !(element.id === args.id && element.type === "card"));
      removed = board.elements.length !== before;
      return board;
    });
    if (!removed) throw new Error(`Card not found: ${args.id}`);
    return { ok: true, id: args.id };
  },

  async select_in_area(args) {
    const ax = Number(args.x) || 0;
    const ay = Number(args.y) || 0;
    const aw = Number(args.width) || 0;
    const ah = Number(args.height) || 0;
    const mode = args.mode === "contain" ? "contain" : "intersect";
    let selectedIds = [];
    let hitCount = 0;
    await updateBoard((board) => {
      selectedIds = board.elements
        .filter((element) => intersectsArea(board, element, ax, ay, aw, ah, mode))
        .map((element) => element.id);
      hitCount = selectedIds.length;
      board.selectedIds = selectedIds;
      return board;
    });
    return { mode, count: hitCount, selectedIds };
  },

  async create_connector(args) {
    let created;
    await updateBoard((board) => {
      const startBinding = bindingFromArgs(args.startElementId, args.startAnchor);
      const endBinding = bindingFromArgs(args.endElementId, args.endAnchor);
      const start = startBinding ? anchorPoint(board, startBinding) : { x: Number(args.x1) || 0, y: Number(args.y1) || 0 };
      const end = endBinding ? anchorPoint(board, endBinding) : { x: Number(args.x2) || 0, y: Number(args.y2) || 0 };
      created = normalizeElement({
        id: newId(args.kind || "arrow"),
        type: args.kind === "line" ? "line" : "arrow",
        x: start.x,
        y: start.y,
        width: end.x - start.x,
        height: end.y - start.y,
        fill: "transparent",
        stroke: args.stroke || "#1f2937",
        strokeWidth: args.strokeWidth || 2,
        text: args.text || "",
        meta: {
          startBinding,
          endBinding
        }
      });
      board.elements.push(created);
      return board;
    });
    return created;
  },

  async get_llm_context(args = {}) {
    const items = await consumeLlmContext({ peek: Boolean(args.peek) });
    return { count: items.length, items, cleared: !args.peek };
  },

  async clear_llm_context() {
    await clearLlmContext();
    return { ok: true, count: 0 };
  }
};

// Auto-attach behavior: if the user populated the LLM context buffer but the
// agent never calls get_llm_context, surface it once as an extra content block on
// the next tool result so the context isn't lost. The buffer is drained when it
// is attached this way (matching "отправлялось вместе со следующим запросом").
async function withAutoContext(content) {
  try {
    const items = await consumeLlmContext();
    if (!items.length) return content;
    const block = {
      type: "text",
      text: `[User-provided context from the board — auto-attached, buffer now cleared]\n${JSON.stringify(items, null, 2)}`
    };
    return [...content, block];
  } catch {
    return content;
  }
}

// MCP stdio transport is newline-delimited JSON (NDJSON). Legacy clients may
// instead wrap each message with LSP-style "Content-Length" framing; detect
// the framing from the first bytes and support both.
let buffer = "";
let framing = null;

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  debugLog("stdin chunk", { bytes: chunk.length });
  buffer += chunk;
  parseMessages().catch((error) => {
    debugLog("parse error", { message: error.message, stack: error.stack });
    respond(null, null, error);
  });
});

process.stdin.resume();

async function parseMessages() {
  if (framing === null) framing = detectFraming(buffer);
  let yielded;
  do {
    yielded = framing === "lsp" ? await consumeLspFrame() : await consumeNdjsonLine();
  } while (yielded);
}

function detectFraming(text) {
  const head = text.slice(0, 64).trim();
  if (/^Content-Length:\s*\d+/i.test(head)) return "lsp";
  return "ndjson";
}

async function consumeNdjsonLine() {
  const nl = buffer.indexOf("\n");
  if (nl === -1) return false;
  const raw = buffer.slice(0, nl).trim();
  buffer = buffer.slice(nl + 1);
  if (!raw) return true; // skip blank/keepalive lines
  debugLog("incoming", safeJson(raw));
  await handleMessage(JSON.parse(raw));
  return true;
}

async function consumeLspFrame() {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return false;
  const header = buffer.slice(0, headerEnd);
  const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
  if (!lengthMatch) {
    buffer = "";
    throw new Error("Missing Content-Length header");
  }
  const length = Number(lengthMatch[1]);
  const bodyStart = headerEnd + 4;
  const bodyEnd = bodyStart + length;
  if (buffer.length < bodyEnd) return false;
  const raw = buffer.slice(bodyStart, bodyEnd);
  buffer = buffer.slice(bodyEnd);
  debugLog("incoming", safeJson(raw));
  await handleMessage(JSON.parse(raw));
  return true;
}

async function handleMessage(message) {
  debugLog("handle", { id: message?.id, method: message?.method });
  if (message.method && message.id === undefined) return;

  try {
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: message.params?.protocolVersion || "2024-11-05",
        capabilities: {
          tools: {},
          resources: {}
        },
        serverInfo: {
          name: "zmtki",
          version: "0.2.0"
        }
      });
      return;
    }

    if (message.method === "tools/list") {
      respond(message.id, { tools });
      return;
    }

    if (message.method === "tools/call") {
      const { name, arguments: args = {} } = message.params || {};
      if (!handlers[name]) throw new Error(`Unknown tool: ${name}`);
      const result = await handlers[name](args);
      const content = [
        {
          type: "text",
          text: JSON.stringify(result, null, 2)
        }
      ];
      // If the user added context but never drained it, surface it on the next
      // tool response (and clear the buffer) — unless the tool itself is the
      // dedicated context tool that already handles the buffer.
      const isContextTool = name === "get_llm_context" || name === "clear_llm_context";
      const finalContent = isContextTool ? content : await withAutoContext(content);
      respond(message.id, { content: finalContent });
      return;
    }

      if (message.method === "resources/list") {
      respond(message.id, {
        resources: [
          {
            uri: "board://current",
            name: "Current board",
            mimeType: "application/json",
            description: "The complete current zmtki board JSON."
          }
        ]
      });
      return;
    }

    if (message.method === "resources/read") {
      const uri = message.params?.uri;
      if (uri !== "board://current") throw new Error(`Unknown resource: ${uri}`);
      respond(message.id, {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(await readBoard(), null, 2)
          }
        ]
      });
      return;
    }

    if (message.method === "prompts/list") {
      respond(message.id, { prompts: [] });
      return;
    }

    respond(message.id, null, new Error(`Unsupported method: ${message.method}`));
  } catch (error) {
    respond(message.id, null, error);
  }
}

function respond(id, result, error = null) {
  if (id === undefined || id === null) return;
  const payload = error
    ? {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: error.message || "MCP error" }
      }
    : { jsonrpc: "2.0", id, result };
  const body = JSON.stringify(payload);
  debugLog("respond", { id, ok: !error, framing, bytes: body.length });
  if (framing === "lsp") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  } else {
    process.stdout.write(`${body}\n`);
  }
}

function debugLog(event, data = null) {
  const file = process.env.MCP_LOG_FILE;
  if (!file) return;
  try {
    appendFileSync(
      file,
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        data
      }) + "\n",
      "utf8"
    );
  } catch {
    // MCP stdout must remain protocol-only; ignore diagnostics failures.
  }
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.slice(0, 500);
  }
}

function bindingFromArgs(elementId, anchor) {
  if (!elementId || !anchor) return null;
  return { elementId: String(elementId), anchor: String(anchor) };
}

function anchorPoint(board, binding) {
  const element = board.elements.find((item) => item.id === binding.elementId);
  if (!element) throw new Error(`Element not found for connector binding: ${binding.elementId}`);
  const box = {
    x: element.x,
    y: element.y,
    width: Math.max(1, element.width),
    height: Math.max(1, element.height)
  };
  const points = {
    nw: { x: box.x, y: box.y },
    n: { x: box.x + box.width / 2, y: box.y },
    ne: { x: box.x + box.width, y: box.y },
    e: { x: box.x + box.width, y: box.y + box.height / 2 },
    se: { x: box.x + box.width, y: box.y + box.height },
    s: { x: box.x + box.width / 2, y: box.y + box.height },
    sw: { x: box.x, y: box.y + box.height },
    w: { x: box.x, y: box.y + box.height / 2 },
    c: { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  };
  if (!points[binding.anchor]) throw new Error(`Invalid connector anchor: ${binding.anchor}`);
  return points[binding.anchor];
}

function connectorEndpoints(board, element) {
  const start = safeAnchorPoint(board, element.meta?.startBinding) || { x: element.x, y: element.y };
  const end = safeAnchorPoint(board, element.meta?.endBinding) || {
    x: element.x + (element.width || 0),
    y: element.y + (element.height || 0)
  };
  return { start, end };
}

function safeAnchorPoint(board, binding) {
  if (!binding) return null;
  try {
    return anchorPoint(board, binding);
  } catch {
    return null;
  }
}

// Element bounding box used for area selection. Connectors and pen strokes use
// their endpoint/point extents; everything else uses x/y/width/height.
function elementBounds(board, element) {
  if (element.type === "line" || element.type === "arrow") {
    const { start, end } = connectorEndpoints(board, element);
    const x1 = start.x;
    const y1 = start.y;
    const x2 = end.x;
    const y2 = end.y;
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.max(1, Math.abs(x2 - x1)),
      height: Math.max(1, Math.abs(y2 - y1))
    };
  }
  if (element.type === "pen" && Array.isArray(element.points) && element.points.length) {
    const xs = element.points.map((p) => p.x);
    const ys = element.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return {
      x: element.x + minX,
      y: element.y + minY,
      width: Math.max(1, Math.max(...xs) - minX),
      height: Math.max(1, Math.max(...ys) - minY)
    };
  }
  return {
    x: element.x,
    y: element.y,
    width: Math.max(1, element.width || 0),
    height: Math.max(1, element.height || 0)
  };
}

function intersectsArea(board, element, ax, ay, aw, ah, mode) {
  const b = areaHitBounds(board, element);
  if (mode === "contain") {
    return b.x >= ax && b.y >= ay && b.x + b.width <= ax + aw && b.y + b.height <= ay + ah;
  }
  return b.x < ax + aw && b.x + b.width > ax && b.y < ay + ah && b.y + b.height > ay;
}

function areaHitBounds(board, element) {
  const b = elementBounds(board, element);
  if (element.type !== "line" && element.type !== "arrow") return b;
  const pad = Math.max(8, (Number(element.strokeWidth) || 2) * 2);
  return {
    x: b.x - pad,
    y: b.y - pad,
    width: b.width + pad * 2,
    height: b.height + pad * 2
  };
}
