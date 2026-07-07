// Built-in agent engine.
//
// The agent loop is implemented as a LangGraph StateGraph:
//
//        ┌────────────┐    has tool calls    ┌────────────┐
//   START│  callModel ├─────────────────────►│  runTools  │┐
//        └─────┬──────┘                      └─────┬──────┘│
//              │ no tool calls                     │       │
//              ▼                                   │       │
//             END ◄─────────────────────────────────┘───────┘
//                                  (loop back to callModel)
//
// State carries the chat messages, the agent element id, a bounded iteration
// counter and an accumulator of executed tool actions (move/resize/write_file…).
// The graph is compiled once and re-invoked per "run" so LangGraph manages the
// routing/reducer logic; the tool implementations are plain async functions.
//
// All file/agent operations go through store.* so they share WORKSPACE_DIR with
// the rest of zmtki and stay consistent with the live board.

import path from "node:path";
import { promises as fs } from "node:fs";
import {
  Annotation,
  END,
  START,
  StateGraph
} from "@langchain/langgraph";
import { chatComplete } from "./providers.js";
import { getWorkspaceDir, readBoard, writeBoard, updateBoard, readChat, appendChatMessage, consumeLlmContext, normalizeElement, mergeElement, newId } from "./store.js";
import { webSearch, researchTopic, generateImageAsset, createDocumentFromOutline, createRegionFrame } from "./builtinTools.js";

const MAX_ITERATIONS = 8;
// Working-field size limits the agent can grow/shrink itself to.
const MIN_FIELD = { w: 240, h: 180 };
const MAX_FIELD = { w: 2400, h: 1800 };

// ---------- graph state ----------
// LangGraph's Annotation is a function: Annotation({ reducer, default }) returns
// a channel spec. (Using a plain object literal here does NOT register a
// channel — the keys get silently dropped.) Last-value channels use Annotation().
const AgentState = Annotation.Root({
  messages: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  agentId: Annotation({ reducer: (_a, b) => b, default: () => "" }),
  iteration: Annotation({ reducer: (a, b) => Math.max(a, b), default: () => 0 }),
  actions: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  final: Annotation({ reducer: (_a, b) => b, default: () => "" }),
  // Vision attachments queued by snapshot_region or the client run request.
  pendingImages: Annotation({ reducer: (_a, b) => b, default: () => [] }),
  clientImages: Annotation({ reducer: (_a, b) => b, default: () => [] })
});

