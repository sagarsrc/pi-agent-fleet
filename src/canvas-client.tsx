import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Edge, Node, NodeProps } from "@xyflow/react";
import { computePositions, excerptText, NODE_W } from "./canvas-layout.js";

/* ---------- payload types (mirror canvas.ts) ---------- */
interface CanvasNodeView {
  id: string;
  type: string;
  task: string;
  status: string;
  model: string;
  effort?: string;
  turns: number;
  tokens: number;
  cost_usd_estimate: number;
  status_note?: string;
  produced_outputs: string[];
  outputs: Array<{ path: string; kind: string; required: boolean }>;
  depends_on: string[];
  iterate: boolean;
  worktree: boolean;
}
interface CanvasPayload {
  fleet_name: string;
  status: string;
  created_at: string;
  iteration: number;
  lgtm_streak: number;
  paused: boolean;
  cost_usd_estimate: number;
  demo?: boolean;
  empty?: boolean;
  loop?: { gate: string; max_iterations: number; lgtm_count: number };
  config: { max_concurrent: number; model?: string; effort?: string; warn_cost_usd?: number };
  nodes: CanvasNodeView[];
  edges: Array<{ from: string; to: string }>;
  iterations: Array<{ n: number; verdict: string | null; cost: number; tokens: number; duration_ms: number }>;
  generated_at: string;
}
interface FleetInfo { name: string; status: string }
interface SessionEntry { role: string; text: string }
interface ActionView {
  type: "tool_call" | "tool_result" | "model_change" | "thinking_level_change" | "complete";
  name?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  stopReason?: string;
  isError?: boolean;
  timestamp?: string;
}
type TimelineEvent =
  | { type: "message"; role: string; text: string; timestamp?: string }
  | { type: "tool_call"; name: string; arguments?: Record<string, unknown>; timestamp?: string }
  | { type: "tool_result"; toolName?: string; isError?: boolean; text?: string; timestamp?: string }
  | { type: "model_change"; provider: string; modelId: string; timestamp?: string }
  | { type: "thinking_level_change"; thinkingLevel: string; timestamp?: string }
  | { type: "complete"; stopReason: string; timestamp?: string };
interface SessionResp { entries: SessionEntry[]; actions: ActionView[]; events: TimelineEvent[]; task?: string }

/* ---------- helpers ---------- */
function statusClass(s: string): string {
  return "st-" + s.replace(/\s+/g, "_");
}
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#8b949e";
}
function minimapColor(status: string): string {
  if (status === "completed") return cssVar("--ok");
  if (status === "running") return cssVar("--accent");
  if (status === "failed" || status === "contract_failed") return cssVar("--bad");
  if (status === "killed" || status === "blocked") return cssVar("--wire");
  return cssVar("--line");
}
function shortModel(model: string): string {
  return model.split("/").pop()?.replace(/^deepseek-/, "") || model;
}
function j<T>(u: string): Promise<T> {
  return fetch(u).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json() as Promise<T>;
  });
}

/* ---------- custom node ---------- */
type FleetNodeData = {
  view: CanvasNodeView;
  selected: boolean;
  demo: boolean;
  gate: boolean;
  nodeRole: "start" | "end" | "gate" | "normal";
  fleet: string | null;
  onOpen: (id: string) => void;
};

