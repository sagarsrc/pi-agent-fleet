# Fleet todo — ALL DONE (4 plans, SDD+TDD, 208 tests green)

1. ✅ effort: `effort` on config + worker (`off|minimal|low|medium|high|xhigh|max`), default medium, threaded to createAgentSession thinkingLevel
2. ✅ confirm flow: fleet_plan result + tool descriptions require explicit user confirm before fleet_launch; skip_confirm only for pre-approved
3. ✅ widget: truncates at 12 lines with `… +N more` overflow, animated spinner (150ms ticker), `lgtm streak` label
4. ✅ `/fleet configure` (wizard/show/set) — prefs at ~/.pi/agent/fleet.json (max_concurrent, model, effort, warn_cost_usd), merged into fleet_plan
5. ✅ browser canvas: `/fleet canvas` / fleet_canvas tool — loopback server, live DAG, click node → peek session tail; terminal widget stays minimal
6. ✅ dynamic nodes: workers write output/node-requests.json → validated insert mid-run; `fleet_add_node` tool; `/fleet add <json>`
7. ✅ planning: `fleet_design` tool — planner agent drafts fleet DAG from requirements, validates, previews; then fleet_plan
8. ✅ single-node kill: `/fleet kill <node_id>` / fleet_kill node — aborts session, `killed` status (independent of spawn outcome), dependents blocked, relaunch revives
9. ✅ modules: index.ts (600→17 lines) split into model-resolution, fleet-store, controller, tools, command (+ edits, insert, planner, preferences, canvas)
10. ✅ `/fleet edit` + fleet_edit tool: pending-node model/effort/task (prompt.md regenerated atomically), config max_concurrent/warn_cost_usd/model/effort — live mid-run
11. ✅ dynamic: #6 + #8 + #10 combined = runtime-mutable DAG
12. ✅ completed nodes keep stats (turns · tok · $cost) in widget; final render stays visible after fleet ends
13. ✅ de-biased: no gpt-5.4 default (session default used), provider-neutral tool descriptions, tier-based guidance
14. ✅ resilience: all model refs validated at plan AND launch (fail fast); session factory throws contained per node

## Later (parked minors from reviews)
- noUnusedLocals in tsconfig; atomic writeJsonAtomic shared helper; planner cost guardrails; growth cap (max_workers) for recursive node requests; sideband rename-after-consume for loop fleets

## Issue fixes (gh #1 #2) — branch fix/gh-issues-1-2
1. ✅ autonomy preamble in worker prompts (bug 1)
2. ✅ relaunch queued into running scheduler + wind-down drain (bug 2)
3. ✅ blocked nodes editable + killable (bug 3)
4. ✅ file-exists freshness for repo-relative paths (bug 4)
5. ✅ unknown-pricing zero-cost status note (bug 5)
6. ✅ canvas TD layered layout (item 2)
7. ✅ canvas copyable errors + tucked instructions + dense cards (items 1,3,4)
8. ✅ live smoke: headless mini fleet, relaunch-while-running + blocked-edit green
9. ✅ readDiskFleet bare-root fallback (ENOENT-only) carried from WIP
