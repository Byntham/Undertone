import type { OverlayState, TurnDraftView } from "../../shared/overlay";
import "./style.css";

declare global {
  interface Window {
    undertoneOverlay?: {
      onState: (listener: (state: OverlayState) => void) => () => void;
      onLevel: (listener: (level: number) => void) => () => void;
      onTurnDraft: (listener: (draft: TurnDraftView | null) => void) => () => void;
    };
  }
}

const pill = document.querySelector<HTMLDivElement>("#pill");
const label = document.querySelector<HTMLSpanElement>("#label");
const check = document.querySelector<HTMLSpanElement>("#check");
const draft = document.querySelector<HTMLDivElement>("#draft");
const draftMeta = document.querySelector<HTMLSpanElement>("#draftMeta");
const draftList = document.querySelector<HTMLOListElement>("#draftList");
const bars = [...document.querySelectorAll<HTMLElement>("#bars i")];

if (
  pill === null
  || label === null
  || check === null
  || draft === null
  || draftMeta === null
  || draftList === null
  || bars.length === 0
) {
  throw new Error("Overlay markup is incomplete");
}

let mode: OverlayState["state"] = "hidden";
let envelope = 0;
const levelHistory = bars.map(() => 0);
let hiddenResetTimer: ReturnType<typeof setTimeout> | undefined;

window.undertoneOverlay?.onState(({ state, text, tone }) => {
  if (hiddenResetTimer !== undefined) clearTimeout(hiddenResetTimer);
  hiddenResetTimer = undefined;
  mode = state;
  if (state === "hidden") {
    pill.classList.add("hidden");
    pill.setAttribute("aria-hidden", "true");
    hiddenResetTimer = setTimeout(() => {
      hiddenResetTimer = undefined;
      if (mode !== "hidden") return;
      pill.className = "pill hidden";
      for (const bar of bars) bar.style.removeProperty("height");
    }, 140);
    return;
  }
  pill.className = `pill ${state} ${tone}`;
  pill.removeAttribute("aria-hidden");
  label.textContent = text;
  check.textContent = tone === "error" ? "×" : tone === "warning" ? "!" : "";
  pill.setAttribute("aria-label", accessibleLabel(state, text));
  if (state === "recording" || state === "locked") {
    envelope = 0;
    levelHistory.fill(0);
    renderWave();
  } else {
    for (const bar of bars) bar.style.removeProperty("height");
  }
});

window.undertoneOverlay?.onLevel((rms) => {
  if ((mode !== "recording" && mode !== "locked")
    || !Number.isFinite(rms)) return;
  const decibels = 20 * Math.log10(Math.max(0.00001, rms));
  const normalized = Math.max(0, Math.min(1, (decibels + 52) / 38));
  const target = normalized < 0.12 ? 0 : (normalized - 0.12) / 0.88;
  envelope = target > envelope
    ? envelope * 0.2 + target * 0.8
    : envelope * 0.68 + target * 0.32;
  levelHistory.pop();
  levelHistory.unshift(envelope);
  renderWave();
});

window.undertoneOverlay?.onTurnDraft((view) => {
  if (view === null || view.fragments.length === 0) {
    draft.classList.add("hidden");
    draft.setAttribute("aria-hidden", "true");
    draftList.replaceChildren();
    draftMeta.textContent = "";
    return;
  }
  draft.classList.remove("hidden");
  draft.removeAttribute("aria-hidden");
  draftMeta.textContent = `Open turn · ${view.fragmentCount} · ${view.charCount}c`;
  const maxVisible = 8;
  const fragments = view.fragments;
  const start = Math.max(0, fragments.length - maxVisible);
  const visible = fragments.slice(start);
  draftList.replaceChildren(...visible.map((fragment, offset) => {
    const index = start + offset + 1;
    const item = document.createElement("li");
    if (index === fragments.length) item.classList.add("latest");
    const marker = document.createElement("span");
    marker.className = "index";
    marker.textContent = String(index);
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = fragment.trim().length > 0 ? fragment : "·";
    item.append(marker, text);
    return item;
  }));
  if (start > 0) {
    const more = document.createElement("li");
    const marker = document.createElement("span");
    marker.className = "index";
    marker.textContent = "…";
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = `${start} earlier fragment${start === 1 ? "" : "s"}`;
    more.append(marker, text);
    draftList.prepend(more);
  }
});

function renderWave(): void {
  bars.forEach((bar, index) => {
    bar.style.height = `${Math.round(3 + (levelHistory[index] ?? 0) * 16)}px`;
  });
}

function accessibleLabel(state: OverlayState["state"], text: string): string {
  if (state === "recording") return "Recording";
  if (state === "locked") return "Recording locked";
  if (state === "transcribing") return "Transcribing";
  if (state === "slow") return "Transcription is taking longer";
  return text;
}
