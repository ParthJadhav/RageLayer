---
"ragelayer": minor
---

Probe canvas→texture upload cost at runtime and keep the WebGL surface shading and post-FX bloom on their plain-2D fallbacks where uploads are slow. Chromium uploads canvas sources GPU-to-GPU (~0.01 ms) and keeps the full pipeline; Firefox and WebKit currently pay a fixed multi-millisecond toll per upload call, which made heavy scenes run at single-digit FPS (measured 4.5 → 45 FPS on the worst-case stress scenario in Firefox, 13 → 60 FPS in WebKit). Destruction visuals are unchanged on those browsers — only glass-edge shading, page warp, bloom, and heat shimmer switch off. The probed cost is reported as `sample.gpu.uploadCostMs` in performance snapshots, and a Playwright-based cross-browser stress runner (`bun run perf:browsers`) drives the same scenarios in Firefox, WebKit, and Chrome.
