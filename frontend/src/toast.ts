// Tiny toast helper. Phase 6 — replaces the v1.1 "stuff errors into
// the status line" pattern with a non-disruptive bottom-right stack
// that auto-dismisses after a few seconds.

export type ToastKind = "info" | "warn" | "error";

const TOAST_TTL_MS = 4000;
const FADE_MS = 250;

function stackEl(): HTMLElement | null {
  let el = document.getElementById("toast-stack");
  if (!el) {
    // Inject lazily so a missing template element isn't fatal.
    el = document.createElement("div");
    el.id = "toast-stack";
    el.className = "toast-stack";
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

export function showToast(message: string, kind: ToastKind = "info"): void {
  const stack = stackEl();
  if (!stack) return;
  const t = document.createElement("div");
  t.className = `toast toast--${kind}`;
  t.textContent = message;
  stack.appendChild(t);
  // Click anywhere to dismiss early.
  t.addEventListener("click", () => fadeOut(t));
  window.setTimeout(() => fadeOut(t), TOAST_TTL_MS);
}

function fadeOut(t: HTMLElement): void {
  if (!t.isConnected) return;
  t.classList.add("toast--leaving");
  window.setTimeout(() => t.remove(), FADE_MS);
}
