export class Debouncer {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly delayMs: () => number) {}

  schedule(callback: () => void): void {
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      callback();
    }, this.delayMs());
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.cancel();
  }
}
