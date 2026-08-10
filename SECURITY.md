# Security policy

## Supported versions

Security fixes are released for the latest published version. Upgrade to the newest release before
reporting an issue that may already be fixed.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/ParthJadhav/desktop-destroyer/security/advisories/new)
and include:

- the affected version and browser;
- a minimal reproduction or proof of concept;
- the security impact you expect; and
- any suggested mitigation.

You should receive an acknowledgement within seven days. Confirmed issues will be coordinated
privately until a fix and advisory are ready. Please avoid accessing data that is not yours while
testing.

Desktop Destroyer runs entirely in the host page. It does not send captured page content or
telemetry to a server. Its page snapshot is held in browser memory unless the host explicitly asks
the engine to export it.
