"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DestroyerEngine } from "../engine";
import { copyBlobToClipboard, downloadBlob, snapshotFilename } from "../share";
import { toolIconDataUrl } from "../toolart";
import { defaultTools } from "../tools";
import type { CaptureStatus, DestroyerOptions, Tool, ToolStyle } from "../types";

export interface DesktopDestroyerProps {
  /** Called when the user closes the toolbar. */
  onClose?: () => void;
  /** Extra or replacement tools. Defaults to the full built-in set. */
  tools?: Tool[];
  /** Engine options (zIndex, caps, physics, post-FX, target element). */
  engineOptions?: DestroyerOptions;
  /** Start with sound on. Default false — visitors get to opt in. */
  soundDefault?: boolean;
  /**
   * `"3d"` (default): drawn tool art at the pointer, toolbar icons baked from
   * it. `"emoji"`: the classic emoji cursors and emoji toolbar icons.
   * `engineOptions.toolStyle`, if set, wins.
   */
  toolStyle?: ToolStyle;
  /**
   * Expose the engine as `window.__desktopDestroyer` for debugging, E2E tests
   * and the profiling harness (`scripts/profile-effects.mjs` waits for this
   * global on the page it drives). Default false — no globals leak into the
   * host page unless asked for.
   */
  debugGlobal?: boolean;
}

const barStyle: React.CSSProperties = {
  // Explicit visibility: while content-destruction mode hides the real page
  // (visibility: hidden on <body>), the toolbar re-enables itself.
  visibility: "visible",
  position: "fixed",
  left: "50%",
  bottom: 18,
  transform: "translateX(-50%)",
  zIndex: 2147483001,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // On narrow viewports the row wraps instead of clipping: every tool stays
  // reachable without a hidden horizontal scroll.
  flexWrap: "wrap",
  gap: 3,
  padding: "7px 9px",
  borderRadius: 18,
  background: "rgba(18, 17, 16, 0.82)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(255,255,255,0.14)",
  boxShadow: "0 12px 40px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.3)",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  userSelect: "none",
  animation: "dd-rise 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2)",
  maxWidth: "calc(100vw - 24px)",
};

const buttonBase: React.CSSProperties = {
  appearance: "none",
  border: "1px solid transparent",
  background: "transparent",
  borderRadius: 12,
  width: 42,
  height: 42,
  fontSize: 22,
  lineHeight: 1,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "transform 0.12s ease, background 0.12s ease, border-color 0.12s ease",
  flexShrink: 0,
};

/**
 * Capture-status chip, floated just above the toolbar. Page rasterization takes
 * 0.5–2 s in snapshot mode and used to happen with no feedback at all; this says
 * what is happening and which mode you ended up in.
 */
const chipStyle: React.CSSProperties = {
  // Same reason as the toolbar: content mode hides the real page via
  // `visibility: hidden` on <body>, and this portal is a body descendant.
  visibility: "visible",
  position: "fixed",
  left: "50%",
  bottom: 72,
  transform: "translateX(-50%)",
  zIndex: 2147483001,
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "5px 11px",
  borderRadius: 999,
  background: "rgba(18, 17, 16, 0.82)",
  backdropFilter: "blur(14px)",
  WebkitBackdropFilter: "blur(14px)",
  border: "1px solid rgba(255,255,255,0.14)",
  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color: "rgba(255,255,255,0.82)",
  whiteSpace: "nowrap",
  userSelect: "none",
  pointerEvents: "auto",
  cursor: "help",
};

const dotStyle: React.CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  flexShrink: 0,
};

/** Chip label, dot colour and tooltip for each capture state. */
function chipFor(status: CaptureStatus, liveUnavailable: boolean) {
  if (status === "capturing") {
    return {
      label: "Capturing page…",
      color: "",
      title: "Rasterizing the page into the destructible canvas.",
    };
  }
  if (status === "live") {
    return {
      label: "Live",
      color: "rgb(74, 222, 128)",
      title:
        "Live capture — experimental Chrome HTML-in-canvas (drawElementImage): the page stays live under the destruction and re-captures itself about once a second.",
    };
  }
  if (status === "snapshot") {
    return liveUnavailable
      ? {
          label: "Snapshot (live unavailable)",
          color: "rgba(255,255,255,0.45)",
          title:
            "Live capture was requested but this browser doesn't expose it. Enable chrome://flags/#enable-experimental-web-platform-features (or #canvas-draw-element) in Chrome to try it. Falling back to a snapshot: the page is frozen at activation; close to unfreeze.",
        }
      : {
          label: "Snapshot",
          color: "rgba(255,255,255,0.45)",
          title: "Snapshot capture — the page is frozen at activation. Close to unfreeze.",
        };
  }
  return null;
}

