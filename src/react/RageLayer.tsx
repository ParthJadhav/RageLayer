"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defaultTools } from "../default-tools";
import { DestroyerEngine } from "../engine";
import type { HistoryState } from "../history";
import { type BuiltInLoadoutId, resolveToolLoadout, type ToolLoadout } from "../loadouts";
import { copyBlobToClipboard, downloadBlob, snapshotFilename } from "../share";
import { toolIconDataUrl } from "../toolart";
import type { CaptureStatus, DestroyerOptions, Tool, ToolStyle } from "../types";
import {
  acquireStyles,
  barStyle,
  buttonBase,
  chipStyle,
  dividerStyle,
  dotStyle,
  releaseStyles,
} from "./toolbar-styles";

export interface RageLayerProps {
  /** Called when the user closes the toolbar. */
  onClose?: () => void;
  /** Extra or replacement tools. Defaults to the full built-in set. */
  tools?: Tool[];
  /** Named or custom preset. Explicit `tools` take precedence. */
  loadout?: BuiltInLoadoutId | ToolLoadout;
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
   * Expose the engine as `window.__rageLayer` for debugging, E2E tests
   * and the profiling harness (`scripts/profile-effects.mjs` waits for this
   * global on the page it drives). Default false — no globals leak into the
   * host page unless asked for.
   */
  debugGlobal?: boolean;
}

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

/** One of the fixed buttons that follow the tools in the bar. */
interface ToolbarAction {
  glyph: string;
  /** Accessible name; the glyph alone means nothing to a screen reader. */
  label: string;
  /** Keyboard shortcut, appended to the tooltip. */
  hint?: string;
  /** Tooltip, when the label alone would not do. Defaults to `label (hint)`. */
  title?: string;
  fontSize: number;
  color?: string;
  pressed?: boolean;
  disabled?: boolean;
  run(): void;
}

/** Tooltips are the accessible name plus the shortcut, unless one says otherwise. */
function actionTitle(action: ToolbarAction): string {
  if (action.title) return action.title;
  return action.hint ? `${action.label} (${action.hint})` : action.label;
}

/**
 * One toolbar button.
 *
 * Tools and the fixed actions differ only in what they show and what they do,
 * so they share this: the chrome, the roving `tabIndex`, and the disabled
 * treatment (dimmed and `aria-disabled`, never `disabled` — a removed button
 * would silently renumber the roving tabindex under the user's fingers).
 */
function ToolbarButton({
  tabIndex,
  title,
  label,
  onSelect,
  children,
  active,
  pressed,
  disabled,
  style,
}: {
  tabIndex: number;
  title: string;
  label: string;
  onSelect: () => void;
  children: React.ReactNode;
  active?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      className="rl-tool"
      style={{ ...buttonBase, ...style, ...(disabled ? { opacity: 0.35 } : null) }}
      data-active={active}
      tabIndex={tabIndex}
      title={title}
      aria-label={label}
      aria-pressed={pressed}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      {children}
    </button>
  );
}

/** True when the key event started in a place where the user is typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/**
 * Drop-in RageLayer: mounts the canvas engine, renders the bottom
 * toolbar, and cleans everything up on unmount. Purely additive to the host
 * page — no styles leak in or out.
 */
