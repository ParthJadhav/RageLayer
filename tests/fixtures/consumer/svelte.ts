import {
  createRageKit,
  type RageKitActionOptions,
  type RageKitActionReturn,
  rageKit,
} from "ragekit/svelte";

const options = {
  initialTool: "rocket",
  toggle: true,
  captureContent: false,
} satisfies RageKitActionOptions;

declare const button: HTMLButtonElement;
const action: RageKitActionReturn = rageKit(button, options);
const controller = createRageKit(options);
button.addEventListener("ragekitchange", (event) => event.detail.engine?.clear());

void action.update;
void action.destroy;
void controller.toggle;
