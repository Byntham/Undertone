import type { TurnWindowDesign } from "./turnWindow";

export type OverlayMode =
  | "recording"
  | "locked"
  | "transcribing"
  | "slow"
  | "signal"
  | "message"
  | "hidden";

export type OverlayTone = "normal" | "success" | "warning" | "error";

export interface OverlayState {
  state: OverlayMode;
  text: string;
  tone: OverlayTone;
}

/** Live open-turn draft shown while recording or composing fragments. */
export interface TurnDraftView {
  design: TurnWindowDesign;
  text: string;
  fragmentCount: number;
  charCount: number;
  liveState: "listening" | "finalizing" | null;
  presentation: "visible" | "dismissing";
  /** Monotonic token used to reject stale dismissal completions. */
  revision: number;
  activity:
    | "idle"
    | "recording"
    | "locked"
    | "transcribing"
    | "slow"
    | "listening"
    | "finalizing";
}

export function canHideTurnDraftAfterDismissal(
  pendingRevision: number | null,
  completedRevision: unknown,
  hasActiveWork: boolean,
): boolean {
  return pendingRevision !== null
    && Number.isSafeInteger(completedRevision)
    && completedRevision === pendingRevision
    && !hasActiveWork;
}
