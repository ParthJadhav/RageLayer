import {
  DesktopDestroyerElement,
  defineDesktopDestroyerElement,
  TAG_NAME,
} from "desktop-destroyer/element";
import { hammer } from "desktop-destroyer/tools";

defineDesktopDestroyerElement();
defineDesktopDestroyerElement("page-destroyer");

const element = new DesktopDestroyerElement();
element.configure({
  tools: [hammer],
  captureContent: false,
  strings: { close: "Close it" },
});
element.addEventListener("dd-close", () => {});
void element.destroyerEngine;
void TAG_NAME;
