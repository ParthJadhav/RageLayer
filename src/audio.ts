import type { SoundApi } from "./types";

/**
 * Fully procedural sound effects — no audio assets, so the package stays a
 * zero-download dependency. Everything is synthesized from noise buffers and
 * oscillators at call time. The AudioContext is created lazily on the first
 * user gesture so autoplay policies never block it.
 */
export class SoundEngine implements SoundApi {
  enabled = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private loops = new Map<string, { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode }>();

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** Short filtered noise burst — the workhorse for impacts. */
  private burst(opts: { duration: number; gain: number; filterFrom: number; filterTo: number; type?: BiquadFilterType }) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noiseBuffer) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? "lowpass";
    filter.frequency.setValueAtTime(opts.filterFrom, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.filterTo), t + opts.duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + opts.duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + opts.duration + 0.05);
  }

  shot() {
    this.burst({ duration: 0.16, gain: 0.9, filterFrom: 4000, filterTo: 100 });
    // Low body thump under the crack.
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.15);
  }

  thunk() {
    this.burst({ duration: 0.12, gain: 0.7, filterFrom: 900, filterTo: 80 });
  }

  /**
   * Short pitched sine with a fast decay — the workhorse for anything that
   * rings rather than thuds (casings, glass, sap pockets).
   */
  private ping(freq: number, duration: number, gain: number, type: OscillatorType = "triangle") {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.72, t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  tink() {
    this.ping(2100 + Math.random() * 1400, 0.09, 0.11);
  }

  pop() {
    this.ping(240 + Math.random() * 260, 0.07, 0.22, "square");
    this.burst({ duration: 0.07, gain: 0.3, filterFrom: 3000, filterTo: 400 });
  }

  crack() {
    // Two clicks a few ms apart read as something splintering rather than a
    // single hit; the high bandpass keeps it brittle instead of woody.
    this.burst({ duration: 0.05, gain: 0.5, filterFrom: 9000, filterTo: 3000, type: "bandpass" });
    this.ping(1500 + Math.random() * 900, 0.05, 0.09);
  }

  sweep() {
    this.burst({ duration: 0.22, gain: 0.14, filterFrom: 1200, filterTo: 4500, type: "highpass" });
  }

  splat() {
    this.burst({ duration: 0.18, gain: 0.5, filterFrom: 2500, filterTo: 300, type: "bandpass" });
  }

  hiss() {
    this.burst({ duration: 0.5, gain: 0.25, filterFrom: 6000, filterTo: 2000, type: "highpass" });
  }

  /**
   * Continuous loops (fire crackle, water spray, saw). Called every frame with
   * the target gain; ramps smoothly so loops fade in/out instead of clicking.
   */
  loop(name: "fire" | "water" | "saw" | "flamethrower", target: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noiseBuffer) return;
    if (!this.enabled) target = 0;
    let entry = this.loops.get(name);
    if (!entry && target > 0) {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.loop = true;
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      if (name === "fire") {
        filter.type = "lowpass";
        filter.frequency.value = 500;
        source.playbackRate.value = 0.35;
      } else if (name === "water") {
        filter.type = "highpass";
        filter.frequency.value = 2500;
      } else if (name === "flamethrower") {
        filter.type = "bandpass";
        filter.frequency.value = 700;
        filter.Q.value = 0.4;
        source.playbackRate.value = 0.6;
      } else {
        filter.type = "bandpass";
        filter.frequency.value = 1400;
        filter.Q.value = 6;
        source.playbackRate.value = 1.6;
      }
      source.connect(filter).connect(gain).connect(this.master);
      source.start();
      entry = { source, gain, filter };
      this.loops.set(name, entry);
    }
    if (entry) {
      entry.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
      if (name === "fire" && target > 0) {
        // Random crackle: jitter the filter to keep the loop organic.
        entry.filter.frequency.setTargetAtTime(350 + Math.random() * 500, ctx.currentTime, 0.05);
      }
    }
  }

  dispose() {
    for (const { source } of this.loops.values()) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    this.loops.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
  }
}
