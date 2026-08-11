import { defineRageKitElement, RageKitElement, TAG_NAME } from "ragekit/element";
import { hammer } from "ragekit/tools";

defineRageKitElement();
defineRageKitElement("page-destroyer");

const element = new RageKitElement();
element.configure({
  tools: [hammer],
  captureContent: false,
  strings: { close: "Close it" },
});
element.addEventListener("ragekit-close", () => {});
void element.destroyerEngine;
void TAG_NAME;
