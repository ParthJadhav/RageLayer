import { defineRageLayerElement, RageLayerElement, TAG_NAME } from "ragelayer/element";
import { hammer } from "ragelayer/tools";

defineRageLayerElement();
defineRageLayerElement("page-rage-layer");

const element = new RageLayerElement();
element.configure({
  tools: [hammer],
  captureContent: false,
  strings: { close: "Close it" },
});
element.addEventListener("ragelayer-close", () => {});
void element.rageLayerEngine;
void TAG_NAME;