// ---------- tool catalogue ----------
// Each tool: { name, description, parameters(JSON schema), run(ctx, args) }.
// ctx = { agentId, field, logAction }.
function buildTools({ snapshotRenderer }) {
  return [
    {
      name: "move_agent",
      description: "Move your own working field (your viewport) to a new top-left position on the board plane. Use this to navigate to content you found via board_overview or get_region_objects.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number", description: "New top-left x in board coordinates." },
          y: { type: "number", description: "New top-left y in board coordinates." }
        },
        required: ["x", "y"]
      },
      async run(ctx, args) {
        const x = Number(args.x);
        const y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: "x and y must be numbers" };
        await moveAgentElement(ctx.agentId, { x, y });
        ctx.logAction({ type: "move", x, y });
        return { ok: true, position: { x, y } };
      }
    },
    {
      name: "resize_agent",
      description: "Resize your working field (the rectangle that bounds your context). Width/height are clamped to a sensible range.",
      parameters: {
        type: "object",
        properties: {
          width: { type: "number" },
          height: { type: "number" }
        },
        required: ["width", "height"]
      },
      async run(ctx, args) {
        const width = Math.min(MAX_FIELD.w, Math.max(MIN_FIELD.w, Number(args.width) || 0));
        const height = Math.min(MAX_FIELD.h, Math.max(MIN_FIELD.h, Number(args.height) || 0));
        await moveAgentElement(ctx.agentId, { width, height });
        ctx.logAction({ type: "resize", width, height });
        return { ok: true, size: { width, height } };
      }
    },
    {
      name: "get_region_objects",
      description: "Return all board elements that intersect your current working field — i.e. the content you can see right now. Cards include their markdown text.",
      parameters: { type: "object", properties: {} },
      async run(ctx) {
        const board = await readBoard();
        const field = await currentField(ctx.agentId);
        const items = board.elements
          .filter((e) => e.type !== "agent" && intersectsField(e, field))
          .map(summarizeElement);
        return { count: items.length, field, items };
      }
    },
    {
      name: "board_overview",
      description: "High-level overview of EVERYTHING on the board: element counts by type and a compact list of all agents and cards with their positions. Use this to decide where to move.",
      parameters: { type: "object", properties: {} },
      async run() {
        const board = await readBoard();
        const counts = {};
        const agents = [];
        const cards = [];
        for (const e of board.elements) {
          counts[e.type] = (counts[e.type] || 0) + 1;
          if (e.type === "agent") agents.push({ id: e.id, name: e.meta?.name || "Agent", x: e.x, y: e.y, w: e.width, h: e.height });
          if (e.type === "card") cards.push({ id: e.id, title: e.meta?.title || "", x: e.x, y: e.y });
        }
        return { counts, agents, cards: cards.slice(0, 60) };
      }
    },
    {
      name: "snapshot_region",
      description: "Capture your current working field as an image (SVG snapshot) and attach it to your next model turn for vision-capable models. Only use when you need visual layout — prefer text tools otherwise.",
      parameters: { type: "object", properties: {} },
      async run(ctx) {
        if (typeof snapshotRenderer !== "function") return { error: "Snapshot rendering is not available." };
        const field = await currentField(ctx.agentId);
        try {
          const dataUrl = await snapshotRenderer(field);
          return { ok: true, image: dataUrl };
        } catch (error) {
          return { error: error.message };
        }
      }
    },
    {
      name: "read_card",
      description: "Read the full markdown body and header of one card by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      },
      async run(_ctx, args) {
        const board = await readBoard();
        const card = board.elements.find((e) => e.id === args.id && e.type === "card");
        if (!card) return { error: "card not found" };
        return { id: card.id, title: card.meta?.title, caption: card.meta?.caption, markdown: card.text };
      }
    },
    {
      name: "create_card",
      description: "Create a new markdown card at a position (defaults to inside your current field).",
      parameters: {
        type: "object",
        properties: {
          markdown: { type: "string" },
          title: { type: "string" },
          x: { type: "number" },
          y: { type: "number" }
        }
      },
      async run(ctx, args) {
        const field = await currentField(ctx.agentId);
        const card = normalizeElement({
          id: newId("card"),
          type: "card",
          x: Number(args.x) || field.x + 16,
          y: Number(args.y) || field.y + 16,
          text: String(args.markdown || ""),
          meta: { title: args.title || "", planeView: "content" }
        });
        await updateBoard((board) => { board.elements.push(card); return board; });
        ctx.logAction({ type: "create_card", id: card.id });
        return { ok: true, id: card.id };
      }
    },
    {
      name: "update_card",
      description: "Patch a card's markdown body and/or title. Only provided fields change.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          markdown: { type: "string" },
          title: { type: "string" }
        },
        required: ["id"]
      },
      async run(ctx, args) {
        const board = await readBoard();
        const target = board.elements.find((e) => e.id === args.id && e.type === "card");
        if (!target) return { error: "card not found" };
        const field = await currentField(ctx.agentId);
        if (!intersectsField(target, field)) {
          return { error: "card is outside your working field — move your field over it first" };
        }
        let updated = null;
        await updateBoard((board) => {
          board.elements = board.elements.map((e) => {
            if (e.id !== args.id || e.type !== "card") return e;
            const patch = {};
            if (args.markdown !== undefined) patch.text = String(args.markdown);
            if (args.title !== undefined) patch.meta = { ...(e.meta || {}), title: String(args.title) };
            updated = mergeElement(e, patch);
            return updated;
          });
          return board;
        });
        if (!updated) return { error: "card not found" };
        ctx.logAction({ type: "update_card", id: args.id });
        return { ok: true };
      }
    },
    {
      name: "list_files",
      description: "List files in the workspace folder (optionally filtered by extension). Useful before read_file/search_files.",
      parameters: {
        type: "object",
        properties: { extension: { type: "string", description: "e.g. 'md', 'json'" } }
      },
      async run(_ctx, args) {
        const dir = getWorkspaceDir();
        const entries = await safeReadDir(dir);
        const filtered = entries.filter((name) => !name.startsWith(".zmtki"));
        const ext = String(args.extension || "").toLowerCase().replace(/^\./, "");
        const out = ext ? filtered.filter((n) => n.toLowerCase().endsWith("." + ext)) : filtered;
        return { count: out.length, files: out.slice(0, 200) };
      }
    },
    {
      name: "search_files",
      description: "Search the contents of all text files in the workspace for a query string. Returns matching files with a short snippet. Case-insensitive.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      },
      async run(_ctx, args) {
        const q = String(args.query || "").toLowerCase();
        if (!q) return { error: "query is required" };
        const dir = getWorkspaceDir();
        const files = (await safeReadDir(dir)).filter((n) => /\.(md|txt|json|js|css|html|toml|yml|yaml)$/i.test(n));
        const hits = [];
        for (const name of files.slice(0, 80)) {
          try {
            const text = (await fs.readFile(path.join(dir, name), "utf8")).toLowerCase();
            const idx = text.indexOf(q);
            if (idx >= 0) hits.push({ file: name, snippet: text.slice(Math.max(0, idx - 40), idx + 80) });
          } catch { /* ignore */ }
        }
        return { count: hits.length, hits };
      }
    },
    {
      name: "read_file",
      description: "Read a text file from the workspace folder by name. Lines beyond a limit are truncated.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"]
      },
      async run(_ctx, args) {
        const dir = getWorkspaceDir();
        const target = resolveWithin(dir, String(args.name || ""));
        if (!target) return { error: "invalid file name" };
        try {
          let text = await fs.readFile(target, "utf8");
          if (text.length > 16000) text = text.slice(0, 16000) + "\n…(truncated)";
          return { name: args.name, content: text };
        } catch (error) {
          return { error: error.message };
        }
      }
    },
    {
      name: "write_file",
      description: "Write (create or overwrite) a text file in the workspace folder.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" }
        },
        required: ["name", "content"]
      },
      async run(ctx, args) {
        const dir = getWorkspaceDir();
        const target = resolveWithin(dir, String(args.name || ""));
        if (!target) return { error: "invalid file name" };
        try {
          await fs.writeFile(target, String(args.content || ""), "utf8");
          ctx.logAction({ type: "write_file", name: args.name });
          return { ok: true, name: args.name };
        } catch (error) {
          return { error: error.message };
        }
      }
    },
    {
      name: "read_chat",
      description: "Read recent chat messages. channel = 'general' for the shared chat, or an agent id. Defaults to 'general'.",
      parameters: {
        type: "object",
        properties: { channel: { type: "string" }, limit: { type: "number" } }
      },
      async run(_ctx, args) {
        const all = await readChat();
        const channel = String(args.channel || "general");
        const filtered = all.filter((m) => m.channel === channel).slice(-(Number(args.limit) || 20));
        return { channel, count: filtered.length, messages: filtered };
      }
    },
    {
      name: "send_chat",
      description: "Post a message to a chat channel as yourself. Use 'general' for the shared chat, or another agent's id to message them directly.",
      parameters: {
        type: "object",
        properties: { channel: { type: "string" }, text: { type: "string" } },
        required: ["text"]
      },
      async run(ctx, args) {
        const channel = String(args.channel || "general");
        const msg = await appendChatMessage({
          channel,
          role: "agent",
          author: ctx.agentId,
          text: String(args.text || "")
        });
        ctx.logAction({ type: "send_chat", channel });
        return { ok: true, id: msg.id };
      }
    },
    {
      name: "get_llm_context",
      description: "Drain the shared LLM context buffer (the board's 'Add to LLM context' selection). Returns and clears it.",
      parameters: { type: "object", properties: {} },
      async run() {
        const items = await consumeLlmContext();
        return { count: items.length, items };
      }
    },
    {
      name: "web_search",
      description: "Search the web for a topic (DuckDuckGo instant answers). Use for external research before writing cards.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      },
      async run(_ctx, args) {
        return webSearch(String(args.query || ""));
      }
    },
    {
      name: "research_topic",
      description: "Research a topic on the web, synthesize a markdown brief, save it as a .md file in the workspace and return the summary.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"]
      },
      async run(ctx, args) {
        const agent = await loadAgent(ctx.agentId);
        const result = await researchTopic(String(args.topic || ""), {
          providerId: agent.meta?.providerId || "",
          model: agent.meta?.model || ""
        });
        if (result.ok) ctx.logAction({ type: "research_topic", fileName: result.fileName });
        return result;
      }
    },
    {
      name: "generate_image",
      description: "Generate an image from a text prompt (requires an OpenAI-compatible image API). Saves PNG to workspace and adds an image element to the board.",
      parameters: {
        type: "object",
        properties: { prompt: { type: "string" }, size: { type: "string", description: "e.g. 1024x1024" } },
        required: ["prompt"]
      },
      async run(ctx, args) {
        const agent = await loadAgent(ctx.agentId);
        const field = await currentField(ctx.agentId);
        const result = await generateImageAsset(String(args.prompt || ""), {
          providerId: agent.meta?.providerId || "",
          model: agent.meta?.model || "",
          size: args.size
        });
        if (result.ok && result.elementId) {
          await updateBoard((board) => {
            board.elements = board.elements.map((e) => {
              if (e.id !== result.elementId) return e;
              return mergeElement(e, { x: field.x + 24, y: field.y + 24 });
            });
            return board;
          });
          ctx.logAction({ type: "generate_image", fileName: result.fileName });
        }
        return result;
      }
    },
    {
      name: "create_document",
      description: "Create a structured markdown document (saved as .md + card on board) from a title and section list.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          sections: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" }, body: { type: "string" } }
            }
          }
        },
        required: ["title"]
      },
      async run(ctx, args) {
        const field = await currentField(ctx.agentId);
        const result = await createDocumentFromOutline(String(args.title || ""), args.sections || [], {
          x: field.x + 32,
          y: field.y + 32
        });
        if (result.ok) ctx.logAction({ type: "create_document", fileName: result.fileName });
        return result;
      }
    },
    {
      name: "create_region_frame",
      description: "Create a labeled frame region on the board and optionally attach element ids to it (sections for research/product areas).",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
          elementIds: { type: "array", items: { type: "string" } }
        },
        required: ["label"]
      },
      async run(ctx, args) {
        const field = await currentField(ctx.agentId);
        const result = await createRegionFrame(String(args.label || "Region"), {
          x: args.x ?? field.x,
          y: args.y ?? field.y,
          width: args.width ?? field.width,
          height: args.height ?? field.height,
          elementIds: args.elementIds || []
        });
        if (result.ok) ctx.logAction({ type: "create_region_frame", frameId: result.frameId });
        return result;
      }
    },
    {
      name: "fit_agent_to_region",
      description: "Move and resize your working field to exactly cover a frame region or a set of element ids.",
      parameters: {
        type: "object",
        properties: {
          frameId: { type: "string" },
          elementIds: { type: "array", items: { type: "string" } },
          padding: { type: "number" }
        }
      },
      async run(ctx, args) {
        const board = await readBoard();
        const pad = Number(args.padding) || 16;
        let bounds = null;
        if (args.frameId) {
          const frame = board.elements.find((e) => e.id === args.frameId && e.type === "frame");
          if (!frame) return { error: "frame not found" };
          bounds = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
        } else if (args.elementIds?.length) {
          const ids = new Set(args.elementIds.map(String));
          const items = board.elements.filter((e) => ids.has(e.id));
          if (!items.length) return { error: "no elements found" };
          const xs = items.map((e) => e.x);
          const ys = items.map((e) => e.y);
          const x2 = items.map((e) => e.x + (e.width || 0));
          const y2 = items.map((e) => e.y + (e.height || 0));
          bounds = {
            x: Math.min(...xs) - pad,
            y: Math.min(...ys) - pad,
            width: Math.max(...x2) - Math.min(...xs) + pad * 2,
            height: Math.max(...y2) - Math.min(...ys) + pad * 2
          };
        } else {
          return { error: "frameId or elementIds required" };
        }
        await moveAgentElement(ctx.agentId, bounds);
        ctx.logAction({ type: "fit_agent_to_region", ...bounds });
        return { ok: true, field: bounds };
      }
    }
  ];
}

