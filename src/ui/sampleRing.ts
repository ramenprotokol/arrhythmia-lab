// A fixed-size ring of timestamped samples, several channels sharing one clock. Times never go backwards.
//
// Samples that arrive within `minDtMs` of the one that opened the newest bucket are merged into it (the
// newest values win). That caps the storage rate at 1 / minDtMs per second however fast the caller
// pushes, so `capacity * minDtMs` is the least time the ring is guaranteed to cover.
export class SampleRing {
  private cap: number;
  private times: Float64Array;
  private data: Float32Array[];
  /** Physical index of the next write. */
  private head = 0;
  private size = 0;
  private bucketStart = -Infinity;

  constructor(
    readonly channels: number,
    capacity: number,
    private readonly minDtMs = 0.5,
  ) {
    if (!Number.isInteger(channels) || channels < 1) throw new RangeError("channels must be a whole number of at least 1");
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a whole number of at least 1");
    this.cap = capacity;
    this.times = new Float64Array(capacity);
    this.data = Array.from({ length: channels }, () => new Float32Array(capacity));
  }

  get capacity(): number {
    return this.cap;
  }

  get length(): number {
    return this.size;
  }

  /** Time of the newest sample, or -Infinity when empty. */
  get lastTime(): number {
    return this.size === 0 ? -Infinity : this.times[this.phys(this.size - 1)];
  }

  push(t: number, values: ArrayLike<number>): void {
    if (values.length < this.channels) throw new RangeError(`expected ${this.channels} values, got ${values.length}`);
    if (this.size > 0 && t < this.lastTime) throw new RangeError(`time went backwards (${t} after ${this.lastTime})`);
    if (this.size > 0 && t - this.bucketStart < this.minDtMs) {
      this.write(this.phys(this.size - 1), t, values);
      return;
    }
    this.write(this.head, t, values);
    this.bucketStart = t;
    this.head = (this.head + 1) % this.cap;
    if (this.size < this.cap) this.size++;
  }

  /** Time of the i-th sample, 0 being the oldest. */
  timeAt(i: number): number {
    return this.times[this.phys(i)];
  }

  valueAt(channel: number, i: number): number {
    return this.data[channel][this.phys(i)];
  }

  /** Index of the first sample at or after t, or `length` if there is none. */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.times[this.phys(mid)] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the first sample after t, or `length` if there is none. */
  upperBound(t: number): number {
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.times[this.phys(mid)] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** One channel from time `fromT` on, oldest first. */
  window(channel: number, fromT: number): { t: Float32Array; v: Float32Array } {
    const start = this.lowerBound(fromT);
    const n = this.size - start;
    const t = new Float32Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.phys(start + i);
      t[i] = this.times[p];
      v[i] = this.data[channel][p];
    }
    return { t, v };
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
    this.bucketStart = -Infinity;
  }

  /** Change the capacity, keeping the newest samples if it shrinks. */
  resize(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a whole number of at least 1");
    const keep = Math.min(this.size, capacity);
    const first = this.size - keep;
    const times = new Float64Array(capacity);
    const data = this.data.map(() => new Float32Array(capacity));
    for (let i = 0; i < keep; i++) {
      const p = this.phys(first + i);
      times[i] = this.times[p];
      for (let c = 0; c < this.channels; c++) data[c][i] = this.data[c][p];
    }
    this.cap = capacity;
    this.times = times;
    this.data = data;
    this.size = keep;
    this.head = keep % capacity;
  }

  /** Physical slot of the i-th sample, 0 being the oldest. */
  private phys(i: number): number {
    const p = this.head - this.size + i;
    return p < 0 ? p + this.cap : p;
  }

  private write(p: number, t: number, values: ArrayLike<number>): void {
    this.times[p] = t;
    for (let c = 0; c < this.channels; c++) this.data[c][p] = values[c];
  }
}
