---
"ragelayer": patch
---

fix: cancelled gestures discard queued pointer moves; pointer input extracted from the engine

Administrative gesture cancellation (undo, redo, clear) now drops any pointer
moves still queued for the frame — previously the next frame could replay
pre-undo movement through the active tool and land fresh damage on the pixels
the undo had just restored. Pointer handlers also stop reacting once the
engine is disposed, not just while paused.

Internally, the full pointer gesture lifecycle (event binding, pointer
capture, bounded move coalescing, cancellation, scripted strikes) moved out of
`RageLayerEngine` into `src/pointer-input.ts` behind a narrow host interface,
with direct unit tests; the write-only perf-counter types moved to
`src/perf-counters.ts`, and narrow-phase collision was decoupled from the
physics `Body` via a minimal `CollisionBody` contract. No public API changes.
