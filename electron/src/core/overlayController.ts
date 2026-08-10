import type { OverlayMode, OverlayState, OverlayTone } from "../shared/overlay";

export interface OverlayTiming {
  slowMs?: number;
  normalMs?: number;
  warningMs?: number;
  errorMs?: number;
}

export class OverlayController {
  private readonly slowMs: number;
  private readonly normalMs: number;
  private readonly warningMs: number;
  private readonly errorMs: number;
  private revision = 0;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;
  private slowTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot: OverlayState = { state: "hidden", text: "", tone: "normal" };

  constructor(
    private readonly emit: (state: OverlayState) => void,
    timing: OverlayTiming = {},
  ) {
    this.slowMs = timing.slowMs ?? 4_000;
    this.normalMs = timing.normalMs ?? 1_200;
    this.warningMs = timing.warningMs ?? 2_400;
    this.errorMs = timing.errorMs ?? 2_800;
  }

  current(): OverlayState {
    return { ...this.snapshot };
  }

  recording(): number {
    return this.active("recording");
  }

  locked(): number {
    return this.active("locked");
  }

  transcribing(): number {
    this.clearTimers();
    const revision = this.publish("transcribing");
    this.slowTimer = setTimeout(() => {
      this.slowTimer = undefined;
      if (revision === this.revision) this.publish("slow", "", "normal", false);
    }, this.slowMs);
    return revision;
  }

  feedback(
    text: string,
    tone: OverlayTone = "normal",
    durationMs = this.durationFor(tone),
  ): number {
    this.clearTimers();
    const revision = this.publish("message", text, tone);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = undefined;
      if (revision === this.revision) this.hide();
    }, durationMs);
    return revision;
  }

  hide(expectedRevision?: number): boolean {
    if (expectedRevision !== undefined && expectedRevision !== this.revision) return false;
    this.clearTimers();
    this.publish("hidden");
    return true;
  }

  dispose(): void {
    this.clearTimers();
  }

  private active(state: "recording" | "locked"): number {
    this.clearTimers();
    return this.publish(state);
  }

  private publish(
    state: OverlayMode,
    text = "",
    tone: OverlayTone = "normal",
    advanceRevision = true,
  ): number {
    if (advanceRevision) this.revision += 1;
    this.snapshot = { state, text, tone };
    this.emit(this.current());
    return this.revision;
  }

  private durationFor(tone: OverlayTone): number {
    if (tone === "warning") return this.warningMs;
    if (tone === "error") return this.errorMs;
    return this.normalMs;
  }

  private clearTimers(): void {
    if (this.hideTimer !== undefined) clearTimeout(this.hideTimer);
    if (this.slowTimer !== undefined) clearTimeout(this.slowTimer);
    this.hideTimer = undefined;
    this.slowTimer = undefined;
  }
}
