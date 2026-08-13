/**
 * The toolbar, without a view layer.
 *
 * Everything a destroyer toolbar has to get right — the button list, the
 * capture-status chip, keyboard shortcuts that don't fire while the visitor is
 * typing, roving focus, keyboard aiming for people who can't use a pointer,
 * snapshot export — is behaviour, not markup. Keeping it here means the React
 * component, the Vue component and the custom element are all thin renderers
 * of the same state rather than three re-implementations that drift, and it
 * means a host writing its own toolbar gets the behaviour for free.
 *
 * The model owns no DOM. It reads and drives an engine, and notifies
 * subscribers whenever anything a view would render has changed.
 */

import type { DestroyerEngine } from "./engine";
import { copyBlobToClipboard, downloadBlob, snapshotFilename } from "./share";
import { type DestroyerStrings, formatString, resolveStrings, toolStrings } from "./strings";
import { toolIconDataUrl } from "./toolart";
import { TOOLBAR_ICONS } from "./toolbar-icons";
import type { CaptureStatus, Tool, ToolStyle } from "./types";

export interface ToolbarButton {
  kind: "tool" | "action";
  /** Tool id, or a stable action name like `"undo"`. */
  id: string;
  /** Accessible name. A glyph on its own means nothing to a screen reader. */
  label: string;
  /** Tooltip text. */
  title: string;
  /** SVG path data for actions, drawn in `currentColor` on a 24×24 grid. */
  iconPath?: string;
  /** Rendered icon for tools, or null when the tool has no drawn art. */
  icon?: string | null;
  /** Fallback glyph for a tool without drawn art. */
  toolIcon?: string;
  pressed?: boolean;
  disabled?: boolean;
  color?: string;
  run(): void;
}

export interface ToolbarStatusChip {
  label: string;
  title: string;
  /** Dot colour, or "" while capturing (the view animates that state). */
  color: string;
}

export interface ToolbarState {
  /** Accessible name for the toolbar container. */
  toolbarLabel: string;
  buttons: readonly ToolbarButton[];
  activeToolId: string | null;
  /** Index of the single tabbable button (roving tabindex). */
  focusIndex: number;
  /** Visible instruction for the focused or hovered control. */
  hint: string | null;
  status: ToolbarStatusChip | null;
  /** Transient confirmation, e.g. after a snapshot. */
  flash: string | null;
  soundEnabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Keyboard aiming position in document coordinates, or null when off. */
  aim: { x: number; y: number } | null;
  /** Live-region text; changes are announced to assistive technology. */
  announcement: string;
}

export interface ToolbarModelOptions {
  /** Tools to show. Defaults to the engine's registered tools. */
  tools?: readonly Tool[];
  /** Overridden or translated user-visible strings. */
  strings?: Partial<DestroyerStrings>;
  /** Match toolbar icons to the engine's pointer-art style. */
  toolStyle?: ToolStyle;
  /** Called by the close action and by Escape with no tool selected. */
  onClose?(): void;
  /** How far one arrow-key press moves the keyboard aim, in CSS px. */
  aimStep?: number;
  /** Milliseconds a keyboard strike holds the tool down. */
  strikeHoldMs?: number;
}

const FLASH_MS = 1800;

