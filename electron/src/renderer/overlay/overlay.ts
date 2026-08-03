import type { OverlayState } from "../../preload/overlayPreload";
import "./style.css";

declare global {
  interface Window {
    undertoneOverlay?: {
      onState: (listener: (state: OverlayState) => void) => () => void;
      onLevel: (listener: (level: number) => void) => () => void;
    };
  }
}

const pill = document.querySelector<HTMLDivElement>("#pill");
const label = document.querySelector<HTMLSpanElement>("#label");
const check = document.querySelector<HTMLSpanElement>("#check");
const bars = [...document.querySelectorAll<HTMLElement>("#bars i")];

if (pill === null || label === null || check === null || bars.length === 0) {
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
