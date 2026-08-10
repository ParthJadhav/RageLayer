import type React from "react";

/**
 * Every static style the toolbar uses.
 *
 * Split out because it is exactly that — static. None of it depends on props
 * or state, and keeping ~150 lines of CSS-in-JS and a keyframes blob next to
 * the component's logic buried the parts that actually do something.
 */

export const barStyle: React.CSSProperties = {
  // Explicit visibility: while content-destruction mode hides the real page
  // (visibility: hidden on <body>), the toolbar re-enables itself.
  visibility: "visible",
  position: "fixed",
  left: "50%",
  bottom: 18,
  transform: "translateX(-50%)",
  zIndex: 2147483001,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // On narrow viewports the row wraps instead of clipping: every tool stays
  // reachable without a hidden horizontal scroll.
  flexWrap: "wrap",
  gap: 3,
  padding: "7px 9px",
  borderRadius: 18,
  background: "rgba(18, 17, 16, 0.82)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(255,255,255,0.14)",
  boxShadow: "0 12px 40px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.3)",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  userSelect: "none",
  animation: "dd-rise 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2)",
  maxWidth: "calc(100vw - 24px)",
};

export const buttonBase: React.CSSProperties = {
  appearance: "none",
  border: "1px solid transparent",
  background: "transparent",
  borderRadius: 12,
  width: 42,
  height: 42,
  fontSize: 22,
  lineHeight: 1,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "transform 0.12s ease, background 0.12s ease, border-color 0.12s ease",
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
  position: "fixed",
  left: "50%",
  bottom: 72,
  transform: "translateX(-50%)",
  zIndex: 2147483001,
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "5px 11px",
  borderRadius: 999,
  background: "rgba(18, 17, 16, 0.82)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(255,255,255,0.14)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.82)",
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
  height: 28,
  background: "rgba(255,255,255,0.15)",
  margin: "0 3px",
  flexShrink: 0,
};

const STYLE_ATTR = "data-dd-toolbar-styles";

const KEYFRAMES = `
@keyframes dd-rise {
  from { opacity: 0; transform: translateX(-50%) translateY(24px) scale(0.92); }
  to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}
.dd-tool:hover { background: rgba(255,255,255,0.10); transform: translateY(-2px); }
.dd-tool:active { transform: translateY(0) scale(0.92); }
.dd-tool:focus-visible {
  outline: 2px solid rgba(255, 170, 90, 0.9);
  outline-offset: 1px;
}
.dd-tool[data-active="true"] {
  background: rgba(255, 122, 40, 0.18);
  border-color: rgba(255, 150, 70, 0.55);
  box-shadow: 0 0 14px rgba(255, 130, 50, 0.25) inset;
}
@keyframes dd-spin { to { transform: rotate(360deg); } }
.dd-spinner {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.22);
  border-top-color: rgba(255,255,255,0.85);
  animation: dd-spin 0.7s linear infinite;
}
.dd-hint {
  visibility: visible;
  position: fixed;
  /* Clears the capture-status chip, which sits at 72px. */
  bottom: 106px;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
}
.dd-hint-pill {
  display: inline-block;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(18,17,16,0.85);
  border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.85);
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 12px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .dd-tool { transition: none; }
  .dd-tool:hover { transform: none; }
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
