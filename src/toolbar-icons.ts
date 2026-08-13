/**
 * Line icons for the toolbar's action buttons.
 *
 * The actions used to be emoji (↶ 📸 🔊 🩹 …). Emoji are drawn by the platform,
 * so they ignore `color`, render at a different weight on every OS, and sit at
 * roughly 60% luminance against the dark bar — the worst-contrast pixels in the
 * whole UI. These are single-path strokes on a 24×24 grid that inherit
 * `currentColor`, so one colour token drives every state.
 *
 * Each value is one `d` attribute; multiple `M` sub-paths keep it to a single
 * `<path>` element per icon regardless of view layer.
 */

export type ToolbarIconName =
  | "undo"
  | "redo"
  | "collapse"
  | "snapshot"
  | "soundOn"
  | "soundOff"
  | "repair"
  | "aim"
  | "close"
  | "pause"
  | "play";

export const TOOLBAR_ICONS: Readonly<Record<ToolbarIconName, string>> = Object.freeze({
  undo: "M9.5 14.5 4.5 9.5l5-5M4.5 9.5h9a6 6 0 0 1 0 12h-2.5",
  redo: "m14.5 14.5 5-5-5-5M19.5 9.5h-9a6 6 0 0 0 0 12H13",
  collapse: "m7 4.5 5 5 5-5M7 12l5 5 5-5M5 20.5h14",
  snapshot:
    "M4.5 7.5h3L9 5h6l1.5 2.5h3A1.5 1.5 0 0 1 21 9v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V9a1.5 1.5 0 0 1 1.5-1.5ZM15.5 13.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z",
  soundOn: "M11.5 5 6.5 9H3v6h3.5l5 4V5ZM15.5 9.2a4 4 0 0 1 0 5.6M18.3 6.4a8 8 0 0 1 0 11.2",
  soundOff: "M11.5 5 6.5 9H3v6h3.5l5 4V5Zm4.5 4.5 5 5m0-5-5 5",
  repair:
    "m10.5 3.5 1.7 4.3 4.3 1.7-4.3 1.7-1.7 4.3-1.7-4.3L4.5 9.5l4.3-1.7 1.7-4.3ZM18 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9.9-2.1Z",
  aim: "M12 3v3.5m0 11V21M21 12h-3.5M6.5 12H3M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  close: "m6 6 12 12M18 6 6 18",
  pause: "M9.5 5v14M14.5 5v14",
  play: "M8.5 5.5v13l11-6.5-11-6.5Z",
});

/** Markup for an icon, for hosts building a toolbar with strings or `innerHTML`. */
export function toolbarIconSvg(path: string, size = 22): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `focusable="false"><path d="${path}" /></svg>`
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The same icon as a detached DOM node, for hosts that avoid `innerHTML`. */
export function toolbarIconElement(path: string, size = 22): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const node = document.createElementNS(SVG_NS, "path");
  node.setAttribute("d", path);
  svg.append(node);
  return svg;
}
