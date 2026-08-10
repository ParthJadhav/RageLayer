import {
  createDesktopDestroyer,
  type DesktopDestroyerActionOptions,
  type DesktopDestroyerActionReturn,
  desktopDestroyer,
} from "desktop-destroyer/svelte";

const options = {
  initialTool: "rocket",
  toggle: true,
  captureContent: false,
} satisfies DesktopDestroyerActionOptions;

declare const button: HTMLButtonElement;
const action: DesktopDestroyerActionReturn = desktopDestroyer(button, options);
const controller = createDesktopDestroyer(options);
button.addEventListener("desktopdestroyerchange", (event) => event.detail.engine?.clear());

void action.update;
void action.destroy;
void controller.toggle;
