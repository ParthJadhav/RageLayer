# Accessibility

RageLayer is an optional visual toy, not primary application content. The host application
remains responsible for deciding when it is appropriate and for providing an obvious way to close it.

## Built-in behavior

The React toolbar provides:

- semantic buttons inside a labelled `role="toolbar"`;
- roving focus with Arrow Left/Right, Home, and End;
- visible keyboard focus and persistent tool names/hints;
- `aria-pressed` for selected tools and sound state;
- status announcements for capture mode and snapshot completion;
- focus transfer into the toolbar and restoration on close;
- keyboard shortcuts that ignore inputs, editors, IME composition, and repeated keys;
- sound off by default.

The canvas overlay is marked `aria-hidden="true"`; it is visual output rather than meaningful
document structure. The Svelte launcher action maintains `aria-pressed`, while the Vue and headless
React bindings expose `isOpen` so host controls can do the same.

The Vue component and the `<rage-layer>` custom element render the same toolbar with the
same behaviour, so the list above is not React-only.

## Known limitation: the canvas is pointer-only

The toolbar is keyboard-operable, but the canvas is not. A keyboard-only visitor can select the
hammer and then has no built-in way to swing it.

RageLayer shipped a keyboard aiming mode through 1.x — an arrow-steered reticle drawn on the
canvas — and it was **removed in 2.0.0**. Nothing replaces it in the built-in toolbars.

If keyboard operation matters for your host, `engine.strike(x, y)` is public and does the whole
job: it runs the same `onDown`/`onUp` pair a click produces and takes a history checkpoint, so a
keyboard-driven blow is undoable like any other, and custom tools need no special handling to be
reachable through it. What a host has to supply is the part that was removed — a cursor to steer,
somewhere to announce it, and the key handling. See
[Toolbars, i18n & keyboard](./toolbar.md#using-a-tool-without-a-pointer).

Treat this as a reason to keep RageLayer strictly optional: it is a visual toy, and no part of your
application's actual content or controls should sit behind it.

## Translation

Every string the built-in toolbars produce, including all accessible names, can be replaced
through the `strings` option. Tool names and hints are overridden
by tool id. See [Toolbars, i18n & keyboard](./toolbar.md#translating-and-rewording).

## Reduced motion

`reducedMotion: "system"` is the default. It follows `prefers-reduced-motion` and disables camera
shake plus nonessential toolbar/vignette transitions. Tool, particle, and physics motion remain:
motion is the core output of this package rather than decorative navigation feedback.

```ts
createRageLayer({ reducedMotion: true });  // always reduce camera/UI motion
createRageLayer({ reducedMotion: false }); // explicitly keep full feedback
```

Do not open RageLayer automatically for a visitor who has requested reduced motion. Prefer an
explicit, clearly labelled launcher.

## Host integration checklist

- Use a real `<button>` for the launcher and reflect open state with `aria-pressed` or an expanded
  state appropriate to your UI.
- Keep the launcher or close control outside the captured content with `data-ragelayer-ignore`.
- Provide an accessible name that describes the effect; “Destroy this page” is clearer than an
  unexplained icon.
- Ensure `Esc` or an equally reachable control closes custom toolbars.
- Do not rely on sound, color, or motion alone to communicate an application state.
- Avoid enabling the toy on pages where unexpected motion could interfere with an essential task.
- Test keyboard-only operation, zoom, forced colors, and the production CSP.

The library intentionally does not rewrite or remove semantic DOM nodes. Snapshot mode temporarily
hides the captured root visually with `visibility`, then restores it on dispose. Because a destructive
session is inherently visual, it should be treated as an enhancement rather than the only path to any
feature or information.
