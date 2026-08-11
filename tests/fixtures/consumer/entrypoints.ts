import { DestroyerEngine, type DestroyerOptions, type Tool } from "ragekit/engine";
import { loadAdvancedTools, loadBaseTools, loadDefaultTools, loadHeavyTools } from "ragekit/lazy";
import { BUILT_IN_LOADOUTS, resolveToolLoadout } from "ragekit/loadouts";
import { createRateLimiter, createTool } from "ragekit/sdk";
import { baseTools, broom, hammer } from "ragekit/tools";
import { advancedTools, gravityGun, laserCutter } from "ragekit/tools/advanced";
import { blackHole, heavyTools, rocketLauncher } from "ragekit/tools/heavy";

const options = {
  captureContent: false,
  pauseWhenHidden: true,
  toolScale: 1.25,
  history: { maxEntries: 3, maxPixels: 8_000_000 },
} satisfies DestroyerOptions;

const selected: Tool[] = [hammer, broom, blackHole, rocketLauncher];
const engine = new DestroyerEngine(options);
engine.registerTools(selected);
engine.unregisterTool("blackhole");
engine.pause();
engine.resume();
void engine.paused;
void baseTools;
void heavyTools;
void advancedTools;
void gravityGun;
void laserCutter;
void BUILT_IN_LOADOUTS.chaos;
void resolveToolLoadout("precision");
void selected;
void createRateLimiter(20);
void createTool({
  id: "fixture",
  name: "Fixture",
  icon: "F",
  hint: "fixture",
  createState: () => ({ hits: 0 }),
  onDown(state, api, event) {
    state.hits++;
    api.signalInteraction("impact", event.x, event.y);
  },
});
void Promise.all([loadBaseTools(), loadHeavyTools(), loadAdvancedTools(), loadDefaultTools()]);
