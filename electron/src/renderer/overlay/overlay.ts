import type { OverlayState } from "../../shared/overlay";
import "./style.css";

declare global {
  interface Window {
    undertoneOverlay?: {
      onState: (listener: (state: OverlayState) => void) => () => void;
    };
  }
}

const pill = document.querySelector<HTMLDivElement>("#pill");
const label = document.querySelector<HTMLSpanElement>("#label");
const check = document.querySelector<HTMLSpanElement>("#check");

if (pill === null || label === null || check === null) {
  throw new Error("Overlay markup is incomplete");
}

let mode: OverlayState["state"] = "hidden";
let hiddenResetTimer: ReturnType<typeof setTimeout> | undefined;

window.undertoneOverlay?.onState(({ state, text, tone }) => {
  if (hiddenResetTimer !== undefined) clearTimeout(hiddenResetTimer);
  hiddenResetTimer = undefined;
  mode = state;
  if (state !== "message") {
    pill.classList.add("hidden");
    pill.setAttribute("aria-hidden", "true");
    hiddenResetTimer = setTimeout(() => {
      hiddenResetTimer = undefined;
      if (mode === "message") return;
      pill.className = "pill hidden";
    }, 140);
    return;
  }
  pill.className = `pill message ${tone}`;
  pill.removeAttribute("aria-hidden");
  label.textContent = text;
  check.textContent = tone === "error" ? "×" : tone === "warning" ? "!" : "";
  pill.setAttribute("aria-label", text);
});
