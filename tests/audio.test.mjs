import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SoundEngine } from "../src/audio.ts";
import "./support/dom.mjs";

function audioParam(value = 0) {
  return {
    value,
    setTargetAtTime(next) {
      this.value = next;
    },
  };
}

function audioNode(extra = {}) {
  return {
    disconnects: 0,
    connect(next) {
      return next;
    },
    disconnect() {
      this.disconnects++;
    },
    ...extra,
  };
}

function fakeAudioContext() {
  const sources = [];
  class FakeAudioContext {
    static sources = sources;
    sampleRate = 8;
    state = "running";
    currentTime = 0;
    destination = audioNode();
    createGain() {
      return audioNode({ gain: audioParam() });
    }
    createBuffer() {
      return { getChannelData: () => new Float32Array(16) };
    }
    createBufferSource() {
      const source = audioNode({
        loop: false,
        playbackRate: { value: 1 },
        starts: 0,
        stops: 0,
        start() {
          this.starts++;
        },
        stop() {
          this.stops++;
        },
      });
      sources.push(source);
      return source;
    }
    createBiquadFilter() {
      return audioNode({ frequency: audioParam(), Q: audioParam() });
    }
    resume() {}
    close() {}
  }
  return FakeAudioContext;
}

describe("looped audio lifecycle", () => {
  let original;

  beforeEach(() => {
    original = window.AudioContext;
    window.AudioContext = fakeAudioContext();
  });

  afterEach(() => {
    window.AudioContext = original;
  });

  test("a faded loop is stopped, disconnected and removed", async () => {
    const sound = new SoundEngine();
    sound.enabled = true;
    sound.loop("water", 0.3);
    const source = window.AudioContext.sources[0];

    sound.loop("water", 0);
    await Bun.sleep(360);

    expect(source.stops).toBe(1);
    expect(source.disconnects).toBe(1);
    expect(sound.loops.size).toBe(0);
    sound.dispose();
  });

  test("resuming during the fade keeps and reuses the existing source", async () => {
    const sound = new SoundEngine();
    sound.enabled = true;
    sound.loop("saw", 0.25);
    const source = window.AudioContext.sources[0];

    sound.loop("saw", 0);
    await Bun.sleep(80);
    sound.loop("saw", 0.2);
    await Bun.sleep(300);

    expect(source.stops).toBe(0);
    expect(window.AudioContext.sources).toHaveLength(1);
    expect(sound.loops.size).toBe(1);
    sound.dispose();
  });

  test("disposing during a fade cancels delayed teardown", async () => {
    const sound = new SoundEngine();
    sound.enabled = true;
    sound.loop("void", 0.2);
    const source = window.AudioContext.sources[0];

    sound.loop("void", 0);
    sound.dispose();
    await Bun.sleep(360);

    expect(source.stops).toBe(1);
    expect(source.disconnects).toBe(1);
    expect(sound.loops.size).toBe(0);
  });
});