// ---------- geometry helpers ----------
async function currentField(agentId) {
  const board = await readBoard();
  const agent = board.elements.find((e) => e.id === agentId && e.type === "agent");
  if (!agent) throw new Error(`agent not found: ${agentId}`);
  return { x: agent.x, y: agent.y, width: agent.width, height: agent.height };
}

async function moveAgentElement(agentId, patch) {
  await updateBoard((board) => {
    board.elements = board.elements.map((e) => {
      if (e.id !== agentId || e.type !== "agent") return e;
      if (patch.x !== undefined) e.x = Number(patch.x);
      if (patch.y !== undefined) e.y = Number(patch.y);
      if (patch.width !== undefined) e.width = Number(patch.width);
      if (patch.height !== undefined) e.height = Number(patch.height);
      return mergeElement(e, { x: e.x, y: e.y, width: e.width, height: e.height });
    });
    return board;
  });
}

function intersectsField(element, field) {
  const ex = element.x || 0;
  const ey = element.y || 0;
  const ew = element.width || 0;
  const eh = element.height || 0;
  return ex < field.x + field.width && ex + ew > field.x && ey < field.y + field.height && ey + eh > field.y;
}

function summarizeElement(e) {
  const base = { id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height };
  if (e.type === "card") {
    base.title = e.meta?.title || "";
    base.markdown = String(e.text || "").slice(0, 1500);
  } else if (e.type === "text" || e.type === "sticky") {
    base.text = e.text;
  } else if (e.type === "image" || e.type === "sticker") {
    base.url = e.url;
  } else if (e.type === "file") {
    base.fileName = e.meta?.fileName || e.text;
  }
  return base;
}

