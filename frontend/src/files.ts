// File panel — tree rendering, header new/upload/download actions,
// click-to-open into the editor. No rename / delete in v1.2 per
// `docs/FileUI.md` "Non-goals". Auto-convert is triggered via the
// `requestPreview` callback after every successful file-op response.

import type { EditorHandle } from "./editor.ts";
import type { FileMeta, SessionClient, SessionEnvelope } from "./session.ts";
import { SessionExpiredError } from "./session.ts";
import { showFatalCard, showNotice } from "./toast.ts";

const HEADER_USER = "x-ar5iv-user";

export interface FilePanelOptions {
  /** Element that receives the file tree (children replaced on render). */
  treeEl:        HTMLElement;
  /** Header element holding the action buttons (Phase 3 stub). */
  actionsEl:     HTMLElement;
  /** The current session client. Replaced from the outside via
   *  `setSession()` when the user picks a different example slot. */
  session:       SessionClient;
  editor:        EditorHandle;
  /** Called after every successful state change so the preview pane
   *  catches up. The convert flow is owned by `main.ts`. */
  requestPreview: () => void;
  /** Called when the user opens a different file. The driver in
   *  `main.ts` is responsible for save-then-load and updating its
   *  `activePath`. Promise resolves once the swap is complete. */
  onOpenFile:    (path: string) => Promise<void>;
  /** Surface errors (replaced with a toast in Phase 6). */
  reportError:   (msg: string) => void;
  /** Called when an action completes that may have switched the
   *  session id (import-archive, switch-slot). The driver re-binds
   *  the WS / loads the new active file. */
  onSessionSwap: (env: SessionEnvelope) => void;
}

interface TreeNode {
  name:     string;
  path:     string;
  isDir:    boolean;
  children: TreeNode[];
}

export class FilePanel {
  private opts:        FilePanelOptions;
  private active:      string | null;
  private collapsed:   Set<string> = new Set();

  constructor(opts: FilePanelOptions) {
    this.opts = opts;
    this.active = opts.session.envelope.entry || null;
    this.renderActions();
    this.render();
  }

  setActiveFile(path: string | null): void {
    this.active = path;
    this.render();
  }

  setSession(env: SessionEnvelope): void {
    // Caller has already updated the SessionClient's envelope; we just
    // pick up the new file list and entry path.
    this.active = env.entry || null;
    this.collapsed.clear();
    this.render();
  }

