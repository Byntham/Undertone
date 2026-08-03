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
