export interface ConvertRequest {
  id: number;
  /** Path of the file to convert, relative to the active session. */
  active_file: string;
  /** Session `version` counter at request time. Server echoes; client
   *  uses to discard responses that race a still-pending write. */
  version: number;
  preamble?: string;
  profile?: string;
  format?: string;
  preload?: string[];
}

export interface Timings {
  build_us: number;
  convert_ms: number;
  post_ms: number;
  total_ms: number;
}

export type Severity = "info" | "warning" | "error" | "fatal";

export interface Diagnostic {
  severity: Severity;
  category: string;
  message:  string;
  source?:   string;
  from_line?: number;
  from_col?:  number;
  to_line?:   number;
  to_col?:    number;
}

export interface ConvertResponse {
  id: number;
  result: string;
  status: string;
  status_code: number;
  /** Echo of the request's `version`. */
  version: number;
  log: string;
  timings?: Timings;
  /** Parsed engine diagnostics. Empty for clean runs. The frontend
   *  attaches line-anchored entries to the editor and unanchored
   *  ones to the source-pane header badge. */
  diagnostics?: Diagnostic[];
  /** Source-map decoder ring (`--source-map` runs): the file basename for
   *  each integer source `tag` (array index = tag) used by the
   *  `data-sourcepos` attributes in `result`. Lets the client resolve the
   *  active file → tag and scroll the preview to the edited line. Absent /
   *  empty when source-map is off. */
  sources?: string[];
}

export interface ConvertClientOpts {
  onMessage: (r: ConvertResponse) => void;
  onStatus?: (s: string) => void;
}

// Exponential backoff starting at 1 second so a flaky network
// doesn't beat the server with a reconnect storm. Doubles per
// retry; once the last value is reached it stays there until a
// stable connection resets the counter (see `STABLE_AFTER_MS`).
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];

// A connection only counts as "stable" — and only then resets the
// backoff counter — after this long without dropping. Without this,
// a flaky network where `onopen` is followed by `onclose` within
// ~hundreds of ms would reset the backoff to 1 s every time and
// hammer the server. Resetting only after stability ensures the
// backoff progresses through the array even under churn.
const STABLE_AFTER_MS = 30_000;

export class ConvertClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private queue: string[] = [];
  private closed = false;
  /** Timer scheduled on `onopen`; fires after `STABLE_AFTER_MS` and
   *  resets `retry` to 0. Cleared if `onclose` fires before then,
   *  so brief-open-then-drop does NOT reset the backoff. */
  private stableTimer: number | null = null;

  constructor(private readonly url: string, private readonly opts: ConvertClientOpts) {
    this.connect();
  }

  send(req: ConvertRequest): void {
    const payload = JSON.stringify(req);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      this.queue.push(payload);
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private connect(): void {
    if (this.closed) return;
    this.opts.onStatus?.("connecting…");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.opts.onStatus?.("connected");
      while (this.queue.length > 0) ws.send(this.queue.shift()!);
      // Don't reset `retry` immediately — wait until the connection
      // has held for long enough to count as stable. Otherwise a
      // network that flaps every few seconds would walk 1 s → reset
      // → 1 s → reset → ... and never back off.
      if (this.stableTimer !== null) window.clearTimeout(this.stableTimer);
      this.stableTimer = window.setTimeout(() => {
        this.retry = 0;
        this.stableTimer = null;
      }, STABLE_AFTER_MS);
    };
    ws.onmessage = (ev) => {
      try {
        const resp = JSON.parse(ev.data) as ConvertResponse;
        this.opts.onMessage(resp);
      } catch (e) {
        console.error("bad ws payload", e);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      // Cancel the pending "promote to stable" timer — we never
      // earned the reset.
      if (this.stableTimer !== null) {
        window.clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      if (this.closed) return;
      const delay = RECONNECT_DELAYS_MS[
        Math.min(this.retry, RECONNECT_DELAYS_MS.length - 1)
      ]!;
      this.retry++;
      this.opts.onStatus?.(`disconnected — retrying in ${delay / 1000}s`);
      window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      ws.close();
    };
  }
}