  /** Refresh the file list from the server (e.g., after an upload). */
  async refresh(): Promise<void> {
    try {
      const listing = await this.opts.session.listFiles();
      this.opts.session.envelope = {
        ...this.opts.session.envelope,
        files: listing.files,
      };
      this.render();
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionExpiredCard();
        return;
      }
      this.opts.reportError(`refresh failed: ${e}`);
    }
  }

  // -------------------------------------------------------------------
  // Render.
  // -------------------------------------------------------------------

  private render(): void {
    const tree = buildTree(this.opts.session.envelope.files);
    const root = document.createElement("ul");
    root.className = "ftree-root";
    this.renderNodes(tree, root, 0);
    this.opts.treeEl.replaceChildren(root);
  }

  private renderNodes(nodes: TreeNode[], parent: HTMLElement, depth: number): void {
    for (const n of nodes) {
      const li = document.createElement("li");
      li.className = "ftree-row";
      if (n.isDir) li.classList.add("ftree-row--dir");
      if (n.path === this.active) li.classList.add("ftree-row--active");

      const row = document.createElement("button");
      row.type = "button";
      row.className = "ftree-button";
      row.style.paddingLeft = `${0.4 + depth * 0.85}rem`;

      const icon = document.createElement("span");
      icon.className = "ftree-icon";
      // Folders get a collapse-state arrow; files have no glyph —
      // their filename + extension is the visual signal, in keeping
      // with the terminal aesthetic of the timings strip.
      icon.textContent = n.isDir
        ? this.collapsed.has(n.path) ? "▶" : "▼"
        : "";
      row.appendChild(icon);

      const label = document.createElement("span");
      label.className = "ftree-label";
      label.textContent = n.name;
      row.appendChild(label);

      row.addEventListener("click", () => {
        if (n.isDir) {
          if (this.collapsed.has(n.path)) this.collapsed.delete(n.path);
          else this.collapsed.add(n.path);
          this.render();
        } else {
          void this.openFile(n.path);
        }
      });
      li.appendChild(row);

      // Per-row kebab — Download only in v1.2 (per Non-goals).
      if (!n.isDir) {
        const kebab = document.createElement("a");
        kebab.className = "ftree-kebab";
        kebab.href = this.opts.session.fileUrl(n.path);
        kebab.title = "Download this file";
        kebab.textContent = "dl";
        // Force download with a sensible filename.
        kebab.download = n.name;
        kebab.addEventListener("click", (e) => e.stopPropagation());
        li.appendChild(kebab);
      }

      parent.appendChild(li);

      if (n.isDir && !this.collapsed.has(n.path)) {
        const sub = document.createElement("ul");
        sub.className = "ftree-sublist";
        this.renderNodes(n.children, sub, depth + 1);
        parent.appendChild(sub);
      }
    }
  }

  private async openFile(path: string): Promise<void> {
    if (path === this.active) return;
    if (!isEditableExtension(path)) {
      this.opts.reportError(
        `${path} is not a text file. Reference it from your TeX, e.g. \\includegraphics{${stripExt(path)}}.`,
      );
      return;
    }
    try {
      await this.opts.onOpenFile(path);
      this.active = path;
      this.render();
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionExpiredCard();
        return;
      }
      this.opts.reportError(`open ${path} failed: ${e}`);
    }
  }

  // -------------------------------------------------------------------
  // Header actions.
  // -------------------------------------------------------------------

  private renderActions(): void {
    this.opts.actionsEl.replaceChildren();

    const newFileBtn = makeTextButton("new", "Create a new file");
    newFileBtn.addEventListener("click", () => void this.actionNewFile());
    this.opts.actionsEl.appendChild(newFileBtn);

    const uploadBtn = makeTextButton(
      "upload",
      "Upload a folder (recursively; preserves directory structure)",
    );
    uploadBtn.addEventListener("click", () => this.triggerUpload());
    this.opts.actionsEl.appendChild(uploadBtn);

    const downloadBtn = makeTextButton(
      "download",
      "Download the project (sources + rendered HTML) as ZIP",
    );
    downloadBtn.addEventListener("click", () => void this.actionDownload());
    this.opts.actionsEl.appendChild(downloadBtn);
  }

  private triggerUpload(): void {
    const input = document.createElement("input");
    input.type = "file";
    // `webkitdirectory` is the de-facto standard (Chrome/Edge/Safari/
    // Firefox all support it). Picks an entire folder; the browser
    // walks the tree and posts every file with `webkitRelativePath`
    // set, so subdirectory layout is preserved server-side.
    (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) return;
      void this.actionUploadFiles(files);
    });
    input.click();
  }

  private async actionNewFile(): Promise<void> {
    const raw = window.prompt("New file path (relative, e.g. notes.tex)?");
    if (!raw) return;
    const path = raw.trim();
    if (!path) return;
    if (path.includes("..") || path.startsWith("/") || path.includes("\\")) {
      this.opts.reportError("invalid path");
      return;
    }
    try {
      await this.opts.session.putText(path, "");
      await this.refresh();
      this.opts.requestPreview();
      void this.openFile(path);
    } catch (e) {
      if (e instanceof SessionExpiredError) {
        sessionExpiredCard();
        return;
      }
      this.opts.reportError(`new file failed: ${e}`);
    }
  }

  private async actionUploadFiles(files: File[]): Promise<void> {
    try {
      const form = new FormData();
      for (const f of files) {
        // `webkitRelativePath` is set when the input is in directory
        // mode. For plain multi-select it's empty and we fall back
        // to `name`.
        const name = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        form.append("file", f, name);
      }
      const url = `/api/session/${this.opts.session.envelope.id}/upload`;
      const resp = await fetch(url, {
        method:  "POST",
        body:    form,
        headers: { [HEADER_USER]: this.opts.session.userId },
      });
      if (resp.status === 410) {
        sessionExpiredCard();
        return;
      }
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`upload failed: ${resp.status} ${txt}`);
      }
      const ack = (await resp.json().catch(() => ({}))) as { skipped?: string[] };
      await this.refresh();
      this.opts.requestPreview();
      if (ack.skipped && ack.skipped.length > 0) {
        showNotice(formatSkippedMessage(ack.skipped));
      }
    } catch (e) {
      this.opts.reportError(`upload failed: ${e}`);
    }
  }

  private async actionDownload(): Promise<void> {
    try {
      const url = `/api/session/${this.opts.session.envelope.id}/export-zip`;
      const resp = await fetch(url, {
        headers: { [HEADER_USER]: this.opts.session.userId },
      });
      if (resp.status === 410) {
        sessionExpiredCard();
        return;
      }
      if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
      const blob = await resp.blob();
      const cd = resp.headers.get("content-disposition") ?? "";
      const filenameMatch = /filename="([^"]+)"/.exec(cd);
      const filename = filenameMatch?.[1] ?? "ar5iv-session.zip";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      this.opts.reportError(`download failed: ${e}`);
    }
  }
}