async function safeReadDir(dir) {
  try { return await fs.readdir(dir); } catch { return []; }
}

// Resolve a path so it stays inside the workspace dir (no escaping via ../).
function resolveWithin(dir, name) {
  const clean = String(name || "").replace(/[\\/]+/g, path.sep).replace(/^[/\\]+/, "");
  const full = path.resolve(dir, clean);
  if (full !== dir && !full.startsWith(dir + path.sep)) return null;
  return full;
}

// ---------- build the graph ----------
function buildGraph(tools) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  // callModel: ask the provider, possibly receiving tool-call requests.
  async function callModel(state) {
    const agent = await loadAgent(state.agentId);
    const sys = systemPrompt(agent);
    const messages = [{ role: "system", content: sys }, ...state.messages];
    const images = [...(state.pendingImages || []), ...(state.clientImages || [])];
    const options = {
      providerId: agent.meta?.providerId || "",
      model: agent.meta?.model || "",
      tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      maxTokens: 1024,
      temperature: 0.2,
      ...(images.length ? { images } : {})
    };
    const result = await chatComplete(messages, options);
    const newMessages = [];
    const assistantMsg = { role: "assistant", content: result.content || "" };
    if (result.toolCalls?.length) {
      assistantMsg.tool_calls = result.toolCalls.map((tc, i) => ({ id: `call_${i}`, name: tc.name, args: tc.args }));
    }
    newMessages.push(assistantMsg);
    return { messages: newMessages, pendingImages: [], clientImages: [] };
  }

  // runTools: execute each requested tool, append tool-result messages.
  async function runTools(state) {
    const last = [...state.messages].reverse().find((m) => m.role === "assistant" && m.tool_calls?.length);
    if (!last) return { messages: [] };
    const ctx = {
      agentId: state.agentId,
      field: await currentField(state.agentId).catch(() => ({ x: 0, y: 0, width: 0, height: 0 })),
      logAction: (a) => { state.actions.push(a); }
    };
    const out = [];
    const snapshotImages = [];
    for (const tc of last.tool_calls) {
      const tool = toolMap.get(tc.name);
      let result;
      if (!tool) {
        result = { error: `unknown tool: ${tc.name}` };
      } else {
        try { result = await tool.run(ctx, tc.args || {}); }
        catch (error) { result = { error: error.message }; }
      }
      if (tc.name === "snapshot_region" && result?.ok && result.image) {
        snapshotImages.push(result.image);
        // Don't flood the model with a huge base64 string in the tool result.
        result = { ok: true, note: "Snapshot attached as an image on the next model turn." };
      }
      out.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: JSON.stringify(result) });
    }
    return { messages: out, iteration: state.iteration + 1, pendingImages: snapshotImages };
  }

  // Route after the model: if it asked for tools and we still have budget, run them.
  function routeAfterModel(state) {
    const last = [...state.messages].reverse().find((m) => m.role === "assistant");
    if (last?.tool_calls?.length && state.iteration < MAX_ITERATIONS) return "runTools";
    return END;
  }
  function routeAfterTools(state) {
    if (state.iteration >= MAX_ITERATIONS) return END;
    return "callModel";
  }

  return new StateGraph(AgentState)
    .addNode("callModel", callModel)
    .addNode("runTools", runTools)
    .addEdge(START, "callModel")
    .addConditionalEdges("callModel", routeAfterModel)
    .addConditionalEdges("runTools", routeAfterTools)
    .compile();
}