export function RageLayer({
  onClose,
  tools,
  loadout,
  engineOptions,
  soundDefault = false,
  toolStyle = "3d",
  debugGlobal = false,
}: RageLayerProps) {
  const engineRef = useRef<DestroyerEngine | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [sound, setSound] = useState(soundDefault);
  const [capture, setCapture] = useState<{ status: CaptureStatus; liveUnavailable: boolean }>({
    status: "idle",
    liveUnavailable: false,
  });
  const [historyState, setHistoryState] = useState<HistoryState>({
    canUndo: false,
    canRedo: false,
    undoDepth: 0,
    redoDepth: 0,
  });
  const [flash, setFlash] = useState<string | null>(null);
  // SSR guard: the portal target (document.body) only exists in the browser,
  // so the first render — including the server one — produces nothing and the
  // real UI appears after mount. Consumers don't need `ssr: false` tricks.
  const [mounted, setMounted] = useState(false);
  // Sampled once at mount: the explicit engine option or OS-level preference
  // turns off the toolbar rise animation (hover motion is handled in CSS).
  const [reducedMotion] = useState(() => {
    if (engineOptions?.reducedMotion === true) return true;
    if (engineOptions?.reducedMotion === false) return false;
    return (
      typeof window !== "undefined" &&
      (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
    );
  });
  // Roving tabindex for the toolbar: exactly one button is tabbable, arrows
  // move focus within the bar.
  const [focusIndex, setFocusIndex] = useState(0);
  const flashTimerRef = useRef<number | null>(null);
  const toolset = useMemo(
    () => tools ?? (loadout ? resolveToolLoadout(loadout) : defaultTools),
    [tools, loadout],
  );
  const historyEnabled = engineOptions?.history !== undefined && engineOptions.history !== false;
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
    const debugWindow = window as unknown as { __rageLayer?: DestroyerEngine };
    if (debugGlobal) debugWindow.__rageLayer = engine;
    // The engine starts capturing inside its own constructor, so seed from it
    // rather than waiting for the first event.
    const sync = () =>
      setCapture({ status: engine.captureStatus, liveUnavailable: engine.liveUnavailable });
    sync();
    const off = engine.on("statuschange", sync);
    const syncHistory = () => setHistoryState(engine.historyState);
    syncHistory();
    const offHistory = engine.on("historychange", syncHistory);
    return () => {
      off();
      offHistory();
      engine.dispose();
      if (debugWindow.__rageLayer === engine) delete debugWindow.__rageLayer;
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
    toolbarRef.current?.querySelector<HTMLButtonElement>("button.rl-tool")?.focus();
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
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z" && historyEnabled) {
        e.preventDefault();
        if (e.shiftKey) engineRef.current?.redo();
        else engineRef.current?.undo();
        return;
      }
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
  }, [activeToolId, toolset, selectTool, onClose, saveSnapshot, historyEnabled]);

  // Everything after the tools: the optional history pair, then the fixed
  // actions. Declared as data so the roving tabindex is derived from position
  // rather than from hand-maintained offsets.
  const actions: ToolbarAction[] = [
    ...(historyEnabled
      ? ([
          {
            glyph: "↶",
            label: "Undo destruction",
            hint: "Cmd/Ctrl+Z",
            fontSize: 20,
            disabled: !historyState.canUndo,
            run: () => engineRef.current?.undo(),
          },
          {
            glyph: "↷",
            label: "Redo destruction",
            hint: "Cmd/Ctrl+Shift+Z",
            fontSize: 20,
            disabled: !historyState.canRedo,
            run: () => engineRef.current?.redo(),
          },
        ] satisfies ToolbarAction[])
      : []),
    {
      glyph: "💥",
      label: "Collapse the whole page",
      hint: "X",
      fontSize: 19,
      run: () => engineRef.current?.collapse(),
    },
    {
      glyph: "📸",
      label: "Save a picture of the wreckage",
      hint: "P",
      fontSize: 18,
      run: () => void saveSnapshot(),
    },
    {
      glyph: sound ? "🔊" : "🔇",
      label: sound ? "Mute sound" : "Enable sound",
      hint: "M",
      fontSize: 18,
      pressed: sound,
      run: () => setSound((s) => !s),
    },
    {
      glyph: "🩹",
      label: "Repair everything",
      hint: "R",
      fontSize: 18,
      run: () => engineRef.current?.clear(),
    },
    {
      glyph: "✕",
      label: "Close RageLayer",
      title: "Close (Esc)",
      fontSize: 16,
      color: "rgba(255,255,255,0.8)",
      run: () => {
        selectTool(null);
        onClose?.();
      },
    },
  ];
  const buttonCount = toolset.length + actions.length;
  const rovingIndex = Math.min(focusIndex, buttonCount - 1);

  const toolbarButtons = () =>
    Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button.rl-tool") ?? []);

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
        className="rl-hint"
        data-ragelayer-ignore=""
        role="status"
        aria-live="polite"
        style={{ zIndex: 2147483001 }}
      >
        {activeTool && (
          <span className="rl-hint-pill">
            {activeTool.name} — {activeTool.hint}
          </span>
        )}
      </div>

      {chip && (
        <div
          style={chipStyle}
          data-ragelayer-ignore=""
          data-ragelayer-capture-status={capture.status}
          role="status"
          aria-live="polite"
          title={chip.title}
        >
          {capture.status === "capturing" ? (
            <span className="rl-spinner" />
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
        aria-label="RageLayer tools"
        aria-orientation="horizontal"
        data-ragelayer-ignore=""
        onKeyDown={onToolbarKeyDown}
        onFocus={onToolbarFocus}
      >
        {toolset.map((tool, i) => (
          <ToolbarButton
            key={tool.id}
            tabIndex={tabIndexFor(i)}
            title={`${tool.name} — ${tool.hint}${i < 10 ? ` (${(i + 1) % 10})` : ""}`}
            label={tool.name}
            active={tool.id === activeToolId}
            pressed={tool.id === activeToolId}
            onSelect={() => selectTool(tool.id)}
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
          </ToolbarButton>
        ))}
        <div style={dividerStyle} />
        {actions.map((action, i) => (
          <ToolbarButton
            key={action.label}
            tabIndex={tabIndexFor(toolset.length + i)}
            title={actionTitle(action)}
            label={action.label}
            pressed={action.pressed}
            disabled={action.disabled}
            style={{ fontSize: action.fontSize, color: action.color }}
            onSelect={action.run}
          >
            {action.glyph}
          </ToolbarButton>
        ))}
      </div>
    </>,
    document.body,
  );
}
