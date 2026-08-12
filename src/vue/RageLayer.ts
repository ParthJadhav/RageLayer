/**
 * The Vue counterpart to the React component: a real, ready-made toolbar
 * rather than a headless composable the host has to build a UI around.
 *
 * Written as a render function rather than an SFC so the package needs no
 * Vue compiler in its build, and so Vue stays an optional peer dependency
 * that only this entry point imports.
 */

import {
  computed,
  defineComponent,
  h,
  onBeforeUnmount,
  onMounted,
  type PropType,
  ref,
  shallowRef,
  Teleport,
  type VNode,
} from "vue";

import { RAGELAYER_IGNORE_ATTR } from "../capture";
import { defaultTools } from "../default-tools";
import { DestroyerEngine } from "../engine";
import { type BuiltInLoadoutId, resolveToolLoadout, type ToolLoadout } from "../loadouts";
import type { DestroyerStrings } from "../strings";
import { type ToolbarButton, ToolbarModel, type ToolbarState } from "../toolbar";
import type { DestroyerOptions, Tool } from "../types";
import { acquireToolbarStyles, BAR_CLASS, releaseToolbarStyles } from "./styles";

export const RageLayer = defineComponent({
  name: "RageLayer",
  props: {
    tools: { type: Array as PropType<readonly Tool[]>, default: undefined },
    loadout: {
      type: [String, Object] as PropType<BuiltInLoadoutId | ToolLoadout>,
      default: undefined,
    },
    engineOptions: { type: Object as PropType<DestroyerOptions>, default: undefined },
    strings: { type: Object as PropType<Partial<DestroyerStrings>>, default: undefined },
    soundDefault: { type: Boolean, default: false },
  },
  emits: ["close", "ready"],
  setup(props, { emit }) {
    const engine = shallowRef<DestroyerEngine | null>(null);
    const model = shallowRef<ToolbarModel | null>(null);
    const state = ref<ToolbarState | null>(null);
    // SSR guard: nothing renders until the component is mounted in a browser,
    // so importing and rendering this on a server is safe.
    const mounted = ref(false);
    const bar = ref<HTMLElement | null>(null);
    let unsubscribe: (() => void) | null = null;
    let previousFocus: HTMLElement | null = null;

    const toolset = computed<readonly Tool[]>(
      () => props.tools ?? (props.loadout ? resolveToolLoadout(props.loadout) : defaultTools),
    );

    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (model.value?.handleKeyDown(event)) event.preventDefault();
    };

    onMounted(() => {
      acquireToolbarStyles();
      const created = new DestroyerEngine({
        soundEnabled: props.soundDefault,
        history: true,
        ...props.engineOptions,
      });
      for (const tool of toolset.value) created.registerTool(tool);
      engine.value = created;

      const created_model = new ToolbarModel(created, {
        tools: toolset.value,
        strings: props.strings,
        onClose: () => emit("close"),
      });
      model.value = created_model;
      unsubscribe = created_model.subscribe((next) => {
        state.value = next;
      });

      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.addEventListener("keydown", onWindowKeyDown);
      mounted.value = true;
      emit("ready", created);
    });

    onBeforeUnmount(() => {
      window.removeEventListener("keydown", onWindowKeyDown);
      unsubscribe?.();
      unsubscribe = null;
      model.value?.destroy();
      model.value = null;
      engine.value?.dispose();
      engine.value = null;
      releaseToolbarStyles();
      if (previousFocus?.isConnected) previousFocus.focus();
      previousFocus = null;
    });

    /** Arrow keys move focus inside the bar and never leave it. */
    const onBarKeyDown = (event: KeyboardEvent) => {
      const current = state.value;
      const controller = model.value;
      if (!current || !controller) return;
      const count = current.buttons.length;
      let next: number | null = null;
      if (event.key === "ArrowLeft") next = current.focusIndex - 1;
      else if (event.key === "ArrowRight") next = current.focusIndex + 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = count - 1;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      controller.setFocusIndex(next);
      const index = ((next % count) + count) % count;
      bar.value?.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
    };

    const renderButton = (button: ToolbarButton, index: number, current: ToolbarState): VNode =>
      h(
        "button",
        {
          key: `${button.kind}:${button.id}`,
          type: "button",
          class: "rl-btn",
          "aria-label": button.label,
          title: button.title,
          // Exactly one button is tabbable; arrows move within the group.
          tabindex: index === current.focusIndex ? 0 : -1,
          ...(button.pressed === undefined ? {} : { "aria-pressed": String(button.pressed) }),
          ...(button.disabled ? { "aria-disabled": "true" } : {}),
          style: {
            ...(button.fontSize ? { fontSize: `${button.fontSize}px` } : {}),
            ...(button.color ? { color: button.color } : {}),
          },
          onClick: () => {
            // `aria-disabled` keeps the button reachable, so the press is
            // refused here rather than by the `disabled` attribute.
            if (!button.disabled) button.run();
          },
          onFocus: () => model.value?.setFocusIndex(index),
        },
        button.icon
          ? [h("img", { src: button.icon, alt: "", width: 30, height: 30 })]
          : [button.glyph ?? button.toolIcon ?? ""],
      );

    return () => {
      const current = state.value;
      if (!mounted.value || !current) return null;

      const children: VNode[] = [];
      let previousKind: ToolbarButton["kind"] | null = null;
      current.buttons.forEach((button, index) => {
        if (previousKind === "tool" && button.kind === "action") {
          children.push(h("span", { key: `divider:${button.id}`, class: "rl-divider" }));
        }
        previousKind = button.kind;
        children.push(renderButton(button, index, current));
      });

      if (current.status) {
        children.push(
          h("span", { key: "status", class: "rl-chip", title: current.status.title }, [
            h("span", {
              class: current.status.color ? "rl-dot" : "rl-dot rl-dot-pending",
              style: current.status.color ? { color: current.status.color } : undefined,
            }),
            current.status.label,
          ]),
        );
      }

      return h(Teleport, { to: "body" }, [
        h("div", { class: "rl-host", [RAGELAYER_IGNORE_ATTR]: "" }, [
          // Live region for keyboard aiming feedback.
          h(
            "div",
            { class: "rl-sr-only", role: "status", "aria-live": "polite" },
            current.announcement,
          ),
          current.flash ? h("div", { class: "rl-flash", role: "status" }, current.flash) : null,
          h(
            "div",
            {
              ref: bar,
              class: BAR_CLASS,
              role: "toolbar",
              "aria-label": props.strings?.toolbarLabel ?? "RageLayer tools",
              "aria-orientation": "horizontal",
              onKeydown: onBarKeyDown,
            },
            children,
          ),
        ]),
      ]);
    };
  },
});

export default RageLayer;
