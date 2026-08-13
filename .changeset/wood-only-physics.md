---
"ragelayer": major
---

Replace configurable page materials with one fixed wood-like physical response. This removes the
material registry, material definitions and DOM material attributes from the public API. It also
removes Freeze Ray, Wrecking Ball, and Glitch Gun, reducing the built-in set to 16 tools: seven base,
five heavy, and four advanced.

Laser Cutter now cuts structure immediately like the Chainsaw and drops isolated pieces. Acid
Sprayer keeps visible and structural impacts aligned and spreads a short, bounded distance around
each deposit, with a persistent reaction rim that stays clipped to surviving wood. Fire spreads
across surviving content with a coherent baked flame body and a bounded smoke plume. Paintball
supports automatic fire while held, and the Water Hose uses a compact pressure-nozzle model. The
Gun model now has a more complete silhouette, working slide, and firing-cadence recoil.

Toolbars also keep usage hints visible, share keyboard aiming and translations across React, Vue,
and the custom element, and provide non-shrinking 44px touch targets on narrow screens.
Built-in cooldowns, gesture paths and delayed effects are now isolated per engine, so simultaneous
mounted layers cannot advance or clear one another's tool state. Timed effects continue after tool
switches, while settled built-ins stop requesting idle animation frames even when their 3D model
remains visible under a stationary pointer. Waking an idle loop no longer integrates its sleeping
interval, and faded tool-audio loops are stopped and disconnected instead of processing silently.
