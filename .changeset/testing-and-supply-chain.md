---
"desktop-destroyer": patch
---

Test the destruction pipeline for real, and harden the release path.

Unit tests now run against a DOM with a real Canvas2D rasterizer, so the coverage map, wound
compositing, physics solver and every built-in tool are asserted on actual pixels rather than
mocks — 274 tests, up from 57, taking line coverage from 44% to 85%. A new runtime suite
(`bun run test:browser`) drives the built package through headless Chrome and asserts what a
visitor sees: the page is captured, the WebGL2 surface shader comes up, tools punch real holes,
undo restores them, and disposing puts the real page back. Both run in CI, with coverage floors
and a per-module gate.

Also fixes `import "desktop-destroyer/element"` throwing when evaluated on a server, and stops
bundlers from tree-shaking away the element's registration.