function FleetNode({ data }: NodeProps<Node<FleetNodeData>>) {
  const { view: n, selected } = data;
  const running = n.status === "running";
  const roleLabel = data.nodeRole === "start" ? "START" : data.nodeRole === "end" ? "END" : data.nodeRole === "gate" ? "GATE" : null;

  const flags: Array<{ label: string; title: string }> = [];
  if (data.gate) flags.push({ label: "⟳ loop gate", title: "Reviewer gate: its verdict decides whether the fleet iterates again" });
  if (n.iterate === false) flags.push({ label: "once", title: "Runs once; not re-run on loop iterations" });
  if (n.worktree) flags.push({ label: "worktree", title: "Runs in an isolated git worktree" });

  const activate = () => { data.onOpen(n.id); };

  const isFailed = n.status === "failed" || n.status === "contract_failed";
  const missingRequired = n.outputs.filter((o) => o.required && !n.produced_outputs.includes(o.path)).map((o) => o.path);
  const failReason = isFailed && !n.status_note
    ? (missingRequired.length ? `missing required output: ${missingRequired.join(", ")}` : "worker did not complete — open for details")
    : "";
  const ariaLabel =
    `${n.id}, ${n.type}, ${n.status}, ${n.turns} turns, ${(Number(n.tokens || 0) / 1000).toFixed(1)}k tokens, ` +
    `$${Number(n.cost_usd_estimate || 0).toFixed(2)}${n.status_note ? `, ${n.status_note}` : failReason ? `, ${failReason}` : ""}`;

  return (
    <div
      className={"node " + statusClass(n.status) + " role-" + data.nodeRole + (selected ? " sel" : "")}
      data-node-id={n.id}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={ariaLabel}
      onClick={activate}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } }}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="target" position={Position.Bottom} id="loopIn" />
      <div className="card-body">
        <div className="node-header">
          <span className={"node-dot" + (running ? " pulse" : "")} style={{ background: minimapColor(n.status) }} aria-hidden="true" />
          <span className="id" title={n.id}>{n.id}</span>
          {roleLabel && <span className="role-badge">{roleLabel}</span>}
          <span className="badge">{n.type}</span>
        </div>
        <div className="status-row">
          {running && <span className="spinner" />}
          <span className="st-word">{n.status}</span>
          {n.effort && <><span>·</span><span>{n.effort}</span></>}
          <span>·</span><span title={n.model}>{shortModel(n.model)}</span>
        </div>
        <div className="stats">
          {(n.turns | 0)} turns · {(Number(n.tokens || 0) / 1000).toFixed(1)}k tok · ${Number(n.cost_usd_estimate || 0).toFixed(2)}
        </div>
        {n.outputs?.length > 0 && (
          <div className="outputs">
            <span className="out-count" title={n.outputs.map((o) => `${o.path} · ${o.kind}`).join("\n")}>{n.outputs.length} output{n.outputs.length === 1 ? "" : "s"}</span>
            <span className="out-chip">{n.outputs[0].kind}</span>
          </div>
        )}
        {flags.length > 0 && (
          <div className="flags">
            {flags.map((f, i) => (
              <span key={i} title={f.title}>{i > 0 ? " · " : ""}{f.label}</span>
            ))}
          </div>
        )}
        {n.status_note && <div className="note nodrag">{n.status_note}</div>}
        {failReason && <div className="fail-reason nodrag">{failReason}</div>}
      </div>
      <Handle type="source" position={Position.Right} />
      <Handle type="source" position={Position.Bottom} id="loop" />
    </div>
  );
}
const nodeTypes = { fleet: FleetNode };

/* ---------- side panel ---------- */
function CollapsiblePrompt({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className={"collapsible" + (open ? "" : " collapsed")}>
      <button className="collapsible-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="chevron">{open ? "-" : "+"}</span>
        <span>{title}</span>
      </button>
      <div className="collapsible-body">{text}</div>
    </div>
  );
}

function formatActionDetail(a: { arguments?: Record<string, unknown> }): string {
  const args = a.arguments || {};
  if (typeof args.path === "string") return args.path;
  if (typeof args.command === "string") return args.command;
  if (Array.isArray(args.queries)) return String(args.queries[0]);
  const keys = Object.keys(args);
  if (keys[0]) return `${keys[0]}: ${JSON.stringify(args[keys[0]]).slice(0, 40)}`;
  return "";
}

