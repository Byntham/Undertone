import type { TurnDraftView } from "../../shared/overlay";
import "./style.css";

declare global {
  interface Window {
    undertoneTurnDraft?: {
      discard: () => void;
      snap: () => void;
      onView: (listener: (draft: TurnDraftView) => void) => () => void;
    };
  }
}

const draftMeta = document.querySelector<HTMLSpanElement>("#draftMeta");
const draftViewport = document.querySelector<HTMLDivElement>("#draftViewport");
const draftText = document.querySelector<HTMLDivElement>("#draftText");
const discard = document.querySelector<HTMLButtonElement>("#discard");
const snap = document.querySelector<HTMLButtonElement>("#snap");

if (draftMeta === null || draftViewport === null || draftText === null
    || discard === null || snap === null) {
  throw new Error("Open-turn draft markup is incomplete");
}

const fitTextViewport = (): void => {
  const lineHeight = Number.parseFloat(getComputedStyle(draftText).lineHeight);
  const height = Math.floor(draftViewport.clientHeight / lineHeight) * lineHeight;
  draftText.style.height = `${Math.max(lineHeight, height)}px`;
  draftText.scrollTop = draftText.scrollHeight;
};

new ResizeObserver(fitTextViewport).observe(draftViewport);

discard.addEventListener("click", () => { window.undertoneTurnDraft?.discard(); });
snap.addEventListener("click", () => { window.undertoneTurnDraft?.snap(); });

window.undertoneTurnDraft?.onView((view) => {
  const count = view.fragmentCount === 1
    ? "Open turn · 1 fragment"
    : `Open turn · ${view.fragmentCount} fragments`;
  draftMeta.textContent = view.liveState === "listening"
    ? `${count} · Live`
    : view.liveState === "finalizing" ? `${count} · Finalizing` : count;
  draftText.textContent = view.text;
  fitTextViewport();
});
