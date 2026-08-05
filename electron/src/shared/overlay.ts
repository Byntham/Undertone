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

/** Live open-turn draft shown while stack mode has fragments. */
export interface TurnDraftView {
  fragments: string[];
  fragmentCount: number;
  charCount: number;
}