let _compiled = null;
function graph(options) {
  if (!_compiled) _compiled = buildGraph(buildTools(options));
  return _compiled;
}

async function buildChatSeed(agentId, input, images = []) {
  const history = await readChat();
  const recent = history
    .filter((m) => m.channel === agentId || m.channel === "general")
    .slice(-16);
  const seedMessages = recent.map((m) => ({
    role: m.role === "agent" ? "assistant" : "user",
    content: `[${m.channel === "general" ? "general" : "agent"} · ${m.author || m.role}] ${m.text || ""}`
  }));
  const inputTrim = String(input || "").trim();
  const last = recent[recent.length - 1];
  const dup = last && last.role !== "agent" && String(last.text || "").trim() === inputTrim;
  if (inputTrim && !dup) seedMessages.push({ role: "user", content: inputTrim });
  return {
    messages: seedMessages,
    clientImages: images?.length ? images : []
  };
}

// ---------- public entry: run an agent step ----------
// `input` is the user message text (and optional images). The agent's working
// field determines what it can "see". Returns a summary of actions + final text.
export async function runAgent(agentId, { input = "", images = [], snapshotRenderer } = {}) {
  const agent = await loadAgent(agentId);
  await setAgentStatus(agentId, "running");
  const tools = buildTools({ snapshotRenderer });
  const compiled = buildGraph(tools);

  const field = await currentField(agentId).catch(() => ({ x: 0, y: 0, width: 0, height: 0 }));
  const { messages: seedMessages, clientImages } = await buildChatSeed(agentId, input, images);

  const initialState = {
    messages: seedMessages,
    agentId,
    iteration: 0,
    actions: [],
    pendingImages: [],
    clientImages
  };

  try {
    const finalState = await compiled.invoke(initialState, { recursionLimit: MAX_ITERATIONS * 2 + 2 });
    // Find the last assistant text reply as the "final" answer.
    const lastAssistant = [...finalState.messages].reverse().find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim());
    const finalText = lastAssistant?.content || "";
    if (finalText) {
      await appendChatMessage({ channel: agentId, role: "agent", author: agentId, text: finalText });
    }
    await setAgentStatus(agentId, "idle", "");
    return {
      ok: true,
      agentId,
      final: finalText,
      actions: finalState.actions,
      iterations: finalState.iteration,
      field
    };
  } catch (error) {
    await setAgentStatus(agentId, "error", error.message);
    return { ok: false, agentId, error: error.message, actions: [], field };
  }
}