const dividerStyle: React.CSSProperties = {
  width: 1,
  height: 28,
  background: "rgba(255,255,255,0.15)",
  margin: "0 3px",
  flexShrink: 0,
};

const STYLE_ATTR = "data-dd-toolbar-styles";

const KEYFRAMES = `
@keyframes dd-rise {
  from { opacity: 0; transform: translateX(-50%) translateY(24px) scale(0.92); }
  to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}
.dd-tool:hover { background: rgba(255,255,255,0.10); transform: translateY(-2px); }
.dd-tool:active { transform: translateY(0) scale(0.92); }
.dd-tool:focus-visible {
  outline: 2px solid rgba(255, 170, 90, 0.9);
  outline-offset: 1px;
}
.dd-tool[data-active="true"] {
  background: rgba(255, 122, 40, 0.18);
  border-color: rgba(255, 150, 70, 0.55);
  box-shadow: 0 0 14px rgba(255, 130, 50, 0.25) inset;
}
@keyframes dd-spin { to { transform: rotate(360deg); } }
.dd-spinner {
  width: 9px;
  height: 9px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(255,255,255,0.22);
  border-top-color: rgba(255,255,255,0.85);
  animation: dd-spin 0.7s linear infinite;
}
.dd-hint {
  visibility: visible;
  position: fixed;
  /* Clears the capture-status chip, which sits at 72px. */
  bottom: 106px;
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
}
.dd-hint-pill {
  display: inline-block;
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(18,17,16,0.85);
  border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.85);
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 12px;
  letter-spacing: 0.02em;
  white-space: nowrap;
}
@media (prefers-reduced-motion: reduce) {
  .dd-tool { transition: none; }
  .dd-tool:hover { transform: none; }
}
`;

// The <style> block is shared by every mounted instance and injected at most
// once: a module-level refcount adds it with the first toolbar and removes it
// with the last, instead of stacking one copy per mount.
let styleUses = 0;
let styleElement: HTMLStyleElement | null = null;

function acquireStyles() {
  styleUses += 1;
  if (styleElement || document.head.querySelector(`style[${STYLE_ATTR}]`)) return;
  styleElement = document.createElement("style");
  styleElement.setAttribute(STYLE_ATTR, "");
  styleElement.textContent = KEYFRAMES;
  document.head.appendChild(styleElement);
}

function releaseStyles() {
  styleUses = Math.max(0, styleUses - 1);
  if (styleUses > 0 || !styleElement) return;
  styleElement.remove();
  styleElement = null;
}

/** True when the key event started in a place where the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Drop-in Desktop Destroyer: mounts the canvas engine, renders the bottom
 * toolbar, and cleans everything up on unmount. Purely additive to the host
 * page — no styles leak in or out.
 */
