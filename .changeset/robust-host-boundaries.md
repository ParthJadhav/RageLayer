---
"ragelayer": patch
---

Clean up failed custom-tool mounts across vanilla, React, Vue, and custom-element integrations.
Isolate host event, toolbar, lifecycle, and telemetry callbacks so one exception cannot prevent
cleanup, stall frame recording, or leave other views stale. Complete disposal even when a custom
tool reset throws. Validate rate-limiter and history numeric boundaries, reject overlapping or
nonfinite scripted strikes, and release gesture/audio state when a tool throws.
