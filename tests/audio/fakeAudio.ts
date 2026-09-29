// A stand-in for the browser's AudioContext that remembers what was scheduled, so a test can check what the heartbeat
// player asked for without a sound card. Only what src/audio uses is here.

export class FakeParam {
  value = 0;
  events: { type: "set" | "exp" | "lin" | "target"; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: "set", value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: "lin", value, time });
    return this;
  }
  exponentialRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: "exp", value, time });
    return this;
  }
  setTargetAtTime(value: number, time: number): this {
    this.events.push({ type: "target", value, time });
    return this;
  }
  cancelScheduledValues(time: number): this {
    this.events = this.events.filter((e) => e.time < time);
    return this;
  }
  /** The highest level a shaped envelope on this parameter swells to. */
  get peak(): number {
    return Math.max(0, ...this.events.filter((e) => e.type === "exp").map((e) => e.value));
  }
  /** The last level this parameter was told to head for. */
  get lastTarget(): number | undefined {
    return [...this.events].reverse().find((e) => e.type === "target")?.value;
  }
}

export class FakeNode {
  connections: FakeNode[] = [];
  connect<T extends FakeNode>(node: T): T {
    this.connections.push(node);
    return node;
  }
  disconnect(): void {
    this.connections = [];
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam();
}

export class FakeOscillator extends FakeNode {
  type = "sine";
  frequency = new FakeParam();
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(when = 0): void {
    this.stoppedAt = when;
  }
  /** The level this oscillator's own envelope swells to, read off the gain node it feeds. */
  get peak(): number {
    return (this.connections[0] as FakeGain | undefined)?.gain.peak ?? 0;
  }
}

export class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
  startedAt: number | null = null;
  start(when = 0): void {
    this.startedAt = when;
  }
  stop(): void {}
}

export class FakeFilter extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam();
  Q = new FakeParam();
}

export class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}

export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 8000;
  state: "suspended" | "running" | "closed" = "suspended";
  /** Set false to imitate a browser that refuses to start audio without a gesture. */
  resumeMakesRunning = true;
  suspends = 0;
  destination = new FakeNode();
  gains: FakeGain[] = [];
  oscillators: FakeOscillator[] = [];
  sources: FakeSource[] = [];

  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator(): FakeOscillator {
    const o = new FakeOscillator();
    this.oscillators.push(o);
    return o;
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter();
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor();
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    return { length, sampleRate, getChannelData: () => new Float32Array(length) };
  }
  async resume(): Promise<void> {
    if (this.resumeMakesRunning) this.state = "running";
  }
  async suspend(): Promise<void> {
    this.state = "suspended";
    this.suspends++;
  }
  async close(): Promise<void> {
    this.state = "closed";
  }

  /** Oscillators that have been started, grouped by start time (to the millisecond), each group with its loudest envelope. */
  soundsStarted(): { at: number; peak: number }[] {
    const groups = new Map<number, number>();
    for (const o of this.oscillators) {
      if (o.startedAt === null) continue;
      const key = Math.round(o.startedAt * 1000);
      groups.set(key, Math.max(groups.get(key) ?? 0, o.peak));
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([ms, peak]) => ({ at: ms / 1000, peak }));
  }
}
