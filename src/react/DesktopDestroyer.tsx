"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DestroyerEngine } from "../engine";
import { defaultTools } from "../tools";
import type { CaptureStatus, DestroyerOptions, Tool } from "../types";

export interface DesktopDestroyerProps {
  /** Called when the user closes the toolbar. */
  onClose?: () => void;
  /** Extra or replacement tools. Defaults to the full built-in set. */
  tools?: Tool[];
  /** Engine options (zIndex, caps, target element). */
  engineOptions?: DestroyerOptions;
  /** Start with sound on. Default false — visitors get to opt in. */
  soundDefault?: boolean;
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
  gap: 4,
  padding: "8px 10px",
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
  overflowX: "auto",
};

const buttonBase: React.CSSProperties = {
  appearance: "none",
  border: "1px solid transparent",
  background: "transparent",
  borderRadius: 12,
  width: 46,
  height: 46,
  fontSize: 24,
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
  bottom: 76,
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
    return { label: "Capturing page…", color: "", title: "Rasterizing the page into the destructible canvas." };
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
  height: 30,
  background: "rgba(255,255,255,0.15)",
  margin: "0 4px",
  flexShrink: 0,
};

const KEYFRAMES = `
@keyframes dd-rise {
  from { opacity: 0; transform: translateX(-50%) translateY(24px) scale(0.92); }
  to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
}
.dd-tool:hover { background: rgba(255,255,255,0.10); transform: translateY(-2px); }
.dd-tool:active { transform: translateY(0) scale(0.92); }
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
  position: absolute;
  /* Clears the capture-status chip, which sits at 76px. */
  bottom: 110px;
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: 999px;
  background: rgba(18,17,16,0.85);
  border: 1px solid rgba(255,255,255,0.12);
  color: rgba(255,255,255,0.85);
  font-size: 12px;
  letter-spacing: 0.02em;
  white-space: nowrap;
  pointer-events: none;
}
`;

/**
 * Drop-in Desktop Destroyer: mounts the canvas engine, renders the bottom
 * toolbar, and cleans everything up on unmount. Purely additive to the host
 * page — no styles leak in or out.
 */
export function DesktopDestroyer({ onClose, tools, engineOptions, soundDefault = false }: DesktopDestroyerProps) {
  const engineRef = useRef<DestroyerEngine | null>(null);
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [sound, setSound] = useState(soundDefault);
  const [capture, setCapture] = useState<{ status: CaptureStatus; liveUnavailable: boolean }>({
    status: "idle",
    liveUnavailable: false,
  });
  const toolset = useMemo(() => tools ?? defaultTools, [tools]);

  useEffect(() => {
    const engine = new DestroyerEngine({ soundEnabled: soundDefault, ...engineOptions });
    for (const tool of toolset) engine.registerTool(tool);
    engineRef.current = engine;
    // Debug/testing handle — lets host pages and E2E tests poke the engine.
    (window as unknown as { __desktopDestroyer?: DestroyerEngine }).__desktopDestroyer = engine;
    // The engine starts capturing inside its own constructor, so seed from it
    // rather than waiting for the first event.
    const sync = () =>
      setCapture({ status: engine.captureStatus, liveUnavailable: engine.liveUnavailable });
    sync();
    const off = engine.on("statuschange", sync);
    return () => {
      off();
      engine.dispose();
      engineRef.current = null;
    };
    // The engine intentionally mounts once; tool/option changes need a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setSound(sound);
  }, [sound]);

  const selectTool = (id: string | null) => {
    const next = id === activeToolId ? null : id;
    engineRef.current?.setTool(next);
    setActiveToolId(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (activeToolId) selectTool(null);
        else onClose?.();
      }
      // 1-9 select tools.
      const n = Number(e.key);
      if (n >= 1 && n <= toolset.length) selectTool(toolset[n - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeToolId, toolset]);

  const activeTool = toolset.find((t) => t.id === activeToolId);
  const chip = chipFor(capture.status, capture.liveUnavailable);

  // Portal to <body>: the host app may render this inside a stacking context
  // whose z-index would trap the toolbar underneath the canvas overlay.
  return createPortal(
    <>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      {activeTool && (
        <div className="dd-hint" data-dd-ignore="" style={{ position: "fixed", zIndex: 2147483001 }}>
          {activeTool.name} — {activeTool.hint}
        </div>
      )}
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
          {chip.label}
        </div>
      )}
      <div style={barStyle} role="toolbar" aria-label="Desktop Destroyer tools" data-dd-ignore="">
        {toolset.map((tool) => (
          <button
            key={tool.id}
            className="dd-tool"
            style={buttonBase}
            data-active={tool.id === activeToolId}
            title={`${tool.name} — ${tool.hint}`}
            aria-label={tool.name}
            aria-pressed={tool.id === activeToolId}
            onClick={() => selectTool(tool.id)}
          >
            {tool.icon}
          </button>
        ))}
        <div style={dividerStyle} />
        <button
          className="dd-tool"
          style={{ ...buttonBase, fontSize: 19 }}
          title={sound ? "Mute sound" : "Enable sound"}
          aria-label={sound ? "Mute sound" : "Enable sound"}
          onClick={() => setSound((s) => !s)}
        >
          {sound ? "🔊" : "🔇"}
        </button>
        <button
          className="dd-tool"
          style={{ ...buttonBase, fontSize: 19 }}
          title="Repair everything"
          aria-label="Repair everything"
          onClick={() => engineRef.current?.clear()}
        >
          🩹
        </button>
        <button
          className="dd-tool"
          style={{ ...buttonBase, fontSize: 17, color: "rgba(255,255,255,0.8)" }}
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
