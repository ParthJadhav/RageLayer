---
"ragelayer": patch
---

Display text now reads `RageLayer` consistently. Console warnings use the `[RageLayer]` prefix instead of `[ragelayer]`, and shared screenshots download as `RageLayer-<timestamp>.png`. The package name, entry points (`ragelayer/react`, …), DOM attributes (`data-ragelayer-*`), and events (`ragelayer-close`, `ragelayerchange`) are unchanged — npm forbids uppercase in package names, and the DOM contracts stay case-stable.
