import {
  createRageLayer,
  type RageLayerActionOptions,
  type RageLayerActionReturn,
  rageLayer,
} from "ragelayer/svelte";

const options = {
  initialTool: "rocket",
  toggle: true,
  captureContent: false,
} satisfies RageLayerActionOptions;

declare const button: HTMLButtonElement;
const action: RageLayerActionReturn = rageLayer(button, options);
const controller = createRageLayer(options);
button.addEventListener("ragelayerchange", (event) => event.detail.engine?.clear());

void action.update;
void action.destroy;
void controller.toggle;
