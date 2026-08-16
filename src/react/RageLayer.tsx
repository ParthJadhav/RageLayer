"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { defaultTools } from "../default-tools";
import { RageLayerEngine } from "../engine";
import type { RageLayerStrings } from "../strings";
import { type ToolbarButton as ButtonState, ToolbarModel, type ToolbarState } from "../toolbar";
import type { RageLayerEngineOptions, Tool, ToolStyle } from "../types";
import {
  acquireStyles,
  barStyle,
  buttonBase,
  chipStyle,
  dividerStyle,
  dotStyle,
  hostStyle,
  releaseStyles,
} from "./toolbar-styles";

export interface RageLayerProps {
  /** Called when the user closes the toolbar. */
  onClose?: () => void;
  /** Extra or replacement tools. Defaults to the full built-in set. */
  tools?: Tool[];
  /** Engine options (zIndex, caps, physics, post-FX, target element). */
  engineOptions?: RageLayerEngineOptions;
  /** Overridden or translated user-visible strings. */
  strings?: Partial<RageLayerStrings>;
  /** Start with sound on. Default false — visitors get to opt in. */
  soundDefault?: boolean;
  /** Drawn tool art (default) or classic emoji cursors and toolbar icons. */
  toolStyle?: ToolStyle;
  /** Expose the engine as `window.__rageLayer` for profiling and E2E tests. */
  debugGlobal?: boolean;
}

/** One toolbar button, shared by tool and action state from `ToolbarModel`. */
function ToolbarButton({
  button,
  tabIndex,
  active,
  onSelect,
  onPreview,
  children,
}: {
  button: ButtonState;
  tabIndex: number;
  active: boolean;
  onSelect: () => void;
  onPreview: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="rl-tool"
      style={{
        ...buttonBase,
        ...(button.color ? { color: button.color } : null),
        // Dim the ink, not the whole button: an opacity wash over the dark bar
        // left undo and redo close to invisible.
        ...(button.disabled ? { color: "rgba(255,255,255,0.26)", cursor: "default" } : null),
      }}
      data-active={active}
      tabIndex={tabIndex}
      title={button.title}
      aria-label={button.label}
      aria-pressed={button.pressed}
      {...(button.disabled ? { "aria-disabled": true } : {})}
      onClick={() => {
        if (!button.disabled) onSelect();
      }}
      onFocus={onPreview}
      onPointerEnter={onPreview}
      onPointerDown={onPreview}
    >
      {children}
    </button>
  );
}

const srOnlyStyle: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};

/**
 * Drop-in RageLayer: mounts the engine and renders `ToolbarModel` through
 * React. Vue, the custom element, and this component therefore expose the
 * same tools, actions, shortcuts, aiming mode, hints and translated strings.
 */
