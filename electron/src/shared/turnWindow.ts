export const INTEGRATED_TURN_WINDOW_DESIGNS = [
  "smoked-rim",
  "slate-pulse",
  "aurora-rim",
] as const;

export const TURN_WINDOW_DESIGNS = [
  "smoked-glass",
  "quiet-slate",
  "center-rail",
  "aurora-film",
  ...INTEGRATED_TURN_WINDOW_DESIGNS,
] as const;

export type TurnWindowDesign = typeof TURN_WINDOW_DESIGNS[number];
export type IntegratedTurnWindowDesign = typeof INTEGRATED_TURN_WINDOW_DESIGNS[number];
export type TurnFeedbackFamily = "five-bar" | "turn-window";

export function isTurnWindowDesign(value: unknown): value is TurnWindowDesign {
  return typeof value === "string"
    && (TURN_WINDOW_DESIGNS as readonly string[]).includes(value);
}

export function isIntegratedTurnWindowDesign(
  value: unknown,
): value is IntegratedTurnWindowDesign {
  return typeof value === "string"
    && (INTEGRATED_TURN_WINDOW_DESIGNS as readonly string[]).includes(value);
}

export function turnFeedbackFamily(
  design: TurnWindowDesign,
  liveTranscription: boolean,
): TurnFeedbackFamily {
  return liveTranscription || isIntegratedTurnWindowDesign(design)
    ? "turn-window"
    : "five-bar";
}