/** Fields that must not swallow single-key shortcuts. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export class ToolbarModel {
  private readonly engine: DestroyerEngine;
  private readonly options: ToolbarModelOptions;
  private readonly strings: DestroyerStrings;
  private readonly listeners = new Set<(state: ToolbarState) => void>();
  private readonly detachers: (() => void)[] = [];
  private readonly iconCache = new Map<string, string | null>();

  private flash: string | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private focusIndex = 0;
  private aim: { x: number; y: number } | null = null;
  private announcement = "";
  private destroyed = false;
  private cached: ToolbarState | null = null;

  constructor(engine: DestroyerEngine, options: ToolbarModelOptions = {}) {
    this.engine = engine;
    this.options = options;
    this.strings = resolveStrings(options.strings);

    // Every engine event that changes something a toolbar renders.
    for (const event of ["toolchange", "statuschange", "historychange", "clear"] as const) {
      this.detachers.push(engine.on(event, () => this.invalidate()));
    }
    this.detachers.push(engine.on("dispose", () => this.destroy()));
  }

  get state(): ToolbarState {
    if (!this.cached) this.cached = this.build();
    return this.cached;
  }

  /** Subscribe to state changes. The callback runs immediately. */
  subscribe(listener: (state: ToolbarState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private invalidate() {
    if (this.destroyed) return;
    this.cached = null;
    const next = this.state;
    for (const listener of this.listeners) listener(next);
  }

  private get tools(): readonly Tool[] {
    return this.options.tools ?? this.engine.getTools();
  }

  selectTool(id: string | null) {
    // Selecting the active tool again puts it away, which is what makes a
    // single button behave like a toggle.
    this.engine.setTool(id === this.engine.tool?.id ? null : id);
  }

  setSound(enabled: boolean) {
    this.engine.setSound(enabled);
    this.invalidate();
  }

  /** Move the roving tabindex. Views call this from arrow keys on the bar. */
  setFocusIndex(index: number) {
    const count = this.state.buttons.length;
    if (count === 0) return;
    const next = ((index % count) + count) % count;
    if (next === this.focusIndex) return;
    this.focusIndex = next;
    this.invalidate();
  }

  // ── Keyboard aiming ───────────────────────────────────────────────────────

  /**
   * Aiming mode is what makes the toy usable without a pointing device. The
   * cursor starts at the middle of the visible page rather than at the origin,
   * so the first strike lands on content the visitor can see.
   */
  startAiming() {
    if (this.aim) return;
    this.aim = {
      x: Math.round(window.scrollX + window.innerWidth / 2),
      y: Math.round(window.scrollY + window.innerHeight / 2),
    };
    this.engine.setAim(this.aim);
    this.announce(this.strings.keyboardCursorHint);
    this.invalidate();
  }

  stopAiming() {
    if (!this.aim) return;
    this.aim = null;
    this.engine.setAim(null);
    this.invalidate();
  }

  moveAim(dx: number, dy: number) {
    if (!this.aim) this.startAiming();
    if (!this.aim) return;
    const step = this.options.aimStep ?? 40;
    this.aim = {
      x: clamp(this.aim.x + dx * step, 0, this.engine.width),
      y: clamp(this.aim.y + dy * step, 0, this.engine.height),
    };
    this.engine.setAim(this.aim);
    // Keep the cursor on screen as it walks off the viewport, or arrowing
    // downward silently aims at page the visitor cannot see.
    scrollAimIntoView(this.aim);
    this.announce(formatString(this.strings.keyboardMoved, { x: this.aim.x, y: this.aim.y }));
    this.invalidate();
  }

  /** Use the selected tool at the keyboard cursor. */
  strikeAtAim(): boolean {
    if (!this.aim || !this.engine.tool) return false;
    const used = this.engine.strike(this.aim.x, this.aim.y, {
      holdMs: this.options.strikeHoldMs ?? 260,
    });
    if (used) {
      const { name } = toolStrings(this.strings, this.engine.tool);
      this.announce(
        formatString(this.strings.keyboardStruck, { tool: name, x: this.aim.x, y: this.aim.y }),
      );
      // Using a tool changes no engine event on its own, so the announcement
      // has to be published explicitly or the live region never updates.
      this.invalidate();
    }
    return used;
  }

  private announce(message: string) {
    // Repeating identical text is not re-announced by screen readers, so a
    // zero-width space is appended to force a change when it repeats.
    this.announcement = message === this.announcement ? `${message}​` : message;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /** Flatten the wreckage to PNG: clipboard where allowed, otherwise download. */
  async saveSnapshot(): Promise<void> {
    const blob = await this.engine.snapshot();
    if (!blob || this.destroyed) return;
    if (await copyBlobToClipboard(blob)) this.setFlash(this.strings.copiedToClipboard);
    else {
      downloadBlob(blob, snapshotFilename());
      this.setFlash(this.strings.saved);
    }
  }

  private setFlash(message: string) {
    this.flash = message;
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      this.flash = null;
      this.invalidate();
    }, FLASH_MS);
    this.invalidate();
  }

  /**
   * Handle a global shortcut. Returns true when the event was consumed, so a
   * view knows whether to `preventDefault()`.
   */
  handleKeyDown(event: KeyboardEvent): boolean {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "z") {
      // Undo is only bound when history is actually enabled, so Cmd/Ctrl+Z
      // keeps its normal meaning on a page that never opted in.
      if (!this.engine.historyEnabled) return false;
      if (event.shiftKey) this.engine.redo();
      else this.engine.undo();
      return true;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    // No single-key shortcuts while the visitor is typing, mid-IME
    // composition, or holding a key down — otherwise "r" in a search box
    // repairs the page.
    if (event.isComposing || event.repeat || isTypingTarget(event.target)) return false;

    if (this.aim) {
      switch (event.key) {
        case "ArrowLeft":
          this.moveAim(-1, 0);
          return true;
        case "ArrowRight":
          this.moveAim(1, 0);
          return true;
        case "ArrowUp":
          this.moveAim(0, -1);
          return true;
        case "ArrowDown":
          this.moveAim(0, 1);
          return true;
        case "Enter":
        case " ":
          this.strikeAtAim();
          return true;
        case "Escape":
          this.stopAiming();
          return true;
      }
    }

    if (event.key === "Escape") {
      if (this.engine.tool) this.selectTool(null);
      else this.options.onClose?.();
      return true;
    }

    // Digits pick tools: 1–9 then 0 for the tenth. Beyond that is out of reach
    // by keyboard, which is fine — those are the exotic ones.
    const slot = event.key === "0" ? 10 : Number(event.key);
    const tools = this.tools;
    if (Number.isInteger(slot) && slot >= 1 && slot <= Math.min(10, tools.length)) {
      this.selectTool(tools[slot - 1].id);
      return true;
    }

    switch (event.key.toLowerCase()) {
      case "x":
        this.engine.collapse();
        return true;
      case "p":
        void this.saveSnapshot();
        return true;
      case "r":
        this.engine.clear();
        return true;
      case "m":
        this.setSound(!this.engine.sound.enabled);
        return true;
      case "a":
        // Aiming is only useful once a tool is in hand.
        if (!this.engine.tool) return false;
        this.startAiming();
        return true;
    }
    return false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const detach of this.detachers) detach();
    this.detachers.length = 0;
    if (this.flashTimer !== null) clearTimeout(this.flashTimer);
    this.flashTimer = null;
    this.listeners.clear();
  }

  // ── Derived state ─────────────────────────────────────────────────────────

  private icon(tool: Tool): string | null {
    if (this.options.toolStyle === "emoji") return null;
    if (!tool.art) return null;
    let url = this.iconCache.get(tool.id);
    if (url === undefined) {
      url = toolIconDataUrl(tool.art, 30) || null;
      this.iconCache.set(tool.id, url);
    }
    return url;
  }

  private statusChip(): ToolbarStatusChip | null {
    const status: CaptureStatus = this.engine.captureStatus;
    const s = this.strings;
    if (status === "capturing") {
      return { label: s.capturing, color: "", title: s.capturingTitle };
    }
    if (status === "live") {
      return { label: s.live, color: "rgb(74, 222, 128)", title: s.liveTitle };
    }
    if (status === "snapshot") {
      return this.engine.liveUnavailable
        ? {
            label: s.snapshotLiveUnavailable,
            color: "rgba(255,255,255,0.45)",
            title: s.snapshotLiveUnavailableTitle,
          }
        : {
            label: s.snapshotMode,
            color: "rgba(255,255,255,0.45)",
            title: s.snapshotModeTitle,
          };
    }
    return null;
  }

  private build(): ToolbarState {
    const s = this.strings;
    const engine = this.engine;
    const activeToolId = engine.tool?.id ?? null;
    const history = engine.historyState;
    const soundEnabled = engine.sound.enabled;

    const buttons: ToolbarButton[] = this.tools.map((tool, index) => {
      const { name, hint } = toolStrings(s, tool);
      return {
        kind: "tool",
        id: tool.id,
        label: name,
        // The digit shortcut belongs in the tooltip, not the accessible name.
        title: index < 10 ? `${name} — ${hint} (${(index + 1) % 10})` : `${name} — ${hint}`,
        icon: this.icon(tool),
        toolIcon: tool.icon,
        pressed: tool.id === activeToolId,
        run: () => this.selectTool(tool.id),
      };
    });

    if (engine.historyEnabled) {
      buttons.push(
        {
          kind: "action",
          id: "undo",
          iconPath: TOOLBAR_ICONS.undo,
          label: s.undo,
          title: `${s.undo} (${s.undoHint})`,
          disabled: !history.canUndo,
          run: () => engine.undo(),
        },
        {
          kind: "action",
          id: "redo",
          iconPath: TOOLBAR_ICONS.redo,
          label: s.redo,
          title: `${s.redo} (${s.redoHint})`,
          disabled: !history.canRedo,
          run: () => engine.redo(),
        },
      );
    }

    buttons.push(
      {
        kind: "action",
        id: "collapse",
        iconPath: TOOLBAR_ICONS.collapse,
        label: s.collapse,
        title: `${s.collapse} (X)`,
        run: () => engine.collapse(),
      },
      {
        kind: "action",
        id: "snapshot",
        iconPath: TOOLBAR_ICONS.snapshot,
        label: s.snapshot,
        title: `${s.snapshot} (P)`,
        run: () => void this.saveSnapshot(),
      },
      {
        kind: "action",
        id: "sound",
        iconPath: soundEnabled ? TOOLBAR_ICONS.soundOn : TOOLBAR_ICONS.soundOff,
        label: soundEnabled ? s.muteSound : s.enableSound,
        title: `${soundEnabled ? s.muteSound : s.enableSound} (M)`,
        pressed: soundEnabled,
        run: () => this.setSound(!soundEnabled),
      },
      {
        kind: "action",
        id: "repair",
        iconPath: TOOLBAR_ICONS.repair,
        label: s.repair,
        title: `${s.repair} (R)`,
        run: () => engine.clear(),
      },
      {
        kind: "action",
        id: "aim",
        iconPath: TOOLBAR_ICONS.aim,
        label: s.keyboardCursor,
        title: `${s.keyboardCursor} (A)`,
        pressed: this.aim !== null,
        disabled: activeToolId === null,
        run: () => (this.aim ? this.stopAiming() : this.startAiming()),
      },
      {
        kind: "action",
        id: "close",
        iconPath: TOOLBAR_ICONS.close,
        label: s.close,
        title: s.closeTitle,
        color: "rgba(255,255,255,0.8)",
        run: () => {
          this.selectTool(null);
          this.options.onClose?.();
        },
      },
    );

    const focusIndex = Math.min(this.focusIndex, Math.max(0, buttons.length - 1));
    return {
      toolbarLabel: s.toolbarLabel,
      buttons,
      activeToolId,
      focusIndex,
      hint: buttons[focusIndex]?.title ?? null,
      status: this.statusChip(),
      flash: this.flash,
      soundEnabled,
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      aim: this.aim,
      announcement: this.announcement,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Scroll the page so the keyboard cursor stays comfortably inside the viewport. */
function scrollAimIntoView({ x, y }: { x: number; y: number }, margin = 80) {
  const top = window.scrollY;
  const bottom = top + window.innerHeight;
  const left = window.scrollX;
  const right = left + window.innerWidth;
  let nextY = top;
  let nextX = left;
  if (y < top + margin) nextY = Math.max(0, y - margin);
  else if (y > bottom - margin) nextY = y + margin - window.innerHeight;
  if (x < left + margin) nextX = Math.max(0, x - margin);
  else if (x > right - margin) nextX = x + margin - window.innerWidth;
  if (nextX !== left || nextY !== top) window.scrollTo({ left: nextX, top: nextY });
}
