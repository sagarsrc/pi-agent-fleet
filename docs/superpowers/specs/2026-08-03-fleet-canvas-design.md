# Fleet Browser Canvas (Design)

Date: 2026-08-03
Source: `todo.md` item #5 (browser-based live status + peek into agents; minimal terminal status). Last open item.

## Goal

A local, read-only web canvas for the active fleet: live DAG with per-node stats, and a click-to-peek view of any node's recent agent session messages. Terminal widget stays as the minimal indicator.

## Architecture

### `src/canvas.ts` (new)

- `startCanvasServer({ getFleet, port?, host? }) → { url, port, close() }` — `node:http`, binds `127.0.0.1`, port `0` (ephemeral) by default. No dependencies.
- Routes:
  - `GET /` → embedded single-page HTML (inline CSS/JS, polls every 1.5s).
  - `GET /api/state` → `buildCanvasPayload(fleet)` JSON, or `{ "empty": true }` when no fleet.
  - `GET /api/session/<nodeId>?tail=N` → last N (default 30, max 200) readable session entries for that node; 404 for unknown ids.
- `buildCanvasPayload(fleet)` — pure: fleet meta, loop config, per-node `{ id, type, status, model, effort, turns, tokens, cost_usd_estimate, status_note, produced_outputs }`, edges, `generated_at`.
- `parseSessionTail(jsonl, max)` — pure: keeps `{"type":"message"}` entries; maps content parts to text (`toolCall` → `[tool: name]`, `toolResult` → `[tool result]`); skips unparseable lines; caps each entry at 4000 chars; returns the last `max`.
- Session file discovery: newest `*.jsonl` inside `workers/<id>/` (lexical sort of timestamped names).
- `openInBrowser(url, runner?)` — `open` (darwin) / `xdg-open` (linux) / `start` (win32) via `execFile`; injectable runner for tests; failures are swallowed (URL is always shown).
- Page: header (name, status, iteration/verdict/streak, cost), DAG rendered in topo layers (client-side from edges), node cards colored by status with `N turns · Xk tok · $Y` + note; click a card → side panel polls `/api/session/<id>` every 2s showing role-tagged messages (peek). Dark theme, no external assets.

### Wiring

- `src/controller.ts`: canvas singleton — `ensureCanvas()` (server bound to the `activeFleet` cell getter), `stopCanvas()`.
- `src/index.ts`: `session_start` stops the canvas (fleet cell resets anyway).
- `/fleet canvas` — open (default) / `stop`; works without an active fleet (page shows "no fleet"), so it sits before the `!active` guard.
- Tool `fleet_canvas` `{ action?: "open" | "stop" | "url" }` (default `url`).

## Data flow

Browser ← polling ← canvas server ← `activeFleet` cell (in-memory spec/state) + session `.jsonl` files on disk. Read-only; canvas never mutates fleet state.

## Error handling

- No fleet → `{empty:true}` → page shows placeholder.
- Missing session file → `{entries:[]}`.
- Server bind failure → error message from command/tool; fleet unaffected.
- Browser open failure → swallowed; URL printed.

## Testing

- `parseSessionTail` (roles, tool markers, caps, bad lines), `buildCanvasPayload`, page contains `/api/state`.
- Live server on ephemeral port: `/`, `/api/state` (fleet + empty), `/api/session/<id>` (entries + 404).
- `openInBrowser` with injected runner (platform command mapping).

## Out of scope

Auth/multi-user (localhost-only by design), websockets (polling is fine), editing from the browser.
