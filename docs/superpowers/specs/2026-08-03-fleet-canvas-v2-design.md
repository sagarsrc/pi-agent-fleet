# Fleet Canvas v2 — Infinite Canvas, Rich Graph, Disk Fleets (Design)

Date: 2026-08-03
Source: user feedback — the canvas uses a fraction of `fleet.json`; needs infinite-canvas navigation, light+dark themes, and re-visualization of completed fleets.

## Goal

Canvas v2: the full fleet structure on an infinite canvas — pan/zoom/fit, rich node cards (type, task, outputs, flags), dependency wires, light and dark themes, and a fleet picker that can visualize ANY fleet root on disk (`.fleet/*`), not just the live one.

## Architecture

### Rich payload + disk fleets (`src/canvas.ts`, Task 1)

- `buildCanvasPayload` enriched per node: `type`, `task`, `outputs` (path/kind/required), `depends_on`, `iterate`, `worktree`. Fleet-level: `config { max_concurrent, model?, effort?, warn_cost_usd? }`, `iterations: [{ n, verdict, cost, tokens, duration_ms }]`.
- `readDiskFleet(fleetRoot)`: parse `fleet.json` + `state.json` → `ActiveFleet`-shaped object (inert switches) → existing payload/session code works unchanged.
- `listFleetRoots(cwd)`: scan `<cwd>/.fleet/*/fleet.json` → `[{ name, root, status, created_at }]` (name = dir basename), newest first.
- Routes (`startCanvasServer` gains `cwd` opt):
  - `/api/fleets` → `{ fleets: [...] }` from disk scan.
  - `/api/state?fleet=<name>` → no param (or name matches live active fleet's dir basename) → live payload; otherwise disk payload via `readDiskFleet`. Unknown name → 404.
  - `/api/session/<id>?fleet=<name>` → same resolution for session tails.
- Read-only everywhere; disk reads per poll are small files.

### Page v2 (`renderCanvasPage`, Task 2)

- **Infinite canvas** (standard camera pattern): `camera { x, y, scale }` clamped 0.2–2.5; one `#viewport` div with `transform: translate(x,y) scale(z)`; wheel = cursor-anchored zoom (`zoomAt` formula); drag on background = pan; buttons: Fit (bounding box of all nodes), 1:1. Node positions from a client-side layered layout (x = layer × 340, y = index × 150) → wires computed in layout coordinates inside the same transformed viewport (no DOM measuring hacks).
- **Rich cards**: id, type badge, status pill, model + effort, turns/tokens/cost, output chips (`path · kind`), flags (`once` when iterate:false, `worktree`), status note. Click → side panel: full task text, outputs, produced outputs, then session tail (existing).
- **Themes**: CSS variables with `body.light` override set; header toggle; default from `prefers-color-scheme`; persisted in `localStorage`.
- **Fleet picker**: header `<select>` populated from `/api/fleets`; "live" entry = active fleet; selection drives the `?fleet=` param on polls; preselected from URL `?fleet=`; persisted in `localStorage`. Existing `?node=` deep-link preserved.
- Preserved behaviors: paused pill, connection-lost indicator, esc() hardening, scroll preservation, 1.5s/2s polls, no backticks in page JS.

### Command/tool (`src/command.ts`, `src/tools.ts`, Task 2)

- `/fleet canvas [name]` — open browser at `url?fleet=<name>` when given (validated against disk list; error if unknown), else live.
- `fleet_canvas` tool gains optional `fleet` param (dir basename); returned URL carries `?fleet=`.

## Data flow

- Live: browser polls `/api/state` → activeFleet cell (unchanged).
- Disk: browser polls `/api/state?fleet=X` → `readDiskFleet(.fleet/X)` fresh per poll → payload (works for completed/failed/killed fleets and sessions on disk).
- Navigation is pure client state (camera); data refresh re-renders nodes in place, camera untouched.

## Error handling

- Unknown `?fleet=` → 404 JSON; page shows "fleet not found" and falls back to live.
- Corrupt/missing state.json in a root → that root listed with status `unknown`, payload 404.
- Empty `.fleet/` → picker shows "live" only.

## Testing

- `readDiskFleet` round-trip (spec+state from a real planned fleet fixture), missing/corrupt files.
- `listFleetRoots` ordering and filtering (design-* dirs without state.json handled).
- Payload: type/task/outputs/flags/config/iterations present.
- Server: `/api/fleets`, `?fleet=` live + disk + 404, session with fleet param.
- Page markers: `zoomAt`, `fitView`, `fleetSel`, `light`, `outputs` chip class.

## Out of scope

Minimap, edge routing around nodes, node drag-repositioning, editing from canvas.
