import { useRageKit } from "ragekit/vue";

const destroyer = useRageKit({
  initialTool: "freeze",
  captureContent: false,
});

const open: boolean = destroyer.isOpen.value;
destroyer.engine.value?.setTool("broom");

void open;
void destroyer.open;
void destroyer.close;
void destroyer.toggle;

// The ready-made Vue toolbar, so its props and events stay type-checked from
// a consumer's perspective rather than only from inside the package.
import { RageKit } from "ragekit/vue";
import { h } from "vue";

void h(RageKit, {
  loadout: "chaos",
  soundDefault: false,
  strings: { toolbarLabel: "Outils", close: "Fermer" },
  engineOptions: { captureContent: false, history: true },
  onClose: () => {},
});
