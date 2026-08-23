---
"ragelayer": patch
---

perf: cache the void mask as an inverse-alpha band and erase with destination-out on slow-canvas browsers

The frame's "void mask" — which clips surface-bound effects (bugs, water,
flames) to the page's surviving pixels — used to be one full-band
`destination-in` draw of the content surface. On CPU-rasterized Canvas2D
(Firefox/Gecko, and WebKit's non-GL path) that op is doubly poisonous: it
touches every pixel of the fx canvas, and it knocks the canvas off the
accelerated path so every later canvas-source draw in the same frame (smoke,
steam, flame sprites) pays a fixed toll. Heavy water and bug scenarios ran
3–5× slower than Chrome at desktop viewports.

Browsers whose canvas→GL upload probe reads slow now mask with one
`destination-out` draw of a cached inverse of the visible band's page alpha
(opaque where the page is gone, including past the document's edges) —
fx · (1 − holes) is exactly fx · pageAlpha, and `destination-out` leaves
pixels outside its source untouched, so nothing deopts. The cache rebuilds on
scroll or resize and otherwise refreshes only the accumulated surface-damage
rect. Independently, the opacity map now tracks which 128px cells might be
missing alpha, so frames with no holes in view skip the mask outright in
every browser; fast-canvas browsers (Chrome) keep the original single
`destination-in` draw. Interleaved A/B on Firefox at 1904×1034: flood and
swarm gain ~17ms/frame, mayhem ~2ms, inferno and singularity unchanged;
Chrome is unchanged.
