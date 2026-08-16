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

## Using the tools without a pointer

The toolbar has always been keyboard-operable, but the canvas is a pointer surface — so until
recently a keyboard-only visitor could select the hammer and then do nothing with it. Aiming mode
closes that gap.

Press `A`, or the crosshair button, with a tool in hand:

- a high-contrast reticle appears in the middle of the viewport;
- arrow keys move it, and the page scrolls to keep it visible;
- `Enter` or `Space` uses the tool where it is pointing;
- `Esc` leaves aiming without closing the toolbar;
- each move and each strike is announced in a polite live region.

The cursor is drawn by the engine, in document space above the destruction, with a dark outline
under a light stroke so it stays legible over a white page, a burnt one, and the void alike.

A keyboard strike takes a history checkpoint like any other blow, so it can be undone. Custom
tools need no special handling to be reachable this way — see `engine.strike()` in the
[API reference](./api.md#keyboard-operation).

## Translation

Every string the built-in toolbars produce, including all accessible names and the aiming
announcements, can be replaced through the `strings` option. Tool names and hints are overridden
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
