import type { OverlayState } from "../../preload/overlayPreload";
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

window.undertoneOverlay?.onState(({ state, text, tone = "normal" }) => {
  pill.className = `pill ${state} ${tone}`;
  label.textContent = text;
  check.textContent = tone === "error" ? "×" : tone === "warning" ? "!" : "✓";
});
