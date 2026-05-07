// Frontend session bootstrap.
//
// - `localStorage["ar5iv.user_id"]` is the persistent capability token
//   shared across tabs (256-bit base64url, minted server-side).
// - `sessionStorage["ar5iv.current_slot"]` is per-tab; it survives a
//   reload but not a tab close, so two tabs can edit different slots.
// - Session ids are derived from `(user_id, slot)` via `POST
//   /api/session`; the client never persists them.
//
// On `410 session_expired` from any subsequent route, the caller is
// expected to re-run `openSlot(currentSlot)`, which will recreate
// the tmpdir on the server.

const HEADER_USER = "x-ar5iv-user";
const LS_USER = "ar5iv.user_id";
const SS_SLOT = "ar5iv.current_slot";

export interface FileMeta {
  path: string;
  size: number;
  kind: "text" | "binary" | "dir";
}

export interface SessionEnvelope {
  id:    string;
  slot:  string;
  entry: string;
  files: FileMeta[];
}

export interface FileListing {
  files:   FileMeta[];
  version: number;
}

export interface WriteAck {
  size:    number;
  mtime:   number;
  version: number;
}

export interface OkAck {
  ok:      boolean;
  version: number;
}

export class SessionExpiredError extends Error {
  constructor() {
    super("session_expired");
  }
}

async function ensureUserId(): Promise<string> {
  const cached = localStorage.getItem(LS_USER);
  if (cached) return cached;
  const resp = await fetch("/api/user", { method: "POST" });
  if (!resp.ok) throw new Error(`POST /api/user failed: ${resp.status}`);
  const body = (await resp.json()) as { user_id: string };
  localStorage.setItem(LS_USER, body.user_id);
  return body.user_id;
}

function readSlot(): string {
  return sessionStorage.getItem(SS_SLOT) ?? "blank";
}

function writeSlot(slot: string): void {
  sessionStorage.setItem(SS_SLOT, slot);
}

async function callJson<T>(
  url: string,
  init: RequestInit,
  user: string,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(HEADER_USER, user);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const resp = await fetch(url, { ...init, headers });
  if (resp.status === 410) {
    const body = (await resp.json().catch(() => ({}))) as { code?: string };
    if (body.code === "session_expired") throw new SessionExpiredError();
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${init.method ?? "GET"} ${url} failed: ${resp.status} ${text}`);
  }
  return (await resp.json()) as T;
}

export class SessionClient {
  private constructor(public readonly userId: string, public envelope: SessionEnvelope) {}

  static async open(): Promise<SessionClient> {
    const user = await ensureUserId();
    const slot = readSlot();
    let env: SessionEnvelope;
    try {
      env = await callJson<SessionEnvelope>(
        "/api/session",
        { method: "POST", body: JSON.stringify({ slot }) },
        user,
      );
    } catch (e) {
      // The slot persisted in `sessionStorage` may have been removed
      // from the manifest under us (e.g. the legacy "new" pseudo-slot
      // that became the file-panel "clear" button in v0.3). Wipe the
      // stored slot and fall back to Blank so the page still loads
      // instead of error-toasting on every reload.
      if (slot !== "blank") {
        sessionStorage.removeItem(SS_SLOT);
        env = await callJson<SessionEnvelope>(
          "/api/session",
          { method: "POST", body: JSON.stringify({ slot: "blank" }) },
          user,
        );
      } else {
        throw e;
      }
    }
    writeSlot(env.slot);
    return new SessionClient(user, env);
  }

  /** Reopen the slot after a 410. The id changes; the slot doesn't. */
  async reopen(): Promise<void> {
    this.envelope = await callJson<SessionEnvelope>(
      "/api/session",
      { method: "POST", body: JSON.stringify({ slot: this.envelope.slot }) },
      this.userId,
    );
  }

  /** Switch to a different slot (e.g., from the examples dropdown). */
  async switchSlot(slot: string): Promise<void> {
    writeSlot(slot);
    this.envelope = await callJson<SessionEnvelope>(
      "/api/session",
      { method: "POST", body: JSON.stringify({ slot }) },
      this.userId,
    );
  }

  /** GET file bytes as text (for the editor) or as bytes (for binary). */
  async getText(path: string): Promise<string> {
    const resp = await fetch(this.fileUrl(path), {
      headers: { [HEADER_USER]: this.userId },
    });
    if (resp.status === 410) throw new SessionExpiredError();
    if (!resp.ok) throw new Error(`GET ${path} failed: ${resp.status}`);
    return await resp.text();
  }

  async putText(path: string, body: string): Promise<WriteAck> {
    return await callJson<WriteAck>(
      this.fileUrl(path),
      {
        method: "PUT",
        body,
        headers: { "content-type": "application/octet-stream" },
      },
      this.userId,
    );
  }

  async listFiles(): Promise<FileListing> {
    return await callJson<FileListing>(
      `/api/session/${this.envelope.id}/files`,
      { method: "GET" },
      this.userId,
    );
  }

  /** Remove a file or directory inside the session. The server's
   *  DELETE handler is recursive on directories (`remove_dir_all`),
   *  so the caller can pass either a leaf or a folder path and the
   *  whole subtree is unlinked. */
  async deletePath(path: string): Promise<OkAck> {
    return await callJson<OkAck>(
      this.fileUrl(path),
      { method: "DELETE" },
      this.userId,
    );
  }

  /** Wipe every file in the session, keeping the session id itself
   *  alive. Backs the file panel's "clear" button. The server resets
   *  file count / bytes used / cached preview / main-entry pick;
   *  callers must clear local UI state (editor buffers, active path)
   *  to match. */
  async clearFiles(): Promise<OkAck> {
    return await callJson<OkAck>(
      `/api/session/${this.envelope.id}/files`,
      { method: "DELETE" },
      this.userId,
    );
  }

  fileUrl(path: string): string {
    return `/api/session/${this.envelope.id}/files/${path}`;
  }

  websocketUrl(): string {
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    return (
      `${proto}${location.host}/convert?session_id=${encodeURIComponent(this.envelope.id)}` +
      `&user_id=${encodeURIComponent(this.userId)}`
    );
  }
}

