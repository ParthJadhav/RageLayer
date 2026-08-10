/**
 * Toolbar stylesheet for the Vue component.
 *
 * The Vue toolbar teleports into `<body>` rather than living in a shadow root
 * (so host apps can still theme it if they want to), which means the rules
 * need class prefixes and a refcounted `<style>` element — two toolbars must
 * not install it twice, and the last one to unmount takes it away again.
 */

export const BAR_CLASS = "dd-bar";

export const TOOLBAR_CSS = `
.dd-host {
  position: fixed;
  inset: auto 0 0 0;
  z-index: 2147483001;
  pointer-events: none;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.dd-bar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  width: max-content;
  max-width: calc(100vw - 24px);
  margin: 0 auto 16px;
  padding: 8px 10px;
  flex-wrap: wrap;
  justify-content: center;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(20, 18, 16, 0.82);
  backdrop-filter: blur(12px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  animation: dd-rise 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
@keyframes dd-rise {
  from { transform: translateY(14px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
.dd-btn {
  all: unset;
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 11px;
  cursor: pointer;
  font-size: 19px;
  line-height: 1;
  color: rgba(255, 255, 255, 0.92);
  transition: background 0.14s ease, transform 0.14s ease;
}
.dd-btn:hover:not([aria-disabled="true"]) { background: rgba(255, 255, 255, 0.1); }
.dd-btn:active:not([aria-disabled="true"]) { transform: scale(0.94); }
.dd-btn[aria-pressed="true"] { background: rgba(220, 90, 31, 0.9); color: #fff; }
/* Keyboard operation depends on this ring being visible in every state. */
.dd-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.dd-btn[aria-disabled="true"] { opacity: 0.38; cursor: default; }
.dd-btn img { display: block; }
.dd-divider {
  width: 1px;
  height: 26px;
  margin: 0 2px;
  background: rgba(255, 255, 255, 0.14);
}
.dd-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 4px;
  padding: 0 10px;
  height: 28px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
  white-space: nowrap;
}
.dd-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.dd-dot-pending { animation: dd-pulse 1s ease-in-out infinite; }
@keyframes dd-pulse { 50% { opacity: 0.25; } }
.dd-flash {
  position: absolute;
  left: 50%;
  bottom: 72px;
  transform: translateX(-50%);
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(20, 18, 16, 0.92);
  color: #fff;
  font-size: 12px;
  white-space: nowrap;
}
.dd-sr-only {
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
  .dd-bar { animation: none; }
  .dd-btn { transition: none; }
  .dd-dot-pending { animation: none; }
}
`;

let refCount = 0;
let element: HTMLStyleElement | null = null;

export function acquireToolbarStyles() {
  if (typeof document === "undefined") return;
  refCount++;
  if (element) return;
  element = document.createElement("style");
  element.dataset.desktopDestroyer = "toolbar";
  element.textContent = TOOLBAR_CSS;
  document.head.appendChild(element);
}

export function releaseToolbarStyles() {
  if (refCount > 0) refCount--;
  if (refCount > 0 || !element) return;
  element.remove();
  element = null;
}
