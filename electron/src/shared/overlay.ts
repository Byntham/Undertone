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
  text: string;
  fragmentCount: number;
  charCount: number;
  liveState: "listening" | "finalizing" | null;
}
