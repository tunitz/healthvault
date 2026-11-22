/**
 * Cross-page signal from the global Quick log menu to the dialog on the destination page.
 * The value lives on `window` so every client chunk sees the same request after navigation.
 */
const KEY = "__hvQuickLog";
const EVENT = "hv-quick-log";

export function requestQuickLog(href: string) {
  (window as Window & { [KEY]?: string | null })[KEY] = href;
  window.dispatchEvent(new Event(EVENT));
}

export function clearQuickLog() {
  (window as Window & { [KEY]?: string | null })[KEY] = null;
}

export function getQuickLogTarget(): string | null {
  return (window as Window & { [KEY]?: string | null })[KEY] ?? null;
}

export const QUICK_LOG_EVENT = EVENT;
