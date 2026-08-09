---
"desktop-destroyer": patch
---

React wrapper fixes and accessibility pass.

- StrictMode safety: `engine.setTool` no longer runs inside a `setState` updater; the engine now syncs from state in an effect.
- Keyboard shortcuts ignore typing contexts (inputs, textareas, contenteditable, IME composition) and held-down key repeats, so pressing `R` in a search box no longer repairs the page.
- SSR safety: the component renders `null` until mounted instead of calling `createPortal(…, document.body)` during server render — no `ssr: false` workaround needed.
- `window.__desktopDestroyer` is now opt-in via the new `debugGlobal` prop (default off). `benchmarks/runtime.html` sets its own handle and is unaffected; pages profiled with `scripts/profile-effects.mjs` must pass `debugGlobal` to the React component.
- The injected toolbar `<style>` is deduped (tagged `data-dd-toolbar-styles`, refcounted across instances) instead of stacking one copy per mount.
- Accessibility: engine overlay container is `aria-hidden`; toolbar gets a roving tabindex with ArrowLeft/ArrowRight/Home/End navigation and a `:focus-visible` ring; the tool hint is a persistent `aria-live="polite"` region; focus moves into the toolbar on mount and returns to the previously focused element on close; `prefers-reduced-motion` disables the toolbar rise animation and hover motion. Known limitation: the engine has no reduced-motion knob yet, so in-canvas screen shake still plays under `prefers-reduced-motion`.
- The toolbar wraps onto multiple rows on narrow viewports instead of clipping behind a hidden horizontal scroll.