// -----------------------------------------------------------------------
// Helpers.
// -----------------------------------------------------------------------

/** Common copy for the "your tmpdir was swept" fatal card. The card is
 *  idempotent — multiple callers racing to surface the same condition
 *  collapse onto a single overlay. */
function sessionExpiredCard(): void {
  showFatalCard(
    "Session expired",
    "Your editing session was cleaned up after a long idle period. Reloading to start a fresh one.",
  );
}

/** Two-line summary for the upload-skipped notice. Headline carries the
 *  count; the second line names a few examples (truncated past a
 *  reasonable cap so a multi-hundred-file build directory doesn't blow
 *  out the banner). */
function formatSkippedMessage(skipped: string[]): string {
  const max = 8;
  const head = skipped.slice(0, max).map((p) => p.split("/").pop() || p);
  const more = skipped.length > max ? `, +${skipped.length - max} more` : "";
  const noun = skipped.length === 1 ? "file" : "files";
  return `Skipped ${skipped.length} ${noun} with unsupported extensions\n${head.join(", ")}${more}`;
}

function buildTree(files: FileMeta[]): TreeNode[] {
  // Build nested tree from flat path list. Any directory entries the
  // server emitted are absorbed; we'll re-emit our own shells for any
  // path segment.
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  const dirs = new Map<string, TreeNode>();
  dirs.set("", root);
  // Sort so dirs land before files at the same depth (stable display).
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    if (f.kind === "dir") {
      ensureDir(f.path);
      continue;
    }
    const segs = f.path.split("/");
    const leaf = segs.pop()!;
    const parentPath = segs.join("/");
    const parent = ensureDir(parentPath);
    parent.children.push({
      name: leaf,
      path: f.path,
      isDir: false,
      children: [],
    });
  }
  return root.children;

  function ensureDir(path: string): TreeNode {
    if (dirs.has(path)) return dirs.get(path)!;
    const segs = path.split("/");
    const leaf = segs.pop()!;
    const parentPath = segs.join("/");
    const parent = ensureDir(parentPath);
    const node: TreeNode = { name: leaf, path, isDir: true, children: [] };
    parent.children.push(node);
    dirs.set(path, node);
    return node;
  }
}

function makeTextButton(label: string, title: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.title = title;
  b.textContent = label;
  return b;
}

function isEditableExtension(path: string): boolean {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return [
    "tex", "sty", "cls", "bib", "bst", "bbl",
    "txt", "md", "csv", "toml", "json", "yaml", "yml", "svg",
  ].includes(ext);
}

function stripExt(name: string): string {
  return name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
}
