// Built-in research / generation tools for agents (web search, image gen, research cards).

import path from "node:path";
import { promises as fs } from "node:fs";
import { getWorkspaceDir, newId, normalizeElement, updateBoard } from "./store.js";
import { chatComplete, generateImage } from "./providers.js";
import { workspaceFileUrl } from "./workspaceSync.js";

function safeFileBase(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "file";
}

export async function webSearch(query, { maxResults = 5 } = {}) {
  const q = String(query || "").trim();
  if (!q) return { error: "query is required" };

  const results = [];
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      if (data.AbstractText) {
        results.push({
          title: data.Heading || q,
          snippet: data.AbstractText,
          url: data.AbstractURL || ""
        });
      }
      for (const topic of (data.RelatedTopics || []).slice(0, maxResults)) {
        if (topic.Text) {
          results.push({ title: topic.Text.split(" - ")[0] || topic.Text, snippet: topic.Text, url: topic.FirstURL || "" });
        } else if (Array.isArray(topic.Topics)) {
          for (const sub of topic.Topics.slice(0, 2)) {
            if (sub.Text) results.push({ title: sub.Text.split(" - ")[0], snippet: sub.Text, url: sub.FirstURL || "" });
          }
        }
      }
    }
  } catch (error) {
    return { error: `search failed: ${error.message}`, results: [] };
  }

  if (!results.length) {
    results.push({
      title: q,
      snippet: "No instant results from DuckDuckGo. Try a more specific query or use search_files on local workspace documents.",
      url: ""
    });
  }
  return { query: q, count: results.length, results: results.slice(0, maxResults) };
}

export async function researchTopic(topic, { providerId = "", model = "" } = {}) {
  const q = String(topic || "").trim();
  if (!q) return { error: "topic is required" };

  const search = await webSearch(q, { maxResults: 6 });
  const bullets = (search.results || [])
    .map((r, i) => `${i + 1}. **${r.title}**${r.url ? ` (${r.url})` : ""}\n   ${r.snippet}`)
    .join("\n\n");

  let synthesis = "";
  try {
    const summary = await chatComplete(
      [{
        role: "user",
        content: `Research topic: "${q}". Summarize these findings into a structured markdown brief with sections: Overview, Key points, Open questions. Keep it concise.\n\n${bullets}`
      }],
      { providerId, model, maxTokens: 1200, temperature: 0.3 }
    );
    synthesis = summary.content || "";
  } catch {
    synthesis = `# ${q}\n\n## Findings\n\n${bullets}\n`;
  }

  const fileName = `${safeFileBase(q)}-research.md`;
  const dir = getWorkspaceDir();
  await fs.mkdir(dir, { recursive: true });
  const body = `---\ntitle: ${JSON.stringify(`Research: ${q}`)}\n---\n\n${synthesis}\n`;
  await fs.writeFile(path.join(dir, fileName), body, "utf8");

  return {
    ok: true,
    topic: q,
    fileName,
    markdown: synthesis,
    search
  };
}

export async function generateImageAsset(prompt, { providerId = "", model = "", size = "1024x1024" } = {}) {
  const text = String(prompt || "").trim();
  if (!text) return { error: "prompt is required" };

  const generated = await generateImage(text, { providerId, model, size });
  if (generated.error) return generated;

  const fileName = `gen-${Date.now().toString(36)}.png`;
  const filePath = path.join(getWorkspaceDir(), fileName);
  const buf = Buffer.from(generated.base64, "base64");
  await fs.writeFile(filePath, buf);

  let element = null;
  await updateBoard((board) => {
    element = normalizeElement({
      id: newId("image"),
      type: "image",
      x: 120,
      y: 120,
      width: 320,
      height: 240,
      url: workspaceFileUrl(fileName),
      text: fileName,
      meta: { sourceFile: fileName, generated: true, prompt: text }
    });
    board.elements.push(element);
    return board;
  });

  return {
    ok: true,
    fileName,
    url: workspaceFileUrl(fileName),
    elementId: element?.id,
    revisedPrompt: generated.revisedPrompt || text
  };
}

export async function createDocumentFromOutline(title, sections, { x = 0, y = 0 } = {}) {
  const t = String(title || "Document").trim();
  const lines = [`# ${t}`, ""];
  for (const section of sections || []) {
    const heading = String(section?.title || section?.heading || "Section").trim();
    const body = String(section?.body || section?.text || "").trim();
    lines.push(`## ${heading}`, "", body, "");
  }
  const markdown = lines.join("\n");
  const fileName = `${safeFileBase(t)}.md`;
  const dir = getWorkspaceDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, fileName),
    `---\ntitle: ${JSON.stringify(t)}\n---\n\n${markdown}\n`,
    "utf8"
  );

  let card = null;
  await updateBoard((board) => {
    card = normalizeElement({
      id: newId("card"),
      type: "card",
      x: Number(x) || 0,
      y: Number(y) || 0,
      text: markdown,
      meta: { title: t, sourceFile: fileName, planeView: "content" }
    });
    board.elements.push(card);
    return board;
  });

  return { ok: true, fileName, cardId: card?.id, markdown };
}

export async function createRegionFrame(label, { x = 0, y = 0, width = 800, height = 600, elementIds = [] } = {}) {
  let frame = null;
  await updateBoard((board) => {
    frame = normalizeElement({
      id: newId("frame"),
      type: "frame",
      x: Number(x) || 0,
      y: Number(y) || 0,
      width: Number(width) || 800,
      height: Number(height) || 600,
      fill: "transparent",
      stroke: "#64748b",
      strokeWidth: 2,
      text: String(label || "Region"),
      meta: { regionLabel: String(label || "Region"), regionKind: "workspace" }
    });
    board.elements.unshift(frame);
    const ids = new Set((elementIds || []).map(String));
    board.elements = board.elements.map((e) => {
      if (!ids.has(e.id) || e.id === frame.id) return e;
      return normalizeElement({ ...e, meta: { ...(e.meta || {}), parentFrameId: frame.id } });
    });
    return board;
  });
  return { ok: true, frameId: frame?.id, label: frame?.text };
}
