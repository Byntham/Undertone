import type { TurnDraftView } from "../../shared/overlay";
import {
  isIntegratedTurnWindowDesign,
  isTurnWindowDesign,
  type TurnWindowDesign,
} from "../../shared/turnWindow";
import "./style.css";

type DraftActivity =
  | "idle"
  | "recording"
  | "locked"
  | "transcribing"
  | "slow"
  | "listening"
  | "finalizing";

type ActivityView = TurnDraftView & { activity?: DraftActivity };

declare global {
  interface Window {
    undertoneTurnDraft?: {
      discard: () => void;
      snap: () => void;
      reportContentHeight: (height: number) => void;
      onView: (listener: (draft: TurnDraftView) => void) => () => void;
      onLevel: (listener: (level: number) => void) => () => void;
    };
  }
}

const COMPACT_HEIGHT = 44;
const TEXT_BASE_HEIGHT = 68;
const BODY_GUTTERS = 12;
const TEXT_CHROME = 16;
const TEXT_MEASUREMENT_SLACK = 2;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing open-turn element: ${selector}`);
  return element;
}

const draft = requiredElement<HTMLElement>("#draft");
const draftViewport = requiredElement<HTMLDivElement>("#draftViewport");
const draftText = requiredElement<HTMLDivElement>("#draftText");
requiredElement<HTMLDivElement>("#signalRim");
const discard = requiredElement<HTMLButtonElement>("#discard");
const snap = requiredElement<HTMLButtonElement>("#snap");

let currentDesign: TurnWindowDesign | null = null;
let currentActivity: DraftActivity = "idle";
let rendered = false;
let renderedEmpty = false;
let envelope = 0;
let layoutFrame: number | undefined;
let lastRequestedHeight: number | undefined;

function contentIsEmpty(): boolean {
  return draft.dataset.empty === "true";
}

function lineHeight(): number {
  const value = Number.parseFloat(getComputedStyle(draftText).lineHeight);
  return Number.isFinite(value) && value > 0 ? value : 20;
}

function fullTextHeight(): number {
  const previousHeight = draftText.style.height;
  draftText.style.height = "auto";
  const height = draftText.scrollHeight;
  draftText.style.height = previousHeight;
  const line = lineHeight();
  return Math.max(line, Math.ceil(height / line) * line);
}

function fitTextViewport(): void {
  if (contentIsEmpty()) return;
  const line = lineHeight();
  const maximumHeight = Math.max(
    line,
    Math.floor(draftViewport.clientHeight / line) * line,
  );
  const contentHeight = fullTextHeight();
  draftText.style.height = `${Math.min(maximumHeight, contentHeight)}px`;
  draftText.scrollTop = draftText.scrollHeight;
}

function requestContentHeight(): void {
  layoutFrame = undefined;
  const integrated = currentDesign !== null
    && isIntegratedTurnWindowDesign(currentDesign);
  let height: number;
  if (contentIsEmpty() && integrated) {
    height = COMPACT_HEIGHT;
  } else if (contentIsEmpty()) {
    height = TEXT_BASE_HEIGHT;
  } else {
    // Ignore the transient narrow frame while the native window grows from
    // the compact indicator into its text width. ResizeObserver retries it.
    if (draftViewport.clientWidth < 180) return;
    height = Math.max(
      TEXT_BASE_HEIGHT,
      Math.ceil(BODY_GUTTERS + TEXT_CHROME + fullTextHeight() + TEXT_MEASUREMENT_SLACK),
    );
  }
  fitTextViewport();
  if (height === lastRequestedHeight) return;
  lastRequestedHeight = height;
  window.undertoneTurnDraft?.reportContentHeight(height);
}

function scheduleLayout(): void {
  if (layoutFrame !== undefined) cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(requestContentHeight);
}

new ResizeObserver(scheduleLayout).observe(draftViewport);
window.addEventListener("resize", scheduleLayout);

discard.addEventListener("click", () => { window.undertoneTurnDraft?.discard(); });
snap.addEventListener("click", () => { window.undertoneTurnDraft?.snap(); });

draft.addEventListener("animationend", (event) => {
  if (event.animationName === "surfaceReveal") draft.classList.remove("reveal");
});

window.undertoneTurnDraft?.onLevel((rms) => {
  if (!(["recording", "locked", "listening"] as DraftActivity[])
    .includes(currentActivity) || !Number.isFinite(rms)) return;
  const decibels = 20 * Math.log10(Math.max(0.00001, rms));
  const normalized = Math.max(0, Math.min(1, (decibels + 52) / 38));
  const target = normalized < 0.12 ? 0 : (normalized - 0.12) / 0.88;
  envelope = target > envelope
    ? envelope * 0.2 + target * 0.8
    : envelope * 0.68 + target * 0.32;
  draft.style.setProperty("--voice-level", envelope.toFixed(3));
});

window.undertoneTurnDraft?.onView((incoming) => {
  const view = incoming as ActivityView;
  const candidate = view.design;
  const design = isTurnWindowDesign(candidate) ? candidate : "smoked-glass";
  const integrated = isIntegratedTurnWindowDesign(design);
  const empty = view.text.trim().length === 0;
  const fallbackActivity = view.liveState === "listening"
    ? "listening"
    : view.liveState === "finalizing" ? "finalizing" : "idle";
  const nextActivity = view.activity ?? fallbackActivity;
  const reveal = !rendered || design !== currentDesign || empty !== renderedEmpty;
  const activityChanged = nextActivity !== currentActivity;

  currentDesign = design;
  currentActivity = nextActivity;
  rendered = true;
  renderedEmpty = empty;
  draft.dataset.design = design;
  draft.dataset.integrated = String(integrated);
  draft.dataset.empty = String(empty);
  draft.dataset.activity = nextActivity;
  draft.dataset.liveState = view.liveState ?? "idle";
  draftText.textContent = view.text;
  draft.setAttribute(
    "aria-label",
    empty ? "Undertone voice activity" : "Open turn",
  );

  if (activityChanged) {
    envelope = 0;
    draft.style.setProperty("--voice-level", "0");
  }
  scheduleLayout();
  if (reveal) {
    draft.classList.remove("reveal");
    void draft.offsetWidth;
    draft.classList.add("reveal");
  }
});
