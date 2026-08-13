import type React from "react";

/**
 * Every static style the toolbar uses.
 *
 * Split out because it is exactly that — static. None of it depends on props
 * or state, and keeping ~150 lines of CSS-in-JS and a keyframes blob next to
 * the component's logic buried the parts that actually do something.
 */

export const hostStyle: React.CSSProperties = {
  // Explicit visibility: while content-destruction mode hides the real page
  // (visibility: hidden on <body>), the toolbar re-enables itself.
  visibility: "visible",
  position: "fixed",
  left: "50%",
  bottom: "max(18px, env(safe-area-inset-bottom))",
  transform: "translateX(-50%)",
  zIndex: 2147483001,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 10,
  width: "max-content",
  maxWidth: "calc(100vw - 24px)",
  pointerEvents: "none",
};

export const barStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // On narrow viewports the row wraps instead of clipping: every tool stays
  // reachable without a hidden horizontal scroll.
  flexWrap: "wrap",
  gap: 2,
  padding: 6,
  borderRadius: 18,
  background: "rgba(14, 13, 12, 0.94)",
  backdropFilter: "blur(18px) saturate(140%)",
  WebkitBackdropFilter: "blur(18px) saturate(140%)",
  border: "1px solid rgba(255,255,255,0.10)",
  boxShadow:
    "0 1px 0 rgba(255,255,255,0.07) inset, 0 20px 50px -16px rgba(0,0,0,0.7), 0 4px 14px rgba(0,0,0,0.3)",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  userSelect: "none",
  animation: "rl-rise 0.35s cubic-bezier(0.22, 1, 0.36, 1)",
  maxWidth: "100%",
  pointerEvents: "auto",
};

export const buttonBase: React.CSSProperties = {
  position: "relative",
  appearance: "none",
  border: 0,
  background: "transparent",
  borderRadius: 12,
  width: 40,
  height: 40,
  fontSize: 20,
  lineHeight: 1,
  // Actions are SVG strokes drawn in `currentColor`, so one colour token moves
  // the idle, hover and disabled states together.
  color: "rgba(255,255,255,0.74)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "transform 0.14s ease, background 0.14s ease, color 0.14s ease",
  flexShrink: 0,
};

/**
 * Capture-status chip, floated just above the toolbar. Page rasterization takes
 * 0.5–2 s in snapshot mode and used to happen with no feedback at all; this says
 * what is happening and which mode you ended up in.
 */
export const chipStyle: React.CSSProperties = {
  // Same reason as the toolbar: content mode hides the real page via
  // `visibility: hidden` on <body>, and this portal is a body descendant.
  visibility: "visible",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "5px 12px",
  borderRadius: 999,
  background: "rgba(14, 13, 12, 0.94)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
  border: "1px solid rgba(255,255,255,0.10)",
  boxShadow: "0 12px 32px -16px rgba(0,0,0,0.7)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.85)",
  whiteSpace: "nowrap",
  userSelect: "none",
  pointerEvents: "auto",
  cursor: "help",
};

export const dotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  flexShrink: 0,
};

export const dividerStyle: React.CSSProperties = {
  width: 1,
  alignSelf: "stretch",
  background: "rgba(255,255,255,0.10)",
  margin: "6px 7px",
  flexShrink: 0,
};

const STYLE_ATTR = "data-ragelayer-toolbar-styles";

const KEYFRAMES = `
@keyframes rl-rise {
  from { opacity: 0; transform: translateY(24px) scale(0.92); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.rl-tool:hover { background: rgba(255,255,255,0.09); color: #fff; }
.rl-tool:active { transform: scale(0.93); }
.rl-tool:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
.rl-tool[data-active="true"] {
  color: #fff;
  background: linear-gradient(180deg, rgba(255,122,40,0.32), rgba(255,122,40,0.18));
  box-shadow: 0 0 0 1px rgba(255,150,70,0.5) inset, 0 5px 16px -6px rgba(255,110,30,0.7);
}
/* A dock-style marker, so the selection survives the pointer moving away and
   the hover tint disappearing. */
.rl-tool[data-active="true"]::after {
  content: "";
  position: absolute;
  bottom: 3px;
  width: 12px;
  height: 2px;
  border-radius: 2px;
  background: #ff7a28;
}
@keyframes rl-spin { to { transform: rotate(360deg); } }
.rl-spinner {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.22);
  border-top-color: rgba(255,255,255,0.85);
  animation: rl-spin 0.7s linear infinite;
}
.rl-hint {
  visibility: visible;
  pointer-events: none;
}
.rl-hint-pill {
  display: inline-block;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(14,13,12,0.94);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: 0 12px 32px -16px rgba(0,0,0,0.7);
  border: 1px solid rgba(255,255,255,0.10);
  color: rgba(255,255,255,0.88);
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 12.5px;
  letter-spacing: 0.02em;
  max-width: min(720px, calc(100vw - 32px));
  line-height: 1.35;
  text-align: center;
  text-wrap: pretty;
}
@media (prefers-reduced-motion: reduce) {
  .rl-tool { transition: none; }
  .rl-tool:hover { transform: none; }
}
@media (max-width: 640px) {
  .rl-hint-pill { font-size: 14px; }
  /* Full 44px touch targets once the row scrolls instead of wrapping. */
  .rl-tool { width: 44px; height: 44px; }
  .rl-toolbar-bar {
    width: calc(100vw - 24px);
    flex-wrap: nowrap !important;
    justify-content: flex-start !important;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .rl-toolbar-bar::-webkit-scrollbar { display: none; }
}
`;

// The <style> block is shared by every mounted instance and injected at most
// once: a module-level refcount adds it with the first toolbar and removes it
// with the last, instead of stacking one copy per mount.
let styleUses = 0;
let styleElement: HTMLStyleElement | null = null;

export function acquireStyles() {
  styleUses += 1;
  if (styleElement || document.head.querySelector(`style[${STYLE_ATTR}]`)) return;
  styleElement = document.createElement("style");
  styleElement.setAttribute(STYLE_ATTR, "");
  styleElement.textContent = KEYFRAMES;
  document.head.appendChild(styleElement);
}

export function releaseStyles() {
  styleUses = Math.max(0, styleUses - 1);
  if (styleUses > 0 || !styleElement) return;
  styleElement.remove();
  styleElement = null;
}
