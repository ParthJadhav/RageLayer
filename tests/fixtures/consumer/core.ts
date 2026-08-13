import { createRageLayer, type MountRageLayerOptions, mountRageLayer, type Tool } from "ragelayer";

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
} satisfies MountRageLayerOptions;

const controller = createRageLayer(options);
const unsubscribe = controller.subscribe((engine) => engine?.setTool(customTool.id));
const mounted = mountRageLayer(options);

void controller.isOpen;
void mounted;
unsubscribe();
