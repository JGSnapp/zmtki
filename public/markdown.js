// Lightweight markdown <-> block model <-> HTML helpers used by the document
// editor and the on-canvas card preview. No dependencies; intentionally small.
//
// Block kinds: h1, h2, h3, text, bullet, todo, quote, code, divider.
// Inline spans: **bold**, *italic*, `code`, [label](url).

(function () {
  const CODE_FENCE = /^(`{3,}|~{3,})/;

  // ---------- GFM table helpers ----------
  function isTableRow(line) {
    const t = line.trim();
    return t.startsWith("|") && t.endsWith("|") && t.length >= 3;
  }
  function isTableSeparator(line) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) return false;
    return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(t);
  }
  function splitTableRow(line) {
    const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return t.split("|").map((c) => c.trim().replace(/\\\|/g, "|"));
  }

  // Parse a single non-table line into a block (used by the align-marker path).
  function parseSingle(line) {
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) return { kind: "h" + h[1].length, text: h[2].trim() };
    if (/^>\s?/.test(line)) return { kind: "quote", text: line.replace(/^>\s?/, "") };
    const todo = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) return { kind: "todo", checked: todo[1].toLowerCase() === "x", text: todo[2] };
    if (/^\s*[-*+]\s+/.test(line)) return { kind: "bullet", text: line.replace(/^\s*[-*+]\s+/, "") };
    if (line.trim() && /^\s*([-*])\1{2,}\s*$/.test(line)) return { kind: "divider" };
    return { kind: "text", text: line };
  }

  // ---------- markdown text -> blocks ----------

  function parseMarkdown(md) {
    const blocks = [];
    const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      const fence = line.match(CODE_FENCE);
      if (fence) {
        const marker = fence[1][0];
        const width = fence[1].length;
        const buf = [];
        i++;
        while (i < lines.length) {
          const re = new RegExp(`^${marker === "`" ? "`" : "~"}{${width},}\\s*$`);
          if (re.test(lines[i])) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        blocks.push({ kind: "code", text: buf.join("\n") });
        continue;
      }

      // blank line
      if (!line.trim()) { i++; continue; }

      // alignment marker emitted by the editor: <!-- align: center|right|left -->
      const alignMatch = line.match(/^<!--\s*align:\s*(left|center|right)\s*-->\s*$/i);
      if (alignMatch) {
        const align = alignMatch[1].toLowerCase();
        i++;
        if (i < lines.length) {
          const parsed = parseSingle(lines[i]);
          if (parsed) { parsed.align = align; blocks.push(parsed); i++; continue; }
        }
        continue;
      }

      // GFM table: a header row, a separator row of dashes/colons, then body rows.
      if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        const rows = [];
        while (i < lines.length && (isTableRow(lines[i]) || isTableSeparator(lines[i]))) {
          if (!isTableSeparator(lines[i])) rows.push(splitTableRow(lines[i]));
          i++;
        }
        if (rows.length) { blocks.push({ kind: "table", rows }); continue; }
      }

      // divider
      if (/^\s*([-*])\1{2,}\s*$/.test(line)) {
        blocks.push({ kind: "divider" });
        i++;
        continue;
      }

      // headings
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        blocks.push({ kind: "h" + h[1].length, text: h[2].trim() });
        i++;
        continue;
      }

      // blockquote
      if (/^>\s?/.test(line)) {
        blocks.push({ kind: "quote", text: line.replace(/^>\s?/, "") });
        i++;
        continue;
      }

      // todo list item
      const todo = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
      if (todo) {
        blocks.push({ kind: "todo", checked: todo[1].toLowerCase() === "x", text: todo[2] });
        i++;
        continue;
      }

      // bullet list item
      if (/^\s*[-*+]\s+/.test(line)) {
        blocks.push({ kind: "bullet", text: line.replace(/^\s*[-*+]\s+/, "") });
        i++;
        continue;
      }

      // numbered list item -> treat as bullet
      const num = line.match(/^\s*\d+\.\s+(.*)$/);
      if (num) {
        blocks.push({ kind: "bullet", text: num[1] });
        i++;
        continue;
      }

      blocks.push({ kind: "text", text: line });
      i++;
    }
    if (!blocks.length) blocks.push({ kind: "text", text: "" });
    return blocks;
  }

  // ---------- blocks -> markdown text ----------

  // Convert inline HTML stored on a block (from the editor's contentEditable)
  // back into markdown so formatting survives a round trip.
  function inlineHtmlToMarkdown(html) {
    if (!html) return "";
    let s = String(html);
    s = s.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, (_, t) => `**${inlineHtmlToMarkdown(t)}**`);
    s = s.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, (_, t) => `**${inlineHtmlToMarkdown(t)}**`);
    s = s.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, (_, t) => `*${inlineHtmlToMarkdown(t)}*`);
    s = s.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, (_, t) => `*${inlineHtmlToMarkdown(t)}*`);
    s = s.replace(/<s[^>]*>([\s\S]*?)<\/s>/gi, (_, t) => `~~${inlineHtmlToMarkdown(t)}~~`);
    s = s.replace(/<strike[^>]*>([\s\S]*?)<\/strike>/gi, (_, t) => `~~${inlineHtmlToMarkdown(t)}~~`);
    s = s.replace(/<del[^>]*>([\s\S]*?)<\/del>/gi, (_, t) => `~~${inlineHtmlToMarkdown(t)}~~`);
    s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${t}\``);
    s = s.replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `[${inlineHtmlToMarkdown(t)}](${href})`);
    s = s.replace(/<br\s*\/?>([\s\S]*)/gi, (_, rest) => `\n${inlineHtmlToMarkdown(rest)}`);
    // strip any remaining tags
    s = s.replace(/<[^>]+>/g, "");
    // decode the few entities we emit
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    return s.replace(/\r/g, "");
  }

  function blockInline(b) {
    // Prefer the saved inline HTML (rich formatting), else fall back to text.
    if (b.html) return inlineHtmlToMarkdown(b.html).trim();
    return String(b.text || "");
  }

  function blocksToMarkdown(blocks) {
    const out = (Array.isArray(blocks) ? blocks : []).map((b) => {
      const body = blockInline(b);
      let line;
      switch (b.kind) {
        case "h1": line = `# ${body}`; break;
        case "h2": line = `## ${body}`; break;
        case "h3": line = `### ${body}`; break;
        case "bullet": line = `- ${body}`; break;
        case "todo": line = `- [${b.checked ? "x" : " "}] ${body}`; break;
        case "quote": line = `> ${body}`; break;
        case "code": line = "```\n" + (b.text || "") + "\n```"; break;
        case "divider": line = "---"; break;
        case "table": line = tableToMd(b.rows); break;
        default: line = body;
      }
      // Encode alignment as an HTML comment so it round-trips without breaking
      // markdown readability too much.
      if (b.align && b.align !== "left" && b.kind !== "table" && b.kind !== "code") {
        return `<!-- align: ${b.align} -->\n${line}`;
      }
      return line;
    });
    return out.join("\n");
  }

  function tableToMd(rows) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const header = rows[0].map((c) => String(c == null ? "" : c).replace(/\|/g, "\\|"));
    const sep = header.map(() => "---");
    const lines = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].map((c) => String(c == null ? "" : c).replace(/\|/g, "\\|"));
      lines.push(`| ${cells.join(" | ")} |`);
    }
    return lines.join("\n");
  }

  // ---------- inline markdown -> safe HTML ----------

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function inlineHtml(text) {
    let s = escapeHtml(text);
    // inline code first to protect its contents
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/~~([^~]+)~~/g, "<s>$1</s>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
    return s;
  }

  // ---------- blocks -> HTML (for preview) ----------

  function blocksToHtml(blocks) {
    const src = Array.isArray(blocks) ? blocks : [];
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const b = src[i];
      const t = inlineHtml(b.text);
      switch (b.kind) {
        case "h1": out.push(`<h1>${t}</h1>`); break;
        case "h2": out.push(`<h2>${t}</h2>`); break;
        case "h3": out.push(`<h3>${t}</h3>`); break;
        case "bullet": {
          const items = [];
          while (i < src.length && src[i].kind === "bullet") {
            items.push(`<li>${inlineHtml(src[i].text)}</li>`);
            i++;
          }
          i--;
          out.push(`<ul>${items.join("")}</ul>`);
          break;
        }
        case "todo": {
          const items = [];
          while (i < src.length && src[i].kind === "todo") {
            const item = src[i];
            items.push(`<li><span class="checkbox ${item.checked ? "checked" : ""}"></span><span>${inlineHtml(item.text)}</span></li>`);
            i++;
          }
          i--;
          out.push(`<ul class="todo">${items.join("")}</ul>`);
          break;
        }
        case "quote": out.push(`<blockquote>${t}</blockquote>`); break;
        case "code": out.push(`<pre><code>${escapeHtml(b.text)}</code></pre>`); break;
        case "divider": out.push("<hr>"); break;
        case "table": out.push(tableToHtml(b.rows)); break;
        default: out.push(`<p>${t}</p>`);
      }
    }
    return out.join("");
  }

  function tableToHtml(rows) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const esc = (c) => escapeHtml(String(c == null ? "" : c));
    const head = rows[0].map((c) => `<th>${esc(c)}</th>`).join("");
    let out = `<table><thead><tr>${head}</tr></thead><tbody>`;
    for (let i = 1; i < rows.length; i++) {
      out += `<tr>${rows[i].map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`;
    }
    return `${out}</tbody></table>`;
  }

  function markdownToHtml(md) {
    return blocksToHtml(parseMarkdown(md));
  }

  // ---------- block <-> single line markdown ----------

  // Convert a block into the markdown prefix + text used to seed an editor line.
  function blockToLine(b) {
    switch (b.kind) {
      case "h1": return { prefix: "# ", text: b.text || "" };
      case "h2": return { prefix: "## ", text: b.text || "" };
      case "h3": return { prefix: "### ", text: b.text || "" };
      case "bullet": return { prefix: "- ", text: b.text || "" };
      case "todo": return { prefix: b.checked ? "- [x] " : "- [ ] ", text: b.text || "" };
      case "quote": return { prefix: "> ", text: b.text || "" };
      default: return { prefix: "", text: b.text || "" };
    }
  }

  // Parse a typed line back into a block kind using its markdown prefix.
  function lineToBlock(raw) {
    const line = raw.replace(/\s+$/, "");
    if (/^#{1}\s/.test(line)) return { kind: "h1", text: line.replace(/^#\s+/, "") };
    if (/^#{2}\s/.test(line)) return { kind: "h2", text: line.replace(/^##\s+/, "") };
    if (/^#{3}\s/.test(line)) return { kind: "h3", text: line.replace(/^###\s+/, "") };
    if (/^>\s?/.test(line)) return { kind: "quote", text: line.replace(/^>\s?/, "") };
    const todo = line.match(/^-\s+\[([ xX])\]\s(.*)$/);
    if (todo) return { kind: "todo", checked: todo[1].toLowerCase() === "x", text: todo[2] };
    if (/^-\s+/.test(line)) return { kind: "bullet", text: line.replace(/^-\s+/, "") };
    if (/^([-*])\1{2,}$/.test(line.trim())) return { kind: "divider", text: "" };
    return { kind: "text", text: line };
  }

  window.md = {
    parse: parseMarkdown,
    toMarkdown: blocksToMarkdown,
    toHtml: blocksToHtml,
    markdownToHtml,
    inlineHtml,
    escapeHtml,
    blockToLine,
    lineToBlock
  };
})();
