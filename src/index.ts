import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFleetCommand } from "./command.js";
import { activeFleet, stopCanvas } from "./controller.js";
import { registerFleetTools } from "./tools.js";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    activeFleet.current = undefined;
    void stopCanvas();
    ctx.ui.setStatus("fleet", "");
  });
  registerFleetTools(pi);
  registerFleetCommand(pi);
}