export function RageLayer({
  onClose,
  tools,
  engineOptions,
  strings,
  soundDefault = false,
  toolStyle = "3d",
  debugGlobal = false,
}: RageLayerProps) {
  const engineRef = useRef<RageLayerEngine | null>(null);
  const modelRef = useRef<ToolbarModel | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ToolbarState | null>(null);
  const [reducedMotion] = useState(() => {
    if (engineOptions?.reducedMotion === true) return true;
    if (engineOptions?.reducedMotion === false) return false;
    return (
      typeof window !== "undefined" &&
      (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
    );
  });
  const toolset = useMemo(() => tools ?? defaultTools, [tools]);
  const resolvedToolStyle = engineOptions?.toolStyle ?? toolStyle;

  useEffect(() => {
    const engine = new RageLayerEngine({
      soundEnabled: soundDefault,
      ...engineOptions,
      toolStyle: resolvedToolStyle,
    });
    for (const tool of toolset) engine.registerTool(tool);

    const model = new ToolbarModel(engine, {
      tools: toolset,
      strings,
      toolStyle: resolvedToolStyle,
      onClose,
    });
    engineRef.current = engine;
    modelRef.current = model;
    acquireStyles();

    const unsubscribe = model.subscribe(setState);
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (model.handleKeyDown(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onWindowKeyDown);

    const debugWindow = window as unknown as { __rageLayer?: RageLayerEngine };
    if (debugGlobal) debugWindow.__rageLayer = engine;

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      unsubscribe();
      model.destroy();
      engine.dispose();
      if (debugWindow.__rageLayer === engine) delete debugWindow.__rageLayer;
      releaseStyles();
      modelRef.current = null;
      engineRef.current = null;
    };
    // Engine options intentionally apply at mount. Change the component key to
    // replace a running destruction session with a different configuration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = state !== null;
  useEffect(() => {
    if (!ready) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    toolbarRef.current?.querySelector<HTMLButtonElement>("button.rl-tool")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [ready]);

  if (!state) return null;

  const buttons = () =>
    Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button.rl-tool") ?? []);

  const onToolbarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const count = state.buttons.length;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = state.focusIndex - 1;
    else if (event.key === "ArrowRight") next = state.focusIndex + 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    if (next === null || count === 0) return;

    event.preventDefault();
    // When aiming is active, arrows inside the toolbar still navigate the
    // toolbar; only global arrows steer the canvas cursor.
    event.stopPropagation();
    const normalized = ((next % count) + count) % count;
    modelRef.current?.setFocusIndex(normalized);
    buttons()[normalized]?.focus();
  };

  const chip = state.status;
  const statusText = state.flash ?? chip?.label;

  return createPortal(
    <div style={hostStyle} data-ragelayer-ignore="">
      <div className="rl-hint" data-ragelayer-ignore="" role="status" aria-live="polite">
        <span className="rl-hint-pill">{state.hint}</span>
      </div>

      {/* Movement and strike announcements are separate from the visible
          guide so coordinates do not replace its concise instruction. */}
      <div style={srOnlyStyle} role="status" aria-live="polite">
        {state.announcement}
      </div>

      {statusText && (
        <div
          style={chipStyle}
          data-ragelayer-ignore=""
          {...(chip ? { "data-ragelayer-capture-status": engineRef.current?.captureStatus } : {})}
          role="status"
          aria-live="polite"
          title={chip?.title}
        >
          {chip &&
            (chip.color ? (
              <span style={{ ...dotStyle, background: chip.color }} />
            ) : (
              <span className="rl-spinner" />
            ))}
          {statusText}
        </div>
      )}

      <div
        ref={toolbarRef}
        className="rl-toolbar-bar"
        style={reducedMotion ? { ...barStyle, animation: "none" } : barStyle}
        role="toolbar"
        aria-label={state.toolbarLabel}
        aria-orientation="horizontal"
        data-ragelayer-ignore=""
        onKeyDown={onToolbarKeyDown}
      >
        {state.buttons.map((button, index) => {
          const previous = state.buttons[index - 1];
          const startsActions = previous?.kind === "tool" && button.kind === "action";
          return (
            <Fragment key={`${button.kind}:${button.id}`}>
              {startsActions && <div style={dividerStyle} />}
              <ToolbarButton
                button={button}
                tabIndex={index === state.focusIndex ? 0 : -1}
                active={button.kind === "tool" && button.id === state.activeToolId}
                onSelect={button.run}
                onPreview={() => modelRef.current?.setFocusIndex(index)}
              >
                {button.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={button.icon}
                    alt=""
                    draggable={false}
                    style={{ width: 28, height: 28, pointerEvents: "none" }}
                  />
                ) : button.iconPath ? (
                  <svg
                    viewBox="0 0 24 24"
                    width={22}
                    height={22}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    focusable="false"
                    style={{ pointerEvents: "none" }}
                  >
                    <path d={button.iconPath} />
                  </svg>
                ) : (
                  button.toolIcon
                )}
              </ToolbarButton>
            </Fragment>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