function TimelineItem({ event }: { event: TimelineEvent }) {
  const [open, setOpen] = useState(event.isError ? true : false);
  const [expanded, setExpanded] = useState(false);
  const ts = event.timestamp ? new Date(event.timestamp).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  if (event.type === "message") {
    const { excerpt, truncated } = excerptText(event.text, 240);
    const text = truncated && !expanded ? excerpt : event.text;
    return (
      <div className={"timeline-msg" + (event.role === "assistant" ? " assistant" : event.role === "user" ? " user" : "")}>
        <div className="timeline-meta">
          <span className="role">{event.role}</span>
          {ts && <span className="ts">{ts}</span>}
        </div>
        <div className="timeline-text">{text}</div>
        {truncated && (
          <button className="timeline-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "show less" : "show more"}
          </button>
        )}
      </div>
    );
  }
  if (event.type === "tool_call") {
    const detail = formatActionDetail(event);
    const hasArgs = !!event.arguments && Object.keys(event.arguments).length > 0;
    return (
      <div className={"timeline-action" + (open ? " open" : "")}>
        <div className="timeline-row">
          <button className="activity-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open} title={open ? "collapse" : "expand"}>{open ? "-" : "+"}</button>
          <span className="action-icon">call</span>
          <span className="action-name">{event.name}</span>
          {detail && <span className="action-detail" title={detail}>{detail}</span>}
          {ts && <span className="ts">{ts}</span>}
        </div>
        {open && hasArgs && (
          <div className="activity-body">
            <pre>{JSON.stringify(event.arguments, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }
  if (event.type === "tool_result") {
    const hasText = !!event.text && event.text.length > 0;
    const expanded = open;
    return (
      <div className={"timeline-action" + (event.isError ? " action-error" : "") + (expanded ? " open" : "")}>
        <div className="timeline-row">
          <button className="activity-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={expanded} title={expanded ? "collapse" : "expand"}>{expanded ? "-" : "+"}</button>
          <span className={"action-icon" + (event.isError ? " action-error" : "")}>{event.isError ? "err" : "ok"}</span>
          <span className="action-name">{event.toolName || "result"}</span>
          {event.text && <span className={"action-detail" + (event.isError ? " action-error" : "")} title={event.text}>{event.isError ? "Error: " : ""}{event.text}</span>}
          {ts && <span className="ts">{ts}</span>}
        </div>
        {expanded && hasText && (
          <div className="activity-body">
            {event.isError ? <strong>Error: </strong> : null}
            {event.text}
          </div>
        )}
      </div>
    );
  }
  if (event.type === "model_change") {
    return (
      <div className="timeline-action">
        <div className="timeline-row">
          <span className="action-icon">mdl</span>
          <span className="action-name">model</span>
          <span className="action-detail">{event.provider}/{event.modelId}</span>
          {ts && <span className="ts">{ts}</span>}
        </div>
      </div>
    );
  }
  if (event.type === "thinking_level_change") {
    return (
      <div className="timeline-action">
        <div className="timeline-row">
          <span className="action-icon">think</span>
          <span className="action-name">thinking</span>
          <span className="action-detail">{event.thinkingLevel}</span>
          {ts && <span className="ts">{ts}</span>}
        </div>
      </div>
    );
  }
  if (event.type === "complete") {
    return (
      <div className="timeline-action">
        <div className="timeline-row">
          <span className="action-icon">done</span>
          <span className="action-name">done</span>
          {event.stopReason !== "complete" && event.stopReason !== "stop" && <span className="action-detail">{event.stopReason}</span>}
          {ts && <span className="ts">{ts}</span>}
        </div>
      </div>
    );
  }
  return null;
}

function Timeline({ events }: { events: TimelineEvent[] }) {
  const visible = events.filter((e) => e.type !== "model_change" && e.type !== "thinking_level_change");
  if (!visible.length) return <div className="timeline-empty">No session data yet.</div>;
  return (
    <div className="timeline" aria-label="Agent session timeline">
      {visible.map((e, i) => <TimelineItem event={e} key={e.type + (e.timestamp || "") + "-" + i} />)}
    </div>
  );
}

function SidePanel({ fleet, demo, selected, task, onClose }: { fleet: string | null; demo: boolean; selected: string | null; task: string | null; onClose: () => void }) {
  const [resp, setResp] = useState<SessionResp | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // move focus into the panel on open (silently, no visible ring); restore to the node on close
  useEffect(() => { if (selected) boxRef.current?.focus(); }, [selected]);
  const closeAndRestore = () => {
    const id = selected;
    onClose();
    if (id) (document.querySelector(`.node[data-node-id="${id}"]`) as HTMLElement | null)?.focus();
  };

  useEffect(() => {
    if (!selected) { setResp(null); return; }
    let alive = true;
    const load = () => {
      const q = fleet ? "&fleet=" + encodeURIComponent(fleet) : "";
      const demoQ = demo ? "&demo=1" : "";
      j<SessionResp>("/api/session/" + selected + "?tail=30" + q + demoQ).then((r) => alive && setResp(r)).catch(() => {});
    };
    load();
    const t = setInterval(load, 2000);
    return () => { alive = false; clearInterval(t); };
  }, [selected, demo, fleet]);

  // close on Escape while open (and restore focus to the node)
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const id = selected;
      onClose();
      if (id) (document.querySelector(`.node[data-node-id="${id}"]`) as HTMLElement | null)?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onClose]);

  // follow the latest transcript turn when the operator is already near the bottom
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [resp]);

  const latestModel = resp?.events?.slice().reverse().find((e): e is TimelineEvent & { type: "model_change" } => e.type === "model_change");
  const latestThinking = resp?.events?.slice().reverse().find((e): e is TimelineEvent & { type: "thinking_level_change" } => e.type === "thinking_level_change");
  if (!selected) return null;
  return (
    <div id="side" className="open" role="complementary" aria-label={`${selected} session`}>
      <div className="side-head">
        <span className="meta"><span className="side-hash">#</span> <strong className="side-id">{selected}</strong> — session</span>
        <button className="icon-btn" onClick={closeAndRestore} aria-label="Close session panel" title="Close (Esc)">×</button>
        {(!!latestModel || !!latestThinking) && (
          <div className="side-meta">
            {latestModel && <span className="side-meta-chip">{latestModel.provider}/{latestModel.modelId}</span>}
            {latestThinking && <span className="side-meta-chip">thinking: {latestThinking.thinkingLevel}</span>}
          </div>
        )}
      </div>
      <div className="side-body" ref={boxRef} tabIndex={-1}>
        {resp === null ? (
          <div className="timeline-loading"><span className="spinner" aria-hidden="true" /> Loading session…</div>
        ) : (
          <Timeline events={resp.events ?? []} />
        )}
        <CollapsiblePrompt title="Instructions (task prompt)" text={resp?.task || task || ""} />
      </div>
    </div>
  );
}

/* ---------- fleet picker (custom dropdown) ---------- */
type FpOption = { value: string | null; name: string; status: string };

function FleetPicker({ fleets, value, onChange }: { fleets: FleetInfo[]; value: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    setTimeout(() => searchRef.current?.focus(), 0);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = useMemo(
    () => fleets.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())),
    [fleets, q],
  );
  const options: FpOption[] = useMemo(
    () => [{ value: null, name: "live fleet", status: "live" }, ...filtered.map((f) => ({ value: f.name, name: f.name, status: f.status }))],
    [filtered],
  );
  const current = fleets.find((f) => f.name === value);
  const pick = (v: string | null) => { onChange(v); setOpen(false); setQ(""); triggerRef.current?.focus(); };

  // keep the active option in range and scrolled into view
  useEffect(() => { setActive((a) => Math.min(Math.max(a, 0), Math.max(options.length - 1, 0))); }, [options.length]);
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); if (options[active]) pick(options[active].value); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
  };

  const listId = "fp-listbox";
  return (
    <div className="fp" ref={ref}>
      <button
        ref={triggerRef}
        className="fp-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-expanded={open}
        aria-label={`Fleet: ${current ? `${current.name}, ${current.status}` : "live fleet"}. Change fleet`}
      >
        {current ? <span className="dot" style={{ background: minimapColor(current.status) }} aria-hidden="true" /> : <span className="dot live" aria-hidden="true" />}
        <span className="fp-label">{current ? current.name : "live fleet"}</span>
        {current && <span className="fp-trigger-status">{current.status}</span>}
        <span className="fp-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="fp-menu">
          <input
            ref={searchRef}
            className="fp-search"
            placeholder="filter fleets…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }}
            onKeyDown={onKey}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={`fp-opt-${active}`}
            aria-autocomplete="list"
            aria-label="Filter fleets"
          />
          <div className="fp-list" id={listId} role="listbox" ref={listRef} aria-label="Fleets">
            {options.map((o, i) => (
              <div
                key={o.value ?? "__live"}
                id={`fp-opt-${i}`}
                data-i={i}
                role="option"
                aria-selected={value === o.value}
                className={"fp-item" + (value === o.value ? " selected" : "") + (i === active ? " active" : "")}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                {o.value === null
                  ? <span className="dot live" aria-hidden="true" />
                  : <span className="dot" style={{ background: minimapColor(o.status) }} aria-hidden="true" />}
                <span className="fp-name" title={o.name}>{o.name}</span>
                {o.value !== null && <span className="fp-status">{o.status}</span>}
              </div>
            ))}
            {options.length === 1 && q && <div className="fp-empty">no match</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- theme ---------- */
function currentTheme(): string {
  return document.documentElement.getAttribute("data-theme") || "dark";
}
function applyTheme(t: string) {
  document.documentElement.setAttribute("data-theme", t);
  document.body.className = t;
  try { localStorage.setItem("fleet-canvas-theme", t); } catch { /* ignore */ }
}

/* ---------- flow ---------- */
function Flow() {
  const qs = new URLSearchParams(location.search);
  const [demo, setDemo] = useState(qs.get("demo") === "1");
  const [fleet, setFleet] = useState<string | null>(qs.get("fleet"));
  const [fleets, setFleets] = useState<FleetInfo[]>([]);
  const [payload, setPayload] = useState<CanvasPayload | null>(null);
  const [selected, setSelected] = useState<string | null>(qs.get("node"));
  const [conn, setConn] = useState<string>("");
  const [legendOpen, setLegendOpen] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [demoFallback, setDemoFallback] = useState(false);
  const { fitView } = useReactFlow();
  const resetView = useCallback(() => fitView({ padding: 0.2, duration: 300 }), [fitView]);

  // keyboard: F = fit graph to view, R = reset (same), ignoring typing in inputs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "f" || e.key === "F" || e.key === "r" || e.key === "R") { e.preventDefault(); resetView(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [resetView]);

  useEffect(() => {
    j<{ fleets: FleetInfo[] }>("/api/fleets").then((r) => setFleets(r.fleets)).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    const loadDemo = () => j<CanvasPayload>("/api/demo")
      .then((d) => { if (!alive) return; setConn(""); setPayload(d); setDemoFallback(!demo); })
      .catch(() => { if (!alive) return; setPayload(null); setDemoFallback(false); });
    const tick = () => {
      if (demo) { loadDemo(); return; }
      j<CanvasPayload>("/api/state" + (fleet ? "?fleet=" + encodeURIComponent(fleet) : ""))
        .then((s) => {
          if (!alive) return;
          setConn("");
          // nothing live and no specific past fleet chosen -> show the baked sample fleet
          if (s.empty && !fleet) { loadDemo(); return; }
          setDemoFallback(false);
          setPayload(s.empty ? null : s);
        })
        .catch(() => { if (!alive) return; setConn(fleet ? "fleet unavailable" : "connection lost"); });
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, fleet, nonce]);

  const onOpen = useCallback((id: string) => setSelected(id), []);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<FleetNodeData>>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);
  const idsKey = payload ? payload.nodes.map((n) => n.id).sort().join(",") : "";

  // Rebuild topology only when the node set changes; otherwise patch data in place
  // so drag positions and measured sizes (needed by the minimap) survive polling.
  useEffect(() => {
    if (!payload) { setNodes([]); return; }
    const pos = computePositions(payload.nodes, payload.edges);
    const gateId = payload.loop
      ? (payload.nodes.find((n) => n.id === payload.loop!.gate) ?? payload.nodes.find((n) => n.type === payload.loop!.gate))?.id
      : undefined;
    const hasOutgoing = new Set(payload.edges.map((e) => e.from));
    setNodes((prev) => {
      const byId: Record<string, Node<FleetNodeData>> = {};
      prev.forEach((n) => { byId[n.id] = n; });
      return payload.nodes.map((v) => {
        const existing = byId[v.id];
        const nodeRole: FleetNodeData["nodeRole"] = v.id === gateId ? "gate" : v.depends_on.length === 0 ? "start" : !hasOutgoing.has(v.id) ? "end" : "normal";
        const data: FleetNodeData = { view: v, selected: selected === v.id, demo, gate: v.id === gateId, nodeRole, fleet, onOpen };
        return existing
          ? { ...existing, data }
          : { id: v.id, type: "fleet", position: pos[v.id] ?? { x: 0, y: 0 }, data, width: NODE_W };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, payload, selected, demo, fleet, onOpen, setNodes]);

  useEffect(() => {
    if (!payload) { setEdges([]); return; }
    const forward: Edge[] = payload.edges.map((e, i) => ({
      id: "e" + i,
      source: e.from,
      target: e.to,
      type: "smoothstep",
      pathOptions: { borderRadius: 18 },
      animated: payload.nodes.find((n) => n.id === e.to)?.status === "running",
      style: { strokeWidth: 1.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--edge)" } as Edge["markerEnd"],
    }));

    // feedback loop: the gate node re-triggers the iterate roots each iteration
    const loop = payload.loop;
    const gate = loop
      ? (payload.nodes.find((n) => n.id === loop.gate) ?? payload.nodes.find((n) => n.type === loop.gate))
      : undefined;
    const roots = payload.nodes.filter((n) => n.iterate && n.depends_on.length === 0);
    const looping = payload.status === "running" && !!loop && payload.iteration < loop.max_iterations && payload.lgtm_streak < loop.lgtm_count;
    const loopEdges: Edge[] = gate && loop
      ? roots.map((r, i) => ({
          id: "loop" + i,
          source: gate.id,
          target: r.id,
          sourceHandle: "loop",
          targetHandle: "loopIn",
          type: "smoothstep",
          pathOptions: { borderRadius: 12 },
          animated: looping,
          zIndex: 0,
          label: i === 0 ? `iterate ${payload.iteration}/${loop.max_iterations}` : undefined,
          labelStyle: { fill: "var(--warn)", fontSize: 11, fontWeight: 600 },
          labelBgStyle: { fill: "var(--bg)", fillOpacity: 0.9 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
          style: { stroke: "var(--warn)", strokeDasharray: "5 4", strokeWidth: 1.5, opacity: 0.65 },
          markerEnd: { type: MarkerType.ArrowClosed, color: "var(--warn)" } as Edge["markerEnd"],
        }))
      : [];
    setEdges([...loopEdges, ...forward]);
  }, [payload, setEdges]);

  const done = payload ? payload.nodes.filter((n) => n.status === "completed").length : 0;
  const failed = payload ? payload.nodes.filter((n) => n.status === "failed" || n.status === "contract_failed") : [];
  const running = payload ? payload.nodes.filter((n) => n.status === "running").length : 0;
  const cycleFailed = () => {
    if (!failed.length) return;
    const cur = failed.findIndex((f) => f.id === selected);
    setSelected(failed[(cur + 1) % failed.length].id);
  };

  return (
    <>
      <header>
        <span className="name">fleet canvas</span>
        <FleetPicker
          fleets={fleets}
          value={fleet}
          onChange={(v) => { setFleet(v); setSelected(null); try { localStorage.setItem("fleet-canvas-fleet", v ?? ""); } catch { /* ignore */ } }}
        />
        <span id="hdr">
          {conn ? (
            <span className="conn">
              <span className="pill pill-bad">{conn === "connection lost" ? "Canvas server unreachable" : "Fleet unavailable"}</span>
              <button className="link-btn" onClick={() => { setConn(""); setNonce((n) => n + 1); }}>Retry</button>
            </span>
          ) : payload ? (
            <>
              <span className="fleet-title">{payload.fleet_name}</span>
              {demoFallback
                ? <span className="pill" title="No fleet is live — showing a sample fleet">sample</span>
                : payload.demo && <span className="pill">demo</span>}
              <span className={"pill status-" + payload.status}>{payload.status}</span>
              {payload.paused && <span className="pill">paused</span>}
              {running > 0 && <span className="stat"><span className="dot dot-run" aria-hidden="true" />{running} running</span>}
              <span className="stat">{done}/{payload.nodes.length} done</span>
              {failed.length > 0 && (
                <button
                  className="pill pill-bad pill-btn"
                  onClick={cycleFailed}
                  title={failed.length > 1 ? "Jump to next failed worker" : "Jump to the failed worker"}
                >⚠ {failed.length} failed</button>
              )}
              <span className="stat" title="Estimated spend so far">${payload.cost_usd_estimate.toFixed(2)}</span>
              {payload.loop && (
                <span className="stat" title={`Reviewer-gated loop: re-runs up to ${payload.loop.max_iterations}× until ${payload.loop.lgtm_count} consecutive LGTM verdicts`}>
                  iter {payload.iteration}/{payload.loop.max_iterations} · streak {payload.lgtm_streak}/{payload.loop.lgtm_count}
                </span>
              )}
            </>
          ) : <span className="stat meta">no live fleet</span>}
        </span>
        <span className="spacer" />
        <button onClick={resetView} title="Fit graph to view (F)">reset view</button>
        <button className={legendOpen ? "toggled" : ""} aria-pressed={legendOpen} onClick={() => setLegendOpen((v) => !v)}>legend</button>
        <button aria-pressed={demo} onClick={() => { setDemo((v) => !v); setSelected(null); }}>{demo ? "live" : "demo"}</button>
        <button onClick={() => applyTheme(currentTheme() === "light" ? "dark" : "light")}>theme</button>
      </header>
      <main>
        <div id="stage">
          <ReactFlow
            key={(demo ? "demo" : "live") + ":" + (fleet ?? "") + ":" + (demoFallback ? "s" : "")}
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={2.5}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: "smoothstep", pathOptions: { borderRadius: 18 } }}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => minimapColor((n.data as FleetNodeData).view.status)} />
          </ReactFlow>
          {legendOpen && <Legend hasLoop={!!payload?.loop} onClose={() => setLegendOpen(false)} />}
          {!payload && !conn && !demo && <EmptyState hasFleets={fleets.length > 0} onDemo={() => setDemo(true)} />}
        </div>
        <SidePanel
          fleet={fleet}
          demo={demo || demoFallback}
          selected={selected}
          task={payload?.nodes.find((n) => n.id === selected)?.task ?? null}
          onClose={() => setSelected(null)}
        />
      </main>
    </>
  );
}

/* ---------- legend ---------- */
const LEGEND_ROWS: Array<{ status: string; label: string }> = [
  { status: "running", label: "running" },
  { status: "completed", label: "completed" },
  { status: "failed", label: "failed / contract failed" },
  { status: "blocked", label: "blocked / killed" },
  { status: "pending", label: "pending / ready" },
];
function Legend({ hasLoop, onClose }: { hasLoop: boolean; onClose: () => void }) {
  return (
    <div className="legend" role="region" aria-label="Status legend">
      <div className="legend-head">
        <span>status</span>
        <button className="icon-btn sm" onClick={onClose} aria-label="Close legend" title="Close">×</button>
      </div>
      {LEGEND_ROWS.map((r) => (
        <div className="legend-row" key={r.status}>
          <span className={"swatch " + statusClass(r.status)} aria-hidden="true" />
          <span>{r.label}</span>
        </div>
      ))}
      {hasLoop && (
        <div className="legend-row legend-loop">
          <span className="swatch-line" aria-hidden="true" />
          <span>iteration loop (gate → roots)</span>
        </div>
      )}
    </div>
  );
}

/* ---------- empty state ---------- */
function EmptyState({ hasFleets, onDemo }: { hasFleets: boolean; onDemo: () => void }) {
  return (
    <div className="empty">
      <div className="empty-title">No fleet running</div>
      <p className="empty-body">
        This canvas shows a live DAG of agent workers — status, tokens, cost, and reviewer-gated iteration loops — as a fleet runs.
      </p>
      <ul className="empty-steps">
        <li>Start a fleet from pi with <code>/fleet</code>, then it appears here automatically.</li>
        {hasFleets
          ? <li>Or open a past run from the <strong>fleet selector</strong> at the top left.</li>
          : <li>Past runs will be listed in the <strong>fleet selector</strong> once you have some.</li>}
      </ul>
      <button className="empty-cta" onClick={onDemo}>Explore a demo fleet</button>
    </div>
  );
}

/* ---------- boot ---------- */
(function initTheme() {
  const qs = new URLSearchParams(location.search);
  let t = qs.get("theme");
  if (t !== "light" && t !== "dark") {
    try { t = localStorage.getItem("fleet-canvas-theme"); } catch { /* ignore */ }
    if (t !== "light" && t !== "dark" && window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches) t = "light";
  }
  applyTheme(t === "light" || t === "dark" ? t : "dark");
})();

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  </StrictMode>,
);
