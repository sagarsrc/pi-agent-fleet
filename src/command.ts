import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeFleet, currentState, ensureCanvas, killFleet, requestRelaunch, startLoop, statusText, stopCanvas, updateWidget } from "./controller.js";
import { writeWorkerPrompts } from "./fleet-store.js";
import { openInBrowser, listFleetRoots } from "./canvas.js";
import { insertWorkers } from "./insert.js";
import { editConfig, editNode, type ConfigEditKey, type NodeEditKey } from "./edits.js";
import { listModelRefs } from "./model-resolution.js";
import { clearPreference, loadPreferences, PREFERENCE_KEYS, savePreferences, setPreference } from "./preferences.js";
import { recoverLatestFleet } from "./fleet-recovery.js";
import { writeState } from "./state.js";
import { buildWidgetLines } from "./ui.js";
import { renderDag } from "./viz.js";

export function registerFleetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("fleet", {
    description: "Fleet commands: /fleet viz, /fleet status, /fleet models, /fleet canvas [stop], /fleet configure [show|set k v], /fleet add <json>, /fleet edit <node_id>|config ..., /fleet clear, /fleet kill all|<node_id>, /fleet pause, /fleet resume, /fleet continue, /fleet relaunch <node_id> [model]",
    handler: async (args, ctx) => {
      const [cmd, target] = args.trim().split(/\s+/);
      if (cmd === "configure") {
        const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
        const sub = parts[1];
        if (sub === "show") {
          const prefs = await loadPreferences();
          ctx.ui.notify(JSON.stringify(prefs, null, 2), "info");
          return;
        }
        if (sub === "set") {
          const key = parts[2];
          const value = parts.slice(3).join(" ");
          if (!key || !value) {
            ctx.ui.notify("usage: /fleet configure set <key> <value>", "warning");
            return;
          }
          const prefs = await loadPreferences();
          const r = setPreference(prefs, key, value, ctx.modelRegistry);
          if (!r.ok) {
            ctx.ui.notify(r.error, "error");
            return;
          }
          await savePreferences(r.prefs);
          ctx.ui.notify(`preference ${key} saved`, "info");
          return;
        }
        // interactive wizard
        while (true) {
          const prefs = await loadPreferences();
          const options = PREFERENCE_KEYS.map((k) => `${k}: ${prefs[k] ?? "—"}`);
          const field = await ctx.ui.select("Fleet preferences (empty input clears a field):", [...options, "done"]);
          if (!field || field === "done") break;
          const key = field.split(":")[0] as (typeof PREFERENCE_KEYS)[number];
          const input = await ctx.ui.input(`${key} (current: ${prefs[key] ?? "—"}):`, "empty clears");
          if (input === undefined) break;
          let err: string | undefined;
          const next = input.trim().length === 0
            ? clearPreference(prefs, key)
            : (() => {
                const r = setPreference(prefs, key, input.trim(), ctx.modelRegistry);
                if (!r.ok) {
                  err = r.error;
                  return undefined;
                }
                return r.prefs;
              })();
          if (next === undefined) {
            ctx.ui.notify(err ?? `invalid value for ${key}`, "error");
            continue;
          }
          await savePreferences(next);
        }
        ctx.ui.notify("preferences saved", "info");
        return;
      }
      if (cmd === "canvas") {
        const sub = args.trim().split(/\s+/)[1];
        if (sub === "stop") {
          await stopCanvas();
          ctx.ui.notify("fleet canvas stopped", "info");
          return;
        }
        const server = await ensureCanvas(ctx);
        let url = server.url;
        if (sub) {
          const roots = await listFleetRoots(ctx.cwd);
          if (!roots.some((r) => r.name === sub)) {
            ctx.ui.notify(`unknown fleet "${sub}" (see /api/fleets on the canvas server)`, "error");
            return;
          }
          url = `${url}?fleet=${encodeURIComponent(sub)}`;
        }
        await openInBrowser(url);
        ctx.ui.notify(`fleet canvas: ${url}`, "info");
        return;
      }
      if (cmd === "models") {
        ctx.ui.notify(`available models:\n${listModelRefs(ctx.modelRegistry).join("\n")}`, "info");
        return;
      }
      const active = activeFleet.current ?? await recoverLatestFleet(ctx.cwd);
      if (active) activeFleet.current ??= active;
      if (!active) {
        ctx.ui.notify("no fleet planned yet", "warning");
        return;
      }
      if (cmd === "viz") {
        active.widgetVisible = true;
        const lines = renderDag(active.spec, active.state).split("\n");
        ctx.ui.setWidget("fleet", lines);
        ctx.ui.notify("fleet widget visible; fleet canvas link: " + (await ensureCanvas(ctx)).url, "info");
        return;
      }
      if (cmd === "status" || cmd === "") {
        const server = await ensureCanvas(ctx);
        ctx.ui.notify(`${await statusText(active)}\n\nfleet canvas: ${server.url}`, "info");
        return;
      }
      if (cmd === "clear") {
        active.widgetVisible = false;
        ctx.ui.setWidget("fleet", []);
        ctx.ui.notify("fleet widget hidden", "info");
        return;
      }
      if (cmd === "kill") {
        const text = await killFleet(target ?? "", ctx.cwd);
        const severity = text.includes("kill") && !text.startsWith("unknown") && !text.includes("already") ? "warning" : "error";
        ctx.ui.notify(text, severity);
        return;
      }
      if (cmd === "pause") {
        if (!active.spec.config.loop) {
          ctx.ui.notify("fleet has no loop; pause is a loop-fleet operation", "warning");
          return;
        }
        if (!active.running) {
          ctx.ui.notify("fleet not running", "warning");
          return;
        }
        active.pauseSwitch.paused = true;
        active.state = { ...active.state, paused: true };
        await writeState(active.fleetRoot, active.state);
        updateWidget(ctx, active);
        ctx.ui.notify("pause requested (takes effect at next iteration boundary)", "warning");
        return;
      }
      if (cmd === "resume") {
        if (active.state.status !== "paused") {
          ctx.ui.notify("fleet is not paused", "warning");
          return;
        }
        if (active.running) {
          ctx.ui.notify("fleet already running", "warning");
          return;
        }
        active.pauseSwitch.paused = false;
        void startLoop(active, ctx, true);
        ctx.ui.notify("fleet resumed", "info");
        return;
      }
      if (cmd === "continue") {
        if (active.running) {
          ctx.ui.notify("fleet already running", "warning");
          return;
        }
        await currentState(active);
        if (active.state.status === "completed") {
          ctx.ui.notify("fleet completed, nothing to continue", "warning");
          return;
        }
        if (active.state.status === "paused") {
          ctx.ui.notify("fleet is paused; use /fleet resume for paused loop fleets", "warning");
          return;
        }
        if (active.state.status === "planned" && Object.values(active.state.nodes).every((n) => n.status === "pending")) {
          ctx.ui.notify("fleet has not started; use /fleet launch", "warning");
          return;
        }
        active.killSwitch.killed = false;
        active.pauseSwitch.paused = false;
        active.state = { ...active.state, status: "running", paused: false };
        await writeState(active.fleetRoot, active.state);
        await writeWorkerPrompts(active);
        void startLoop(active, ctx, false, true);
        ctx.ui.notify("fleet continue requested", "info");
        return;
      }
      if (cmd === "relaunch") {
        if (!target) {
          ctx.ui.notify("usage: /fleet relaunch <node_id> [model]", "warning");
          return;
        }
        await currentState(active);
        if (active.state.status === "completed") {
          ctx.ui.notify("fleet completed, nothing to relaunch", "warning");
          return;
        }
        const model = args.trim().split(/\s+/).slice(2).join(" ") || undefined;
        const result = await requestRelaunch(active, target, model, ctx.modelRegistry);
        if (result.startNow) void startLoop(active, ctx, false, true);
        ctx.ui.notify(result.message, result.startNow ? "info" : result.message.startsWith("relaunch queued") ? "info" : "warning");
        return;
      }
      if (cmd === "add") {
        const body = args.trim().replace(/^add\s*/, "");
        if (!body) {
          ctx.ui.notify("usage: /fleet add <json>", "warning");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          ctx.ui.notify(`invalid JSON: ${(e as Error).message}`, "error");
          return;
        }
        await currentState(active);
        const r = await insertWorkers(active, parsed, ctx.modelRegistry);
        ctx.ui.notify(r.message, r.ok ? "info" : "error");
        if (r.ok) updateWidget(ctx, active);
        return;
      }
      if (cmd === "edit") {
        const parts = args.trim().split(/\s+/).filter((s) => s.length > 0);
        const target = parts[1];
        const key = parts[2];
        let value = parts.slice(3).join(" ");
        if (!target || !key) {
          ctx.ui.notify("usage: /fleet edit <node_id> model|effort <value> | /fleet edit <node_id> task [text] | /fleet edit config <key> <value>", "warning");
          return;
        }
        await currentState(active);
        if (target === "config") {
          if (!value) {
            ctx.ui.notify("usage: /fleet edit config max_concurrent|warn_cost_usd|model|effort <value>", "warning");
            return;
          }
          const r = await editConfig(active, key as ConfigEditKey, value, ctx.modelRegistry);
          ctx.ui.notify(r.message, r.ok ? "info" : "error");
          if (r.ok) updateWidget(ctx, active);
          return;
        }
        if (key === "task" && !value) {
          const current = active.spec.workers.find((w) => w.id === target)?.task ?? "";
          const edited = await ctx.ui.editor(`task for ${target}:`, current);
          if (edited === undefined) {
            ctx.ui.notify("edit cancelled", "warning");
            return;
          }
          value = edited;
        }
        if (!value) {
          ctx.ui.notify("usage: /fleet edit <node_id> model|effort <value> | /fleet edit <node_id> task [text]", "warning");
          return;
        }
        const r = await editNode(active, target, key as NodeEditKey, value, ctx.modelRegistry);
        ctx.ui.notify(r.message, r.ok ? "info" : "error");
        if (r.ok) updateWidget(ctx, active);
        return;
      }
      ctx.ui.notify("usage: /fleet viz | /fleet status | /fleet models | /fleet canvas [stop] | /fleet configure [show|set k v] | /fleet add <json> | /fleet edit <node_id>|config ... | /fleet clear | /fleet kill all|<node_id> | /fleet pause | /fleet resume | /fleet continue | /fleet relaunch <node_id> [model]", "warning");
    },
  });
}
