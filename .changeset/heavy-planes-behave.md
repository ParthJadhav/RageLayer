---
"desktop-destroyer": patch
---

Bundle the `html-to-image` capture code into the package as a lazily-loaded chunk and drop the
runtime dependency. Loading `dist` directly in a browser (the demo, harnesses, benchmarks, CDN
usage) previously failed to resolve the bare specifier and silently degraded to overlay mode —
no destructible page content, no fracture debris, and content-dependent tools (laser cutter, acid
sprayer, bugs, demolition chunks) did nothing.

Fix the broom leaving a trail of phantom torn-edge rings on intact pages: `ContentLayer.restore`
now composes its pristine disc on a scratch canvas and stamps it in one draw, instead of a
clip + clear + draw sequence that antialiased the rim twice and left a partial-alpha seam the
surface shader shaded as a wound.

Make the Glitch Gun read on light backgrounds: corruption now tears real page slices sideways and
composites its interference bars with `difference` instead of `screen`, which was nearly invisible
against white.

The demo toolbar now exercises the full public surface: built-in loadout switching, undo/redo,
whole-page repair, snapshot download, sound and pause toggles, combo toasts, and a live
fps/capture status readout.
