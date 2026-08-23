import type { PointerInputController, PointerInputHost } from "./pointer-input-host";
import type { ToolPointerEvent, Vec2 } from "./types";

/**
 * Maximum pointer positions retained between rendered frames. Real pointers
 * deliver only a handful; after this, overwriting the newest slot preserves
 * total displacement without letting an event storm allocate indefinitely.
 */
const POINTER_RING_CAP = 32;
const PARKED_POINTER = -1000;

/**
 * Own the complete pointer gesture lifecycle for an engine.
 *
 * Rendering and simulation consume `pointer`, `held`, and the art timestamps;
 * browser event binding, pointer capture, move coalescing, and tool dispatch do
 * not need to leak into the engine's composition root.
 */
export function createPointerInput(host: PointerInputHost): PointerInputController {
  const pointer: Vec2 = { x: PARKED_POINTER, y: PARKED_POINTER };
  const previous: Vec2 = { x: PARKED_POINTER, y: PARKED_POINTER };
  const pendingMoves: { x: number; y: number; buttons: number }[] = [];
  const moveScratch: ToolPointerEvent = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0 };
  let pendingMoveCount = 0;
  let activePointerId: number | null = null;
  let held = false;
  let artDownAt = -Infinity;
  let artUpAt = -Infinity;

  const controller: PointerInputController = {
    pointer,
    get held() {
      return held;
    },
    get artDownAt() {
      return artDownAt;
    },
    get artUpAt() {
      return artUpAt;
    },
    dispose,
    flush,
    end,
    cancel,
    strike,
  };

  const { container } = host;
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);
  container.addEventListener("pointerleave", onPointerLeave);
  container.addEventListener("contextmenu", onContextMenu);

  return controller;

  function dispose() {
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    container.removeEventListener("pointerleave", onPointerLeave);
    container.removeEventListener("contextmenu", onContextMenu);
    pendingMoveCount = 0;
    held = false;
    releasePointerCapture();
  }

  /** Replay buffered positions through the tool that is active at flush time. */
  function flush() {
    const count = pendingMoveCount;
    if (count === 0) return;
    pendingMoveCount = 0;
    const tool = host.getTool();
    for (let i = 0; i < count; i++) {
      const move = pendingMoves[i];
      moveScratch.x = move.x;
      moveScratch.y = move.y;
      moveScratch.dx = previous.x < -100 ? 0 : move.x - previous.x;
      moveScratch.dy = previous.y < -100 ? 0 : move.y - previous.y;
      moveScratch.buttons = move.buttons;
      previous.x = move.x;
      previous.y = move.y;
      tool?.onMove?.(host.engine, moveScratch);
    }
  }

  /** Complete a real gesture and invoke the tool's release action. */
  function end(event?: PointerEvent) {
    if (!held) return;
    if (event && activePointerId !== null && event.pointerId !== activePointerId) return;
    flush();
    held = false;
    artUpAt = host.nowSeconds();
    const toolEvent = event ? toToolEvent(event) : { ...pointer, dx: 0, dy: 0, buttons: 0 };
    host.getTool()?.onUp?.(host.engine, toolEvent);
    host.silenceToolLoops();
    releasePointerCapture();
    host.requestFrame();
  }

  /**
   * Stop a gesture without invoking its destructive release action.
   * Administrative actions such as undo must also discard queued movement;
   * otherwise the next frame can replay pre-undo damage onto restored pixels.
   */
  function cancel() {
    pendingMoveCount = 0;
    if (!held) return;
    held = false;
    artUpAt = host.nowSeconds();
    host.silenceToolLoops();
    releasePointerCapture();
    host.requestFrame();
  }

  /** Drive the selected tool at a document point without a pointing device. */
  function strike(x: number, y: number, holdMs = 0): boolean {
    const tool = host.getTool();
    if (!tool || host.isBlocked()) return false;

    flush();
    host.checkpoint(tool.id);
    const event: ToolPointerEvent = { x, y, dx: 0, dy: 0, buttons: 1 };
    pointer.x = previous.x = x;
    pointer.y = previous.y = y;
    artDownAt = host.nowSeconds();
    held = true;
    tool.onDown?.(host.engine, event);

    if (holdMs > 0) {
      const dt = 1 / 60;
      const steps = Math.min(600, Math.round(holdMs / (dt * 1000)));
      for (let i = 0; i < steps; i++) tool.tick?.(host.engine, dt, true, pointer);
    }

    held = false;
    artUpAt = host.nowSeconds();
    tool.onUp?.(host.engine, { ...event, buttons: 0 });
    host.requestFrame();
    return true;
  }

  function toToolEvent(event: PointerEvent): ToolPointerEvent {
    const { scrollX, scrollY, originX, originY } = host.coordinates();
    const x = event.clientX + scrollX - originX;
    const y = event.clientY + scrollY - originY;
    const toolEvent = {
      x,
      y,
      dx: previous.x < -100 ? 0 : x - previous.x,
      dy: previous.y < -100 ? 0 : y - previous.y,
      buttons: event.buttons,
    };
    previous.x = x;
    previous.y = y;
    pointer.x = x;
    pointer.y = y;
    return toolEvent;
  }

  function onPointerDown(event: PointerEvent) {
    const tool = host.getTool();
    if (!tool || event.button !== 0 || !event.isPrimary || host.isBlocked()) return;
    event.preventDefault();
    flush();
    host.checkpoint(tool.id);
    held = true;
    activePointerId = event.pointerId;
    try {
      container.setPointerCapture?.(event.pointerId);
    } catch {
      // Older Safari builds can reject capture even though Pointer Events exist.
    }
    artDownAt = host.nowSeconds();
    previous.x = previous.y = PARKED_POINTER;
    // Always build the event: tick-driven tools still need the pointer state
    // even when they intentionally have no onDown handler.
    const toolEvent = toToolEvent(event);
    tool.onDown?.(host.engine, toolEvent);
    host.requestFrame();
  }

  function onPointerMove(event: PointerEvent) {
    if (!host.getTool() || !event.isPrimary) return;
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    const { scrollX, scrollY, originX, originY } = host.coordinates();
    const x = event.clientX + scrollX - originX;
    const y = event.clientY + scrollY - originY;
    pointer.x = x;
    pointer.y = y;
    const at = pendingMoveCount < POINTER_RING_CAP ? pendingMoveCount++ : POINTER_RING_CAP - 1;
    let slot = pendingMoves[at];
    if (!slot) {
      slot = { x: 0, y: 0, buttons: 0 };
      pendingMoves[at] = slot;
    }
    slot.x = x;
    slot.y = y;
    slot.buttons = event.buttons;
    host.requestFrame();
    if (host.isBlocked()) flush();
  }

  function onPointerUp(event: PointerEvent) {
    end(event);
  }

  function onPointerCancel(event: PointerEvent) {
    end(event);
  }

  function onPointerLeave() {
    flush();
    if (held) return;
    pointer.x = pointer.y = PARKED_POINTER;
    previous.x = previous.y = PARKED_POINTER;
    host.requestFrame();
  }

  function onContextMenu(event: Event) {
    if (host.getTool()) event.preventDefault();
  }

  function releasePointerCapture() {
    if (activePointerId !== null) {
      try {
        container.releasePointerCapture?.(activePointerId);
      } catch {
        // Capture may already have been released by the browser on cancellation.
      }
    }
    activePointerId = null;
  }
}
