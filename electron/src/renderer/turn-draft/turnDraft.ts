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

type ActivityView = TurnDraftView & {
  activity?: DraftActivity;
  presentation?: "visible" | "dismissing";
  revision?: number;
};

declare global {
  interface Window {
    undertoneTurnDraft?: {
      discard: () => void;
      snap: () => void;
      reportContentHeight: (height: number) => void;
      completeDismiss: (revision: number) => void;
      onView: (listener: (draft: TurnDraftView) => void) => () => void;
      onLevel: (listener: (level: number) => void) => () => void;
    };
  }
}

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
const signalRim = requiredElement<SVGSVGElement>("#signalRim");
const signalPath = requiredElement<SVGRectElement>("#signalPath");
const discard = requiredElement<HTMLButtonElement>("#discard");
const snap = requiredElement<HTMLButtonElement>("#snap");

let currentDesign: TurnWindowDesign | null = null;
let currentActivity: DraftActivity = "idle";
let rendered = false;
let envelope = 0;
let layoutFrame: number | undefined;
let lastRequestedHeight: number | undefined;
let dismissingRevision: number | null = null;
let completedDismissalRevision: number | null = null;

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
  let height: number;
  if (contentIsEmpty()) {
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

function sizeSignalPath(): void {
  const width = draft.clientWidth;
  const height = draft.clientHeight;
  const inset = 1.25;
  signalRim.setAttribute("viewBox", `0 0 ${width} ${height}`);
  signalPath.setAttribute("x", String(inset));
  signalPath.setAttribute("y", String(inset));
  signalPath.setAttribute("width", String(Math.max(0, width - inset * 2)));
  signalPath.setAttribute("height", String(Math.max(0, height - inset * 2)));
  signalPath.setAttribute("rx", String(Math.max(0, Math.min(27, height / 2 - inset))));
}

function cancelDismissal(): void {
  dismissingRevision = null;
  draft.classList.remove("dismissing");
}

function completeDismissal(revision: number): void {
  if (dismissingRevision !== revision || completedDismissalRevision === revision) return;
  completedDismissalRevision = revision;
  rendered = false;
  window.undertoneTurnDraft?.completeDismiss(revision);
}

function startDismissal(revision: number): void {
  if (dismissingRevision === revision) return;
  dismissingRevision = revision;
  completedDismissalRevision = null;
  draft.classList.remove("reveal", "dismissing");
  void draft.offsetWidth;
  draft.classList.add("dismissing");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    requestAnimationFrame(() => { completeDismissal(revision); });
  }
}

new ResizeObserver(scheduleLayout).observe(draftViewport);
new ResizeObserver(sizeSignalPath).observe(draft);
sizeSignalPath();
window.addEventListener("resize", scheduleLayout);

discard.addEventListener("click", () => { window.undertoneTurnDraft?.discard(); });
snap.addEventListener("click", () => { window.undertoneTurnDraft?.snap(); });

draft.addEventListener("animationend", (event) => {
  if (event.animationName === "surfaceReveal") draft.classList.remove("reveal");
  if (event.animationName === "draftDismiss" && dismissingRevision !== null) {
    completeDismissal(dismissingRevision);
  }
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
  const presentation = view.presentation ?? "visible";
  const revision = Number.isSafeInteger(view.revision) ? (view.revision ?? 0) : 0;
  const reveal = !rendered;
  const activityChanged = nextActivity !== currentActivity;

  draft.dataset.presentation = presentation;
  draft.dataset.revision = String(revision);
  if (presentation === "dismissing") {
    startDismissal(revision);
    return;
  }
  cancelDismissal();

  currentDesign = design;
  currentActivity = nextActivity;
  rendered = true;
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
