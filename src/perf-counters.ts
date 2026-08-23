/** Names accepted by the performance monitor's allocation-free counter sink. */
export type PerfCounterName =
  | "surfaceUploads"
  | "surfaceUploadPixels"
  | "surfaceReconciles"
  | "surfaceCoverage"
  | "opacitySamples"
  | "opacityPathTests"
  | "opacityFlattens"
  | "recomposeMs"
  | "gpuSurfaceMs"
  | "gpuPostFXMs"
  | "gpuTimerAvailable";

/** Narrow write-only capability handed from the monitor to hot-path subsystems. */
export interface PerfCounterSink {
  count(name: PerfCounterName, amount?: number): void;
}
