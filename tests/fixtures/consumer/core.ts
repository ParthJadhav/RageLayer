import { createRageKit, type MountRageKitOptions, mountRageKit, type Tool } from "ragekit";

const customTool = {
  id: "consumer-stamp",
  name: "Consumer stamp",
  icon: "X",
  hint: "click",
  onDown(engine, event) {
    engine.shake(event.x > 0 ? 2 : 1);
  },
} satisfies Tool;

const options = {
  tools: [customTool],
  initialTool: customTool.id,
  captureContent: false,
  quality: "balanced",
  effectsPixelRatio: 1.25,
  loadout: "precision",
} satisfies MountRageKitOptions;

const controller = createRageKit(options);
const unsubscribe = controller.subscribe((engine) => engine?.setTool(customTool.id));
const mounted = mountRageKit(options);

void controller.isOpen;
void mounted;
unsubscribe();
