/**
 * Emoji-based cursors as inline SVG data URIs — no image assets. The emoji is
 * offset so its "business end" sits near the hotspot, with a small crosshair
 * dot so aiming still feels precise.
 */
export function emojiCursor(
  emoji: string,
  opts: { size?: number; hotspotX?: number; hotspotY?: number; flip?: boolean } = {},
): string {
  const size = opts.size ?? 36;
  const hx = opts.hotspotX ?? 4;
  const hy = opts.hotspotY ?? 4;
  const transform = opts.flip ? `transform="scale(-1,1) translate(${-size},0)"` : "";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${hx}" cy="${hy}" r="2.5" fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.6)" stroke-width="1"/>` +
    `<text x="${size / 2}" y="${size / 2}" ${transform} font-size="${size * 0.7}" text-anchor="middle" dominant-baseline="central">${emoji}</text>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hx} ${hy}, crosshair`;
}
