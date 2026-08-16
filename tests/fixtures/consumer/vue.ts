import { useRageLayer } from "ragelayer/vue";

const rageLayer = useRageLayer({
  initialTool: "water",
  captureContent: false,
});

const open: boolean = rageLayer.isOpen.value;
rageLayer.engine.value?.setTool("broom");

void open;
void rageLayer.open;
void rageLayer.close;
void rageLayer.toggle;

// The ready-made Vue toolbar, so its props and events stay type-checked from
// a consumer's perspective rather than only from inside the package.
import { RageLayer } from "ragelayer/vue";
import { h } from "vue";

void h(RageLayer, {
  soundDefault: false,
  strings: { toolbarLabel: "Outils", close: "Fermer" },
  engineOptions: { captureContent: false, history: true },
  onClose: () => {},
});
