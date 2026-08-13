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
  private loops = new Map<
    string,
    {
      source: AudioBufferSourceNode;
      gain: GainNode;
      filter: BiquadFilterNode;
      stopTimer: number | null;
    }
  >();

  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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
  private burst(opts: {
    duration: number;
    gain: number;
    filterFrom: number;
    filterTo: number;
    type?: BiquadFilterType;
    /** Seconds after "now" to start — lets one call schedule a rhythm. */
    delay?: number;
  }) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noiseBuffer) return;
    const t = ctx.currentTime + (opts.delay ?? 0);
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
   * A hammer blow, distinct from the generic `thunk`.
   *
   * Four layers, each doing one job: a near-instant contact transient (the
   * head meeting the surface), a woody mid knock (the blow itself), a twin
   * sub-bass thump (the mass behind it — two detuned sines drop far harder
   * than one, which reads as a kick drum), and a delayed crumble tail
   * (plaster and grit sifting down after). Pitch and decay jitter per call so
   * repeated strikes read as effort, not a sample loop. `weight` (0..1)
   * scales the low end and the crumble — the final, breaking blow passes 1.
   */
  hammer(weight = 0.6) {
    // Contact transient: nearly all attack, no tail.
    this.burst({ duration: 0.03, gain: 0.8, filterFrom: 5200, filterTo: 2000, type: "bandpass" });
    // Knock body — the woody mid punch.
    this.burst({
      duration: 0.1 + Math.random() * 0.04,
      gain: 0.9,
      filterFrom: 520 + Math.random() * 140,
      filterTo: 70,
    });
    // Crumble tail, a hair behind the hit: debris sifting out of the wound.
    this.burst({
      duration: 0.22,
      gain: 0.14 + weight * 0.16,
      filterFrom: 1400,
      filterTo: 300,
      type: "bandpass",
      delay: 0.035,
    });
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    // Twin sub thump: fundamental plus a quieter fifth above it.
    for (const [mult, gain] of [
      [1, 0.45 + weight * 0.5],
      [1.5, 0.16],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const f0 = (95 + Math.random() * 25) * mult;
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(28, f0 * 0.28), t + 0.16);
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18 + weight * 0.08);
      osc.connect(g).connect(this.master);
      osc.start(t);
      osc.stop(t + 0.3);
    }
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
    // Two soft bristle strokes rather than one hiss: the second, quieter swish
    // an eighth of a second behind is what makes it read as *brushing* — a
    // motion with a return stroke — instead of escaping steam.
    this.burst({ duration: 0.16, gain: 0.16, filterFrom: 500, filterTo: 1900, type: "bandpass" });
    this.burst({
      duration: 0.14,
      gain: 0.09,
      filterFrom: 1600,
      filterTo: 600,
      type: "bandpass",
      delay: 0.13,
    });
  }

  splat() {
    this.burst({ duration: 0.18, gain: 0.5, filterFrom: 2500, filterTo: 300, type: "bandpass" });
  }

  hiss() {
    this.burst({ duration: 0.5, gain: 0.25, filterFrom: 6000, filterTo: 2000, type: "highpass" });
  }

  /**
   * Detonation. Three layers, because a single noise burst reads as a slap: a
   * sub-bass drop you feel, a wide noise body that opens and closes, and a
   * long low-passed tail that is the sound bouncing off everything else.
   */
  boom() {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(24, t + 0.55);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.85, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.65);
    this.burst({ duration: 0.32, gain: 0.85, filterFrom: 2200, filterTo: 90 });
    this.burst({ duration: 1.1, gain: 0.3, filterFrom: 500, filterTo: 60 });
  }

  /** Lightning: a hard ionizing crack riding a rolling rumble. */
  zap() {
    this.burst({ duration: 0.06, gain: 0.9, filterFrom: 12000, filterTo: 5000, type: "highpass" });
    this.burst({ duration: 0.9, gain: 0.4, filterFrom: 1400, filterTo: 70 });
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    // A fast downward sawtooth chirp is what gives an electrical arc its
    // characteristic "tearing" quality over the noise.
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(2400, t);
    osc.frequency.exponentialRampToValueAtTime(180, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.16);
  }

  whoosh() {
    this.burst({ duration: 0.45, gain: 0.42, filterFrom: 300, filterTo: 2600, type: "bandpass" });
  }

  /**
   * Continuous loops (fire crackle, water spray, saw). Called every frame with
   * the target gain; ramps smoothly so loops fade in/out instead of clicking.
   */
  loop(name: "fire" | "water" | "saw" | "flamethrower" | "void", target: number) {
    if (!this.enabled) target = 0;
    // The engine drives loops from its rAF with target 0 while idle. Creating
    // the AudioContext there would happen outside any user gesture (autoplay
    // policies block it and Chrome warns); only touch audio once a loop is
    // actually starting or already running.
    let entry = this.loops.get(name);
    if (target <= 0) {
      if (!entry || !this.ctx) return;
      entry.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      if (entry.stopTimer === null) {
        const fading = entry;
        // Four time constants leaves the ramp effectively silent. Stop and
        // disconnect after it, otherwise every tool ever tried leaves a muted
        // AudioBufferSource processing until the whole engine is disposed.
        fading.stopTimer = window.setTimeout(() => {
          if (this.loops.get(name) !== fading) return;
          try {
            fading.source.stop();
          } catch {
            // It may already have stopped during context shutdown.
          }
          fading.source.disconnect();
          fading.filter.disconnect();
          fading.gain.disconnect();
          this.loops.delete(name);
        }, 320);
      }
      return;
    }
    const ctx = this.ensure();
    if (!ctx || !this.master || !this.noiseBuffer) return;
    if (!entry) {
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
      } else if (name === "void") {
        // Sub-bass rumble: a singularity should be felt more than heard.
        filter.type = "lowpass";
        filter.frequency.value = 110;
        filter.Q.value = 8;
        source.playbackRate.value = 0.2;
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
      entry = { source, gain, filter, stopTimer: null };
      this.loops.set(name, entry);
    }
    if (entry.stopTimer !== null) {
      window.clearTimeout(entry.stopTimer);
      entry.stopTimer = null;
    }
    entry.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
    if (name === "fire") {
      // Random crackle: jitter the filter to keep the loop organic.
      entry.filter.frequency.setTargetAtTime(350 + Math.random() * 500, ctx.currentTime, 0.05);
    }
  }

  dispose() {
    for (const { source, filter, gain, stopTimer } of this.loops.values()) {
      if (stopTimer !== null) window.clearTimeout(stopTimer);
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    }
    this.loops.clear();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
  }
}
