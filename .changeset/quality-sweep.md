---
"desktop-destroyer": patch
---

Code-quality sweep: truthful types, new exports, sprite-cache release, tests.

- `captureFilter` is now truthfully typed `(node: Node) => boolean` — html-to-image
  calls the filter for every cloned node (text and comment nodes included), not just
  `HTMLElement`s. Existing element-typed callbacks keep working; docs examples now
  check `instanceof Element` before touching element-only APIs.
- New exports from the core entry point: `downloadBlob`, `copyBlobToClipboard`,
  `snapshotFilename` (the share helpers the React toolbar uses, for hosts building
  their own toolbar) and `clearSpriteCache` (drops the shared baked-sprite atlas;
  rebuilt lazily on next use).
- The sprite cache is now refcounted per engine: disposing the last live
  `DestroyerEngine` releases the baked sprite canvases automatically.
- `SoundEngine.loop()` no longer creates an AudioContext from the engine's rAF loop
  while nothing is playing — audio comes up only on a real sound, inside a user
  gesture, as documented (removes Chrome's autoplay-policy warning with sound off).
- Deduplicated polygon math (engine now uses `polygonArea2` from topology) and the
  `DD_IGNORE_ATTR` re-export; removed a stale doc comment and a pointless
  `captureFilter` reset in `dispose()`.
- Docs corrected: black hole debris pull is inverse-linear (matching the solver),
  `flushBugs(x, y, r)` signature, `Tool.reset` hook and the React `toolStyle` /
  `debugGlobal` props are now documented.
- New unit tests for fracture geometry (convex hull, Voronoi area conservation,
  grid partitioning, shard budget), the performance monitor (percentiles, ring
  buffer, adaptive quality laddering) and `pickPixelRatio` boundaries.
