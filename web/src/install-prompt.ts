/** A dismissed reminder returns after seven days, including in an open tab. */
export const INSTALL_PROMPT_KEY = "ptah-play-install-dismissed-until";
export const INSTALL_PROMPT_WEEK = 7 * 24 * 60 * 60 * 1000;

export function installPromptDelay(value: string | null, now = Date.now()): number {
  const until = Number(value);
  // Invalid data or a clock moved backward must not hide the reminder forever.
  return Number.isSafeInteger(until) && until > now && until <= now + INSTALL_PROMPT_WEEK
    ? until - now
    : 0;
}

export function installCliPrompt(
  panel: HTMLElement,
  close: HTMLButtonElement,
  fallback: HTMLAnchorElement,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dismissedUntil: string | null = null;

  const read = (): void => {
    try { dismissedUntil = localStorage.getItem(INSTALL_PROMPT_KEY); }
    catch { /* Keep the tab's choice when browser storage is unavailable. */ }
  };
  const render = (): void => {
    clearTimeout(timer);
    const delay = installPromptDelay(dismissedUntil);
    if (delay > 0 && panel.contains(document.activeElement)) fallback.focus();
    panel.hidden = delay > 0;
    if (delay > 0) timer = setTimeout(render, delay);
  };

  close.addEventListener("click", () => {
    dismissedUntil = String(Date.now() + INSTALL_PROMPT_WEEK);
    try { localStorage.setItem(INSTALL_PROMPT_KEY, dismissedUntil); }
    catch { /* Closing still works for this tab. */ }
    render();
  });
  window.addEventListener("storage", event => {
    if (event.key !== INSTALL_PROMPT_KEY && event.key !== null) return;
    read();
    render();
  });
  read();
  render();
}
