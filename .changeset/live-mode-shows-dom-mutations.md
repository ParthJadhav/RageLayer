---
"ragelayer": patch
---

Live capture mode now shows DOM mutations. The mirror's repaint fast path redraws a mounted clone, so a counter ticking in page DOM — or anything inserted after the capture — never appeared on screen. A `MutationObserver` on the capture root (mutations inside `captureFilter`-excluded elements don't count) now marks the mirror stale so the next refresh re-clones, and the refresh loop presents the recomposed band itself so an idle page — whose frame loop is parked — actually shows it.
