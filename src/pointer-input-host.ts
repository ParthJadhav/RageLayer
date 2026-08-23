import type { RageLayerEngineApi, Tool, Vec2 } from "./types";

/** Internal adapter implemented by the engine's composition root. */
export interface PointerInputHost {
  readonly engine: RageLayerEngineApi;
  readonly container: HTMLElement;
  getTool(): Tool | null;
  isBlocked(): boolean;
  coordinates(): { scrollX: number; scrollY: number; originX: number; originY: number };
  nowSeconds(): number;
  checkpoint(label: string): void;
  requestFrame(): void;
  silenceToolLoops(): void;
}

export interface PointerInputController {
  readonly pointer: Vec2;
  readonly held: boolean;
  readonly artDownAt: number;
  readonly artUpAt: number;
  dispose(): void;
  flush(): void;
  end(event?: PointerEvent): void;
  cancel(): void;
  strike(x: number, y: number, holdMs?: number): boolean;
}
