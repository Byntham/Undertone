export type OverlayMode =
  | "recording"
  | "locked"
  | "transcribing"
  | "slow"
  | "message"
  | "hidden";

export type OverlayTone = "normal" | "warning" | "error";

export interface OverlayState {
  state: OverlayMode;
  text: string;
  tone: OverlayTone;
}

export interface OverlayBridge {
  onState: (listener: (state: OverlayState) => void) => () => void;
}

/** Live open-turn draft shown while recording or composing fragments. */
export interface TurnDraftView {
  text: string;
  presentation: "visible" | "dismissing";
  statusText: string | null;
  /** Monotonic token used to reject stale dismissal completions. */
  revision: number;
  activity:
    | "idle"
    | "recording"
    | "locked"
    | "transcribing"
    | "slow"
    | "listening"
    | "finalizing"
    | "warning"
    | "error";
}

export interface TurnDraftBridge {
  discard: () => void;
  snap: () => void;
  reportContentHeight: (height: number) => void;
  completeDismiss: (revision: number) => void;
  onView: (listener: (draft: TurnDraftView) => void) => () => void;
  onLevel: (listener: (level: number) => void) => () => void;
}

export type TurnDraftMode = "hidden" | "compact" | "text";

export function nextTurnDraftMode(
  current: TurnDraftMode,
  hasText: boolean,
  fullWindow: boolean,
  presentation: TurnDraftView["presentation"],
): TurnDraftMode {
  if (presentation === "dismissing") return current;
  return !hasText && !fullWindow ? "compact" : "text";
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

export function hasActiveTurnDraftWork(
  hasBufferedTurn: boolean,
  activeCaptureIds: readonly number[],
  excludedCaptureId?: number,
): boolean {
  return hasBufferedTurn
    || activeCaptureIds.some((captureId) => captureId !== excludedCaptureId);
}