// ---------- helpers ----------
async function loadAgent(agentId) {
  const board = await readBoard();
  const agent = board.elements.find((e) => e.id === agentId && e.type === "agent");
  if (!agent) throw new Error(`Agent element not found: ${agentId}`);
  return agent;
}

async function setAgentStatus(agentId, status, errorMessage = "") {
  await updateBoard((board) => {
    board.elements = board.elements.map((e) => {
      if (e.id !== agentId || e.type !== "agent") return e;
      const meta = { ...(e.meta || {}), status, lastRunAt: new Date().toISOString(), lastError: errorMessage || "" };
      return mergeElement(e, { meta });
    });
    return board;
  });
}

function systemPrompt(agent) {
  const name = agent.meta?.name || "Agent";
  const custom = agent.meta?.systemPrompt?.trim();
  const topic = agent.meta?.regionTopic?.trim();
  const topicLine = topic ? `\nYour assigned section topic: ${topic}. Focus on this area of the board.` : "";
  if (custom) return custom + topicLine;
  return [
    `You are ${name}, an autonomous agent living on the zmtki whiteboard.`,
    "Your working field is a rectangle on the plane; you can only directly see objects inside it.",
    "You can move and resize your field, snapshot it as an image, read/write files in the workspace, read and create cards, post to chat, search the web, run research_topic, generate images, and organize sections with create_region_frame.",
    "Your edits to existing cards are limited to cards inside your working field. Use board_overview and fit_agent_to_region to navigate between sections.",
    "Be concise. Prefer text tools over image snapshots. After acting, briefly report what you did.",
    "Coordinates are in board units (pixels). Other agents and the user can be reached via send_chat."
  ].join("\n");
}

