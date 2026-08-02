import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeFleet, currentState, killFleet, prepareRelaunch, startLoop, updateWidget } from "./controller.js";
import { resolveModelReference } from "./model-resolution.js";
import { clearPreference, loadPreferences, PREFERENCE_KEYS, savePreferences, setPreference } from "./preferences.js";
import { resetForRelaunch, writeState } from "./state.js";
import { buildWidgetLines } from "./ui.js";
import { renderDag } from "./viz.js";

export function registerFleetCommand(pi: ExtensionAPI): void {
  pi.registerCommand("fleet", {
    description: "Fleet commands: /fleet viz, /fleet status, /fleet configure [show|set k v], /fleet clear, /fleet kill all|<node_id>, /fleet pause, /fleet resume, /fleet relaunch <node_id> [model]",
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
          const r = setPreference(prefs, key, value);
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
          const next = input.trim().length === 0
            ? clearPreference(prefs, key)
            : (() => {
                const r = setPreference(prefs, key, input.trim());
                if (!r.ok) return undefined;
                return r.prefs;
              })();
          if (next === undefined) {
            ctx.ui.notify(`invalid value for ${key}`, "error");
            continue;
          }
          await savePreferences(next);
        }
        ctx.ui.notify("preferences saved", "info");
        return;
      }
      const active = activeFleet.current;
      if (!active) {
        ctx.ui.notify("no fleet planned yet", "warning");
        return;
      }
      if (cmd === "viz") {
        const lines = renderDag(active.spec, active.state).split("\n");
        ctx.ui.setWidget("fleet", lines);
        return;
      }
      if (cmd === "status" || cmd === "") {
        ctx.ui.setWidget("fleet", buildWidgetLines(active.spec, active.state));
        return;
      }
      if (cmd === "clear") {
        ctx.ui.setWidget("fleet", []);
        return;
      }
      if (cmd === "kill") {
        const text = await killFleet(target ?? "");
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
      if (cmd === "relaunch") {
        if (!target) {
          ctx.ui.notify("usage: /fleet relaunch <node_id> [model]", "warning");
          return;
        }
        if (active.running) {
          ctx.ui.notify("fleet is running", "warning");
          return;
        }
        await currentState(active);
        if (active.state.status === "completed") {
          ctx.ui.notify("fleet completed, nothing to relaunch", "warning");
          return;
        }
        const worker = active.spec.workers.find((w) => w.id === target);
        if (!worker) {
          ctx.ui.notify(`unknown node "${target}"`, "warning");
          return;
        }
        const node = active.state.nodes[target];
        const relaunchable: ReadonlySet<string> = new Set(["failed", "contract_failed", "killed"]);
        if (!node || !relaunchable.has(node.status)) {
          ctx.ui.notify(`node "${target}" status ${node?.status ?? "missing"} cannot be relaunched; must be failed, contract_failed, or killed`, "warning");
          return;
        }
        const model = args.trim().split(/\s+/).slice(2).join(" ") || undefined;
        if (model) {
          const resolved = resolveModelReference(ctx.modelRegistry, model);
          if (!resolved.ok) {
            ctx.ui.notify(resolved.error, "error");
            return;
          }
          const canonical = `${resolved.model.provider}/${resolved.model.id}`;
          active.spec.workers = active.spec.workers.map((w) => w.id === target ? { ...w, model: canonical } : w);
          await writeFile(join(active.fleetRoot, "fleet.json"), `${JSON.stringify(active.spec, null, 2)}\n`, "utf-8");
        }
        active.state = resetForRelaunch(active.state, active.spec, target);
        await writeState(active.fleetRoot, active.state);
        prepareRelaunch(active, target);
        void startLoop(active, ctx, false, true);
        ctx.ui.notify(`fleet relaunch requested for ${target}`, "info");
        return;
      }
      ctx.ui.notify("usage: /fleet viz | /fleet status | /fleet configure [show|set k v] | /fleet clear | /fleet kill all|<node_id> | /fleet pause | /fleet resume | /fleet relaunch <node_id> [model]", "warning");
    },
  });
}
