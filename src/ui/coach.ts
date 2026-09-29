// The first-run coach: "tap the heart, break it, fix it", ticked off as the person does each one. Pure state and a
// little storage, no DOM (tests/ui/coach.test.ts). Once finished or hidden it stays away in this browser.
const STORAGE_KEY = "arrhythmia-lab:first-run";

export type Broken = "racing" | "chaotic";

/** Storage can be missing or throw (private windows, blocked cookies): every use is guarded. */
export type KeyValueStore = { getItem(key: string): string | null; setItem(key: string, value: string): void };

function defaultStore(): KeyValueStore | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class Coach {
  /** Which of the three steps are done: tap, break, fix. */
  readonly done: [boolean, boolean, boolean] = [false, false, false];
  /** How it was broken, so step 2 can say the right thing. */
  broke: Broken | null = null;
  hidden: boolean;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: KeyValueStore | null = defaultStore()) {
    let saved: string | null;
    try {
      saved = store?.getItem(STORAGE_KEY) ?? null;
    } catch {
      saved = null;
    }
    this.hidden = saved === "done" || saved === "hidden";
  }

  /** The first step not yet done: 0, 1 or 2, or 3 once all three are. */
  get current(): number {
    const i = this.done.indexOf(false);
    return i < 0 ? 3 : i;
  }

  get finished(): boolean {
    return this.current === 3;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  tapped(): void {
    this.mark(0);
  }

  /**
   * The heart is in a rhythm the person started: racing or chaotic. The page calls this on every refresh, so step 2
   * follows the rhythm on show (racing, then made to fibrillate, says fibrillating) until the shock, and the page is only
   * told when that changes.
   */
  brokeIt(kind: Broken): void {
    if (this.done[2] || (this.done[1] && this.broke === kind)) return;
    this.broke = kind;
    if (this.done[1]) this.emit();
    else this.mark(1);
  }

  /** A shock fired. It only counts once the heart has been broken: a shock never fires on a healthy heart anyway. */
  fixedIt(): void {
    if (this.done[1]) this.mark(2);
  }

  hide(): void {
    if (this.hidden) return;
    this.hidden = true;
    this.save(this.finished ? "done" : "hidden");
    this.emit();
  }

  private mark(step: 0 | 1 | 2): void {
    if (this.done[step]) return;
    this.done[step] = true;
    if (this.finished) this.save("done");
    this.emit();
  }

  private save(value: string): void {
    try {
      this.store?.setItem(STORAGE_KEY, value);
    } catch {
      // the choice just is not remembered
    }
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }
}
