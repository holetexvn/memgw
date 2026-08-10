// Generates the README diagrams: docs/assets/{architecture,session}-{en,vi}-{light,dark}.svg
// Hand-laid-out SVG instead of mermaid so the layout is deliberate and stable.
//   node docs/assets/generate.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const FONT = `-apple-system, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;

const PALETTES = {
  light: {
    ink: "#24292f", dim: "#57606a", border: "#d0d7de", group: "#f6f8fa", box: "#ffffff",
    blue: "#0969da", orange: "#bc4c00", green: "#1a7f37",
  },
  dark: {
    ink: "#e6edf3", dim: "#9198a1", border: "#3d444d", group: "#151b23", box: "#0d1117",
    blue: "#4493f8", orange: "#db6d28", green: "#3fb950",
  },
};

const T = {
  en: {
    agents: "🤖 Your agents", gateway: "memgw gateway", gatewaySub: "one local process",
    store: "💾 One store", storeSub: "SQLite + git",
    agentList: [
      ["Claude Code", "hooks"],
      ["Codex CLI", "transcript watcher"],
      ["opencode", "plugin"],
      ["claude.ai · web", "MCP connector"],
    ],
    api: "HTTP API  :8930", apiSub: "capture · facts · notes",
    mcp: "MCP server  :8931", mcpSub: "5 tools for every agent",
    capture: "capture", captureSub: "instant · no LLM",
    tools: "MCP tools", toolsSub: "search · save",
    append: "append raw turns",
    worker: "⚙ worker: extract + dedup", workerSub: "background · 2 LLM calls/batch",
    notesUpd: "📝 notes updater · git commit", notesUpdSub: "agentic · auditable",
    search: "hybrid search · read notes",
    events: "events", eventsSub: "raw turns · 90 days",
    facts: "facts", factsSub: "one-sentence atoms · forever",
    notes: "notes", notesSub: "Markdown · git · forever",
    archAlt: "memgw architecture",
    phases: ["SESSION START", "WHILE YOU WORK", "SESSION END", "+10 MIN · BACKGROUND", "NEXT SESSION"],
    cards: [
      ["bootstrap", ["profile + topic index", "injected once,", "stays in prompt cache"]],
      ["MCP tools", ["memory_search(…)", "memory_save(deadend)", "called only when needed"]],
      ["capture", ["raw turns appended", "instant · no LLM", "never blocks the agent"]],
      ["distil", ["extract facts + dedup", "update topic notes", "git commit"]],
      ["bootstrap again", ["any agent, any machine", "it already knows you", ""]],
    ],
  },
  vi: {
    agents: "🤖 Agent của bạn", gateway: "memgw gateway", gatewaySub: "một process local",
    store: "💾 Một kho", storeSub: "SQLite + git",
    agentList: [
      ["Claude Code", "hooks"],
      ["Codex CLI", "watcher transcript"],
      ["opencode", "plugin"],
      ["claude.ai · web", "MCP connector"],
    ],
    api: "HTTP API  :8930", apiSub: "capture · facts · notes",
    mcp: "MCP server  :8931", mcpSub: "5 tool cho mọi agent",
    capture: "capture", captureSub: "tức thì · không LLM",
    tools: "MCP tools", toolsSub: "search · save",
    append: "ghi lượt thô",
    worker: "⚙ worker: chưng cất + dedup", workerSub: "background · 2 lệnh LLM/batch",
    notesUpd: "📝 notes updater · git commit", notesUpdSub: "agentic · soát được",
    search: "hybrid search · đọc notes",
    events: "events", eventsSub: "lượt thô · 90 ngày",
    facts: "facts", factsSub: "câu đơn · vĩnh viễn",
    notes: "notes", notesSub: "Markdown · git · vĩnh viễn",
    archAlt: "kiến trúc memgw",
    phases: ["MỞ PHIÊN", "TRONG LÚC LÀM VIỆC", "KẾT THÚC PHIÊN", "+10 PHÚT · BACKGROUND", "PHIÊN SAU"],
    cards: [
      ["bootstrap", ["profile + mục lục topic", "bơm đúng một lần,", "nằm yên trong prompt cache"]],
      ["MCP tools", ["memory_search(…)", "memory_save(deadend)", "chỉ gọi khi cần"]],
      ["capture", ["ghi lượt thô", "tức thì · không LLM", "không bao giờ chặn agent"]],
      ["chưng cất", ["trích fact + dedup", "cập nhật topic notes", "git commit"]],
      ["bootstrap lại", ["agent nào, máy nào cũng vậy", "nó đã biết bạn là ai", ""]],
    ],
  },
};

