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

export interface ConvertResponse {
  id: number;
  result: string;
  status: string;
  status_code: number;
  /** Echo of the request's `version`. */
  version: number;
  log: string;
  timings?: Timings;
}

export interface ConvertClientOpts {
  onMessage: (r: ConvertResponse) => void;
  onStatus?: (s: string) => void;
}

const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000];

export class ConvertClient {
  private ws: WebSocket | null = null;
  private retry = 0;
  private queue: string[] = [];
  private closed = false;

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
      this.retry = 0;
      this.opts.onStatus?.("connected");
      while (this.queue.length > 0) ws.send(this.queue.shift()!);
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
      if (this.closed) return;
      const delay = RECONNECT_DELAYS_MS[Math.min(this.retry, RECONNECT_DELAYS_MS.length - 1)]!;
      this.retry++;
      this.opts.onStatus?.(`disconnected — retrying in ${delay}ms`);
      window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {
      ws.close();
    };
  }
}
