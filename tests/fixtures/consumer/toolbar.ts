import { DestroyerEngine } from "ragekit/engine";
import { DEFAULT_STRINGS, resolveStrings, ToolbarModel, type ToolbarState } from "ragekit/toolbar";
import { baseTools } from "ragekit/tools";

const engine = new DestroyerEngine({ captureContent: false });
engine.registerTools(baseTools);

const model = new ToolbarModel(engine, {
  tools: baseTools,
  strings: { ...DEFAULT_STRINGS, close: "Dismiss" },
  onClose: () => {},
});

const unsubscribe = model.subscribe((state: ToolbarState) => {
  void state.buttons.map((button) => button.label);
  void state.status?.label;
  void state.aim;
});

model.startAiming();
model.moveAim(1, 0);
void model.strikeAtAim();
unsubscribe();
model.destroy();
void resolveStrings({ repair: "Fix" });