export function DesktopDestroyer({
  onClose,
  tools,
  engineOptions,
  soundDefault = false,
  toolStyle = "3d",
  debugGlobal = false,
}: DesktopDestroyerProps) {
  const engineRef = useRef<DestroyerEngine | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [sound, setSound] = useState(soundDefault);
  const [capture, setCapture] = useState<{ status: CaptureStatus; liveUnavailable: boolean }>({
    status: "idle",
    liveUnavailable: false,
  });
  const [flash, setFlash] = useState<string | null>(null);
  // SSR guard: the portal target (document.body) only exists in the browser,
  // so the first render — including the server one — produces nothing and the
  // real UI appears after mount. Consumers don't need `ssr: false` tricks.
  const [mounted, setMounted] = useState(false);
  // Sampled once at mount: the OS-level "reduce motion" preference turns off
  // the toolbar rise animation (hover/transition motion is handled in CSS).
  const [reducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false),
  );
  // Roving tabindex for the toolbar: exactly one button is tabbable, arrows
  // move focus within the bar.
  const [focusIndex, setFocusIndex] = useState(0);
  const flashTimerRef = useRef<number | null>(null);
  const toolset = useMemo(() => tools ?? defaultTools, [tools]);
  // One resolved style drives both the engine (pointer art) and the toolbar
  // (icon source), so the two can never disagree.
  const resolvedToolStyle = engineOptions?.toolStyle ?? toolStyle;

  // Toolbar icons baked from each tool's drawn art — the buttons show the
  // actual hammer/saw/raygun rather than an emoji stand-in. Once per toolset;
  // skipped entirely in the classic emoji style.
  const artIcons = useMemo(() => {
    const icons: Record<string, string> = {};
    if (resolvedToolStyle === "emoji" || typeof document === "undefined") return icons;
    for (const tool of toolset) {
      if (!tool.art) continue;
      const url = toolIconDataUrl(tool.art, 30);
      if (url) icons[tool.id] = url;
    }
    return icons;
  }, [toolset, resolvedToolStyle]);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    const engine = new DestroyerEngine({
      soundEnabled: soundDefault,
      ...engineOptions,
      toolStyle: resolvedToolStyle,
    });
    for (const tool of toolset) engine.registerTool(tool);
    engineRef.current = engine;
    acquireStyles();
    // Opt-in debug/testing handle — lets host pages, E2E tests and the
    // profiling harness poke the engine.
    const debugWindow = window as unknown as { __desktopDestroyer?: DestroyerEngine };
    if (debugGlobal) debugWindow.__desktopDestroyer = engine;
    // The engine starts capturing inside its own constructor, so seed from it
    // rather than waiting for the first event.
    const sync = () =>
      setCapture({ status: engine.captureStatus, liveUnavailable: engine.liveUnavailable });
    sync();
    const off = engine.on("statuschange", sync);
    return () => {
      off();
      engine.dispose();
      if (debugWindow.__desktopDestroyer === engine) delete debugWindow.__desktopDestroyer;
      releaseStyles();
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      engineRef.current = null;
    };
    // The engine intentionally mounts once; tool/option changes need a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setSound(sound);
  }, [sound]);

  const selectTool = useCallback((id: string | null) => {
    // Pure state toggle — the engine side effect lives in the sync effect
    // below, so StrictMode's double-invoked updaters can't fire it twice.
    setActiveToolId((current) => (id === current ? null : id));
  }, []);

  // Keep the engine's active tool in lockstep with React state. Runs once with
  // `null` on mount, which the engine treats as a no-op.
  useEffect(() => {
    engineRef.current?.setTool(activeToolId);
  }, [activeToolId]);

  // Focus management: the toolbar takes focus when it appears and hands it
  // back to whatever had it when the destroyer closes.
  useEffect(() => {
    if (!mounted) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    toolbarRef.current?.querySelector<HTMLButtonElement>("button.dd-tool")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [mounted]);

  /** Flatten the wreckage to PNG: clipboard if the browser allows, else a download. */
  const saveSnapshot = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const blob = await engine.snapshot();
    if (!blob) return;
    if (await copyBlobToClipboard(blob)) {
      setFlash("Copied to clipboard");
    } else {
      downloadBlob(blob, snapshotFilename());
      setFlash("Saved");
    }
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setFlash(null);
    }, 1800);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // No shortcuts while the user is typing (inputs, textareas,
      // contenteditable, mid-IME-composition) or holding a key down —
      // otherwise "r" in a search box repairs the page.
      if (e.isComposing || e.repeat || isTypingTarget(e.target)) return;
      if (e.key === "Escape") {
        if (activeToolId) selectTool(null);
        else onClose?.();
        return;
      }
      // Digits pick tools: 1–9 then 0 for the tenth, then the remainder is out
      // of reach by keyboard, which is fine — those are the exotic ones.
      const slot = e.key === "0" ? 10 : Number(e.key);
      if (slot >= 1 && slot <= Math.min(10, toolset.length)) {
        selectTool(toolset[slot - 1].id);
        return;
      }
      switch (e.key.toLowerCase()) {
        case "x":
          engineRef.current?.collapse();
          break;
        case "p":
          void saveSnapshot();
          break;
        case "r":
          engineRef.current?.clear();
          break;
        case "m":
          setSound((s) => !s);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeToolId, toolset, selectTool, onClose, saveSnapshot]);

  // 5 fixed action buttons follow the tools: collapse, snapshot, sound,
  // repair, close.
  const buttonCount = toolset.length + 5;
  const rovingIndex = Math.min(focusIndex, buttonCount - 1);

  const toolbarButtons = () =>
    Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button.dd-tool") ?? []);

  const onToolbarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = (rovingIndex - 1 + buttonCount) % buttonCount;
    else if (e.key === "ArrowRight") next = (rovingIndex + 1) % buttonCount;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttonCount - 1;
    if (next === null) return;
    e.preventDefault();
    setFocusIndex(next);
    toolbarButtons()[next]?.focus();
  };

  // Clicking or shift-tabbing onto any button re-anchors the roving tabindex.
  const onToolbarFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLButtonElement)) return;
    const index = toolbarButtons().indexOf(e.target);
    if (index >= 0) setFocusIndex(index);
  };

  const tabIndexFor = (index: number) => (index === rovingIndex ? 0 : -1);

  if (!mounted) return null;

  const activeTool = toolset.find((t) => t.id === activeToolId);
  const chip = chipFor(capture.status, capture.liveUnavailable);

  // Portal to <body>: the host app may render this inside a stacking context
  // whose z-index would trap the toolbar underneath the canvas overlay.
  return createPortal(
    <>
      {/* Persistent live region: screen readers announce the tool description
          as the selection changes; sighted users see the floating pill. */}
      <div
        className="dd-hint"
        data-dd-ignore=""
        role="status"
        aria-live="polite"
        style={{ zIndex: 2147483001 }}
      >
        {activeTool && (
          <span className="dd-hint-pill">
            {activeTool.name} — {activeTool.hint}
          </span>
        )}
      </div>

      {chip && (
        <div
          style={chipStyle}
          data-dd-ignore=""
          data-dd-capture-status={capture.status}
          role="status"
          aria-live="polite"
          title={chip.title}
        >
          {capture.status === "capturing" ? (
            <span className="dd-spinner" />
          ) : (
            <span style={{ ...dotStyle, background: chip.color }} />
          )}
          {flash ?? chip.label}
        </div>
      )}

      <div
        ref={toolbarRef}
        style={reducedMotion ? { ...barStyle, animation: "none" } : barStyle}
        role="toolbar"
        aria-label="Desktop Destroyer tools"
        aria-orientation="horizontal"
        data-dd-ignore=""
        onKeyDown={onToolbarKeyDown}
        onFocus={onToolbarFocus}
      >
        {toolset.map((tool, i) => (
          <button
            type="button"
            key={tool.id}
            className="dd-tool"
            style={buttonBase}
            data-active={tool.id === activeToolId}
            tabIndex={tabIndexFor(i)}
            title={`${tool.name} — ${tool.hint}${i < 10 ? ` (${(i + 1) % 10})` : ""}`}
            aria-label={tool.name}
            aria-pressed={tool.id === activeToolId}
            onClick={() => selectTool(tool.id)}
          >
            {artIcons[tool.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={artIcons[tool.id]}
                alt=""
                draggable={false}
                style={{ width: 30, height: 30, pointerEvents: "none" }}
              />
            ) : (
              tool.icon
            )}
          </button>
        ))}
        <div style={dividerStyle} />
        <button
          type="button"
          className="dd-tool"
          style={{ ...buttonBase, fontSize: 19 }}
          tabIndex={tabIndexFor(toolset.length)}
          title="Collapse the whole page (X)"
          aria-label="Collapse the whole page"
          onClick={() => engineRef.current?.collapse()}
        >
          💥
        </button>
        <button
          type="button"
          className="dd-tool"
          style={{ ...buttonBase, fontSize: 18 }}
          tabIndex={tabIndexFor(toolset.length + 1)}
          title="Save a picture of the wreckage (P)"
          aria-label="Save a picture of the wreckage"
          onClick={() => void saveSnapshot()}
        >
          📸
        </button>
        <button
          type="button"
          className="dd-tool"
          style={{ ...buttonBase, fontSize: 18 }}
          tabIndex={tabIndexFor(toolset.length + 2)}
          title={sound ? "Mute sound (M)" : "Enable sound (M)"}
          aria-label={sound ? "Mute sound" : "Enable sound"}
          aria-pressed={sound}
          onClick={() => setSound((s) => !s)}
        >
          {sound ? "🔊" : "🔇"}
        </button>
        <button
          type="button"
          className="dd-tool"
          style={{ ...buttonBase, fontSize: 18 }}
          tabIndex={tabIndexFor(toolset.length + 3)}
          title="Repair everything (R)"
          aria-label="Repair everything"
          onClick={() => engineRef.current?.clear()}
        >
          🩹
        </button>
        <button
          type="button"
          className="dd-tool"
          style={{ ...buttonBase, fontSize: 16, color: "rgba(255,255,255,0.8)" }}
          tabIndex={tabIndexFor(toolset.length + 4)}
          title="Close (Esc)"
          aria-label="Close Desktop Destroyer"
          onClick={() => {
            selectTool(null);
            onClose?.();
          }}
        >
          ✕
        </button>
      </div>
    </>,
    document.body,
  );
}