// Re-exported so server.js / mcp.js can build tools with a snapshot renderer.
export { buildTools, MAX_ITERATIONS };

// Server-side SVG snapshot of a rectangular board region (vision models accept image/svg+xml).
export async function regionSnapshot(field) {
  const board = await readBoard();
  const x = Number(field?.x) || 0;
  const y = Number(field?.y) || 0;
  const w = Math.max(1, Number(field?.width) || 1);
  const h = Math.max(1, Number(field?.height) || 1);
  const items = board.elements.filter((e) => e.type !== "agent" && intersectsField(e, { x, y, width: w, height: h }));
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="${x} ${y} ${w} ${h}">`];
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>`);
  for (const e of items) {
    const ex = e.x || 0, ey = e.y || 0, ew = e.width || 0, eh = e.height || 0;
    parts.push(`<rect x="${ex}" y="${ey}" width="${ew}" height="${eh}" fill="${e.fill || "#f1f5f9"}" stroke="${e.stroke || "#94a3b8"}" stroke-width="2"/>`);
    const label = (e.meta?.title || e.text || "").toString().slice(0, 60).replace(/[<>&]/g, "");
    if (label) {
      parts.push(`<text x="${ex + 8}" y="${ey + 20}" font-family="sans-serif" font-size="14" fill="#0f172a">${label}</text>`);
    }
  }
  parts.push("</svg>");
  return `data:image/svg+xml;utf8,${encodeURIComponent(parts.join(""))}`;
}
