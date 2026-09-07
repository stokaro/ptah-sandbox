/**
 * The boot indicator.
 *
 * It reports real work: measured bytes while the module downloads, then the
 * phases that follow, each appearing only once it has actually started. There
 * is no invented percentage and no timer pretending to be progress -- the one
 * number on screen is bytes that have arrived.
 *
 * The bar is indeterminate for phases that have no measurable extent
 * (compiling, initializing) rather than freezing at whatever the download
 * ended on, because a bar that stops moving reads as a hang.
 */

import type { BootPhase } from "./protocol.ts";

const MIB = 1024 * 1024;

function mib(bytes: number): string {
  return (bytes / MIB).toFixed(1);
}

export class Loader {
  private root: HTMLElement;
  private fill: HTMLElement;
  private label: HTMLElement;
  private detail: HTMLElement;
  private started = Date.now();

  constructor(host: HTMLElement) {
    host.innerHTML = `
      <div class="boot" role="status" aria-live="polite">
        <div class="boot-line">
          <span class="boot-spin" aria-hidden="true"></span>
          <span class="boot-label">starting</span>
          <span class="boot-detail"></span>
        </div>
        <div class="boot-track"><div class="boot-fill"></div></div>
      </div>`;
    this.root = host.querySelector(".boot")!;
    this.fill = host.querySelector(".boot-fill")!;
    this.label = host.querySelector(".boot-label")!;
    this.detail = host.querySelector(".boot-detail")!;
  }

  update(phase: BootPhase, loaded: number, total: number): void {
    this.label.textContent = phase;
    if (phase === "downloading" && total > 0) {
      const pct = Math.min(100, (loaded / total) * 100);
      this.root.classList.remove("is-indeterminate");
      this.fill.style.width = `${pct.toFixed(1)}%`;
      this.detail.textContent = `${mib(loaded)} / ${mib(total)} MiB`;
    } else {
      // Nothing here has a measurable extent, so the bar says "working"
      // rather than standing still at a number that has stopped meaning
      // anything.
      this.root.classList.add("is-indeterminate");
      this.detail.textContent = "";
    }
  }

  done(summary: string): void {
    this.root.classList.remove("is-indeterminate");
    this.root.classList.add("is-done");
    this.fill.style.width = "100%";
    this.label.textContent = "ready";
    this.detail.textContent = `${summary} · ${((Date.now() - this.started) / 1000).toFixed(1)} s`;
  }

  fail(message: string): void {
    this.root.classList.remove("is-indeterminate");
    this.root.classList.add("is-failed");
    this.label.textContent = "failed";
    this.detail.textContent = message;
  }
}
