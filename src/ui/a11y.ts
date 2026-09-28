// A canvas is a picture to a screen reader, so give it a name and a longer text alternative. The alternative
// lives in a visually hidden element next to the canvas and is tied to it with aria-describedby.

let counter = 0;

const HIDDEN =
  "position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0";

export class CanvasDescription {
  private readonly el: HTMLElement;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    label: string,
    description: string,
  ) {
    this.el = document.createElement("span");
    this.el.id = `acl-canvas-description-${++counter}`;
    this.el.style.cssText = HIDDEN;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-describedby", this.el.id);
    this.set(label, description);
  }

  set(label: string, description: string): void {
    this.canvas.setAttribute("aria-label", label);
    this.el.textContent = description;
    this.attach();
  }

  /** The canvas may not be in the page yet when this is built, so this is tried again on later calls. */
  attach(): void {
    if (!this.el.isConnected && this.canvas.parentNode) this.canvas.after(this.el);
  }

  remove(): void {
    this.el.remove();
  }
}
