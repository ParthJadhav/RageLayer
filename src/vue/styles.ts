/**
 * Toolbar stylesheet for the Vue component.
 *
 * The Vue toolbar teleports into `<body>` rather than living in a shadow root
 * (so host apps can still theme it if they want to), which means the rules
 * need class prefixes and a refcounted `<style>` element — two toolbars must
 * not install it twice, and the last one to unmount takes it away again.
 */

export const BAR_CLASS = "rl-bar";

export const TOOLBAR_CSS = `
.rl-host {
  position: fixed;
  inset: auto 0 max(16px, env(safe-area-inset-bottom)) 0;
  z-index: 2147483001;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  /* One token set drives the bar, the hint pill and the status chip, so
     contrast is tuned in a single place. */
  --rl-surface: rgba(14, 13, 12, 0.94);
  --rl-hairline: rgba(255, 255, 255, 0.1);
  --rl-ink: rgba(255, 255, 255, 0.74);
  --rl-accent: #ff7a28;
}
.rl-bar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 2px;
  width: max-content;
  max-width: calc(100vw - 24px);
  margin: 0 auto;
  padding: 6px;
  flex-wrap: wrap;
  justify-content: center;
  border-radius: 18px;
  border: 1px solid var(--rl-hairline);
  background: var(--rl-surface);
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.07) inset,
    0 20px 50px -16px rgba(0, 0, 0, 0.7), 0 4px 14px rgba(0, 0, 0, 0.3);
  animation: rl-rise 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.rl-guide {
  max-width: min(620px, calc(100vw - 32px));
  padding: 6px 14px;
  border: 1px solid var(--rl-hairline);
  border-radius: 999px;
  background: var(--rl-surface);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: 0 12px 32px -16px rgba(0, 0, 0, 0.7);
  color: rgba(255, 255, 255, 0.88);
  font-size: 12.5px;
  line-height: 1.35;
  text-align: center;
  text-wrap: pretty;
  pointer-events: none;
}
@keyframes rl-rise {
  from { transform: translateY(14px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
.rl-btn {
  all: unset;
  position: relative;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border-radius: 12px;
  cursor: pointer;
  font-size: 19px;
  line-height: 1;
  color: var(--rl-ink);
  transition: background 0.14s ease, color 0.14s ease, transform 0.14s ease;
}
.rl-btn:hover:not([aria-disabled="true"]) { background: rgba(255, 255, 255, 0.09); color: #fff; }
.rl-btn:active:not([aria-disabled="true"]) { transform: scale(0.93); }
.rl-btn[aria-pressed="true"] {
  color: #fff;
  background: linear-gradient(180deg, rgba(255, 122, 40, 0.32), rgba(255, 122, 40, 0.18));
  box-shadow: 0 0 0 1px rgba(255, 150, 70, 0.5) inset, 0 5px 16px -6px rgba(255, 110, 30, 0.7);
}
/* A dock-style marker, so the selection survives the pointer moving away and
   the hover tint disappearing. */
.rl-btn[aria-pressed="true"]::after {
  content: "";
  position: absolute;
  bottom: 3px;
  width: 12px;
  height: 2px;
  border-radius: 2px;
  background: var(--rl-accent);
}
/* A visible focus ring is the whole point for keyboard operation; never
   remove it, and keep it legible against both bar and active states. */
.rl-btn:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
/* Disabled controls dim their ink rather than the whole button: an opacity
   wash over the dark bar left undo and redo close to invisible. */
.rl-btn[aria-disabled="true"] { color: rgba(255, 255, 255, 0.26); cursor: default; }
.rl-btn img { width: 28px; height: 28px; display: block; }
.rl-btn svg { display: block; }
.rl-divider {
  width: 1px;
  align-self: stretch;
  margin: 6px 7px;
  background: var(--rl-hairline);
}
.rl-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
  padding: 0 10px;
  height: 28px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.78);
  font-size: 11px;
  letter-spacing: 0.04em;
  white-space: nowrap;
  flex: 0 0 auto;
}
.rl-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.rl-dot-pending { animation: rl-pulse 1s ease-in-out infinite; }
@keyframes rl-pulse { 50% { opacity: 0.25; } }
.rl-flash {
  position: absolute;
  left: 50%;
  bottom: 72px;
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--rl-hairline);
  background: var(--rl-surface);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}
.rl-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .rl-bar { animation: none; }
  .rl-btn { transition: none; }
  .rl-dot-pending { animation: none; }
}
@media (max-width: 640px) {
  .rl-guide { font-size: 14px; }
  .rl-bar {
    width: calc(100vw - 24px);
    flex-wrap: nowrap;
    justify-content: flex-start;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .rl-bar::-webkit-scrollbar { display: none; }
  /* Full 44px touch targets once the row scrolls instead of wrapping. */
  .rl-btn { width: 44px; height: 44px; }
}
`;

let refCount = 0;
let element: HTMLStyleElement | null = null;

export function acquireToolbarStyles() {
  if (typeof document === "undefined") return;
  refCount++;
  if (element) return;
  element = document.createElement("style");
  element.dataset.rageLayer = "toolbar";
  element.textContent = TOOLBAR_CSS;
  document.head.appendChild(element);
}

export function releaseToolbarStyles() {
  if (refCount > 0) refCount--;
  if (refCount > 0 || !element) return;
  element.remove();
  element = null;
}
