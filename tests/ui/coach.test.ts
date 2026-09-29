// The first-run coach (src/ui/coach.ts): tap the heart, break it, fix it. Ticked by events, dismissible, and
// remembered in the browser, with storage that may be missing or broken.
import { describe, it, expect } from "vitest";
import { Coach, type KeyValueStore } from "../../src/ui/coach";

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
};

describe("the first-run coach", () => {
  it("starts on step one, shown, with nothing done", () => {
    const c = new Coach(memory());
    expect(c.hidden).toBe(false);
    expect(c.current).toBe(0);
    expect(c.done).toEqual([false, false, false]);
  });

  it("ticks each step as the person does it, in any order", () => {
    const c = new Coach(memory());
    let changes = 0;
    c.onChange(() => changes++);
    c.brokeIt("racing");
    expect(c.done).toEqual([false, true, false]);
    expect(c.current).toBe(0); // tapping is still the first thing left
    c.tapped();
    expect(c.current).toBe(2);
    c.fixedIt();
    expect(c.finished).toBe(true);
    expect(c.current).toBe(3);
    expect(changes).toBe(3);
  });

  it("only counts a fix once the heart has been broken", () => {
    const c = new Coach(memory());
    c.fixedIt();
    expect(c.done[2]).toBe(false);
    c.brokeIt("chaotic");
    c.fixedIt();
    expect(c.done[2]).toBe(true);
  });

  it("names the rhythm on show in step 2 until the shock, and tells the page only when it changes", () => {
    const c = new Coach(memory());
    let changes = 0;
    c.onChange(() => changes++);
    c.brokeIt("racing");
    c.brokeIt("racing"); // the page calls it on every refresh: nothing new, so nothing to tell
    expect(c.broke).toBe("racing");
    expect(changes).toBe(1);
    // racing, then made to fibrillate: step 2 now says it is fibrillating
    c.brokeIt("chaotic");
    expect(c.broke).toBe("chaotic");
    expect(c.done[1]).toBe(true);
    expect(changes).toBe(2);
    // after the shock, step 2 keeps what it said
    c.fixedIt();
    c.brokeIt("racing");
    expect(c.broke).toBe("chaotic");
    expect(changes).toBe(3);
  });

  it("does not repeat itself: a step done twice changes nothing", () => {
    const c = new Coach(memory());
    let changes = 0;
    c.onChange(() => changes++);
    c.tapped();
    c.tapped();
    expect(changes).toBe(1);
  });

  it("stays away once finished or hidden, in this browser", () => {
    const store = memory();
    const a = new Coach(store);
    a.tapped();
    a.brokeIt("racing");
    a.fixedIt();
    expect(new Coach(store).hidden).toBe(true);

    const other = memory();
    const b = new Coach(other);
    b.hide();
    expect(b.hidden).toBe(true);
    expect(new Coach(other).hidden).toBe(true);
  });

  it("works, and just forgets, when storage is missing or throws", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const c = new Coach(broken);
    expect(c.hidden).toBe(false);
    c.hide();
    expect(c.hidden).toBe(true);
    const none = new Coach(null);
    none.tapped();
    expect(none.done[0]).toBe(true);
  });
});