const defs = (p) => `<defs>
  <marker id="ab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${p.blue}"/></marker>
  <marker id="ao" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${p.orange}"/></marker>
  <marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${p.green}"/></marker>
</defs>`;

const text = (x, y, s, { size = 12, fill, weight = "normal", anchor = "middle", spacing = "" } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ""}>${s}</text>`;

function cylinder(x, y, w, h, p, title, sub) {
  const ry = 12;
  return `<path d="M${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z" fill="${p.box}" stroke="${p.border}" stroke-width="1.5"/>
  <ellipse cx="${x + w / 2}" cy="${y + ry}" rx="${w / 2}" ry="${ry}" fill="${p.box}" stroke="${p.border}" stroke-width="1.5"/>
  ${text(x + w / 2, y + h / 2 + 4, title, { size: 15, weight: 600, fill: p.ink })}
  ${text(x + w / 2, y + h / 2 + 24, sub, { size: 11, fill: p.dim })}`;
}

function architecture(t, p) {
  const parts = [];
  // groups
  const group = (x, y, w, h, title, sub) => {
    parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${p.group}" stroke="${p.border}"/>`);
    parts.push(text(x + w / 2, y + 30, title, { size: 14, weight: 600, fill: p.ink }));
    if (sub) parts.push(text(x + w / 2, y + 48, sub, { size: 11, fill: p.dim }));
  };
  group(30, 70, 250, 480, t.agents, "");
  group(430, 70, 300, 480, t.gateway, t.gatewaySub);
  group(880, 70, 270, 480, t.store, t.storeSub);

  // agent boxes
  t.agentList.forEach(([name, sub], i) => {
    const y = 120 + i * 95;
    parts.push(`<rect x="60" y="${y}" width="190" height="72" rx="8" fill="${p.box}" stroke="${p.border}" stroke-width="1.5"/>`);
    parts.push(text(155, y + 32, name, { size: 13.5, weight: 600, fill: p.ink }));
    parts.push(text(155, y + 52, sub, { size: 11, fill: p.dim }));
  });

  // gateway boxes
  const gbox = (y, title, sub, stroke) => {
    parts.push(`<rect x="455" y="${y}" width="250" height="84" rx="8" fill="${p.box}" stroke="${stroke}" stroke-width="1.5"/>`);
    parts.push(text(580, y + 36, title, { size: 14, weight: 600, fill: p.ink }));
    parts.push(text(580, y + 58, sub, { size: 11, fill: p.dim }));
  };
  gbox(150, t.api, t.apiSub, p.blue);
  gbox(330, t.mcp, t.mcpSub, p.green);

  // store
  parts.push(cylinder(915, 120, 200, 100, p, t.events, t.eventsSub));
  parts.push(cylinder(915, 285, 200, 100, p, t.facts, t.factsSub));
  parts.push(`<rect x="915" y="450" width="200" height="80" rx="8" fill="${p.box}" stroke="${p.border}" stroke-width="1.5"/>`);
  parts.push(text(1015, 484, t.notes, { size: 15, weight: 600, fill: p.ink }));
  parts.push(text(1015, 504, t.notesSub, { size: 11, fill: p.dim }));

  // arrows: agents -> gateway
  parts.push(`<line x1="285" y1="192" x2="450" y2="192" stroke="${p.blue}" stroke-width="2" marker-end="url(#ab)"/>`);
  parts.push(text(367, 172, t.capture, { size: 12, weight: 600, fill: p.blue }));
  parts.push(text(367, 212, t.captureSub, { size: 10.5, fill: p.dim }));
  parts.push(`<line x1="285" y1="372" x2="450" y2="372" stroke="${p.blue}" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#ab)"/>`);
  parts.push(text(367, 352, t.tools, { size: 12, weight: 600, fill: p.blue }));
  parts.push(text(367, 392, t.toolsSub, { size: 10.5, fill: p.dim }));

  // API -> events
  parts.push(`<path d="M710 178 C 810 170, 840 170, 908 170" fill="none" stroke="${p.blue}" stroke-width="2" marker-end="url(#ab)"/>`);
  parts.push(text(808, 156, t.append, { size: 11.5, fill: p.dim }));

  // MCP -> store (search)
  parts.push(`<line x1="710" y1="372" x2="873" y2="372" stroke="${p.green}" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#ag)"/>`);
  parts.push(text(792, 358, t.search, { size: 11.5, fill: p.green }));

  // pipeline arrows inside store
  parts.push(`<line x1="1015" y1="224" x2="1015" y2="278" stroke="${p.orange}" stroke-width="2" marker-end="url(#ao)"/>`);
  parts.push(text(998, 244, t.worker, { size: 11.5, weight: 600, fill: p.orange, anchor: "end" }));
  parts.push(text(998, 262, t.workerSub, { size: 10.5, fill: p.dim, anchor: "end" }));
  parts.push(`<line x1="1015" y1="389" x2="1015" y2="443" stroke="${p.orange}" stroke-width="2" marker-end="url(#ao)"/>`);
  parts.push(text(998, 409, t.notesUpd, { size: 11.5, weight: 600, fill: p.orange, anchor: "end" }));
  parts.push(text(998, 427, t.notesUpdSub, { size: 10.5, fill: p.dim, anchor: "end" }));

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1180 580" role="img" aria-label="${t.archAlt}">
${defs(p)}
${parts.join("\n")}
</svg>`;
}

function session(t, p) {
  const parts = [];
  const xs = [30, 265, 500, 735, 970];
  t.phases.forEach((ph, i) => {
    const x = xs[i];
    parts.push(text(x + 100, 72, ph, { size: 11, weight: 600, fill: p.dim, spacing: "1" }));
    const accent = i === 4 ? p.blue : p.border;
    parts.push(`<rect x="${x}" y="90" width="200" height="170" rx="10" fill="${i === 4 ? p.group : p.box}" stroke="${accent}" stroke-width="${i === 4 ? 2 : 1.5}"/>`);
    const [title, lines] = t.cards[i];
    parts.push(text(x + 100, 125, title, { size: 14.5, weight: 600, fill: i === 4 ? p.blue : p.ink }));
    lines.forEach((l, j) => {
      if (l) parts.push(text(x + 100, 158 + j * 24, l, { size: 12, fill: j === 1 && i === 4 ? p.ink : p.dim, weight: j === 1 && i === 4 ? 600 : "normal" }));
    });
    if (i < 4) parts.push(`<line x1="${x + 204}" y1="175" x2="${x + 261}" y2="175" stroke="${p.blue}" stroke-width="2" marker-end="url(#ab)"/>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 290" role="img" aria-label="memgw session lifecycle">
${defs(p)}
${parts.join("\n")}
</svg>`;
}

for (const lang of ["en", "vi"]) {
  for (const theme of ["light", "dark"]) {
    writeFileSync(join(OUT, `architecture-${lang}-${theme}.svg`), architecture(T[lang], PALETTES[theme]));
    writeFileSync(join(OUT, `session-${lang}-${theme}.svg`), session(T[lang], PALETTES[theme]));
  }
}
console.log("wrote 8 SVGs to", OUT);
