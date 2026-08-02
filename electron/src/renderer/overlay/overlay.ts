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

if (pill === null || label === null) {
  throw new Error("Overlay markup is incomplete");
}

window.undertoneOverlay?.onState(({ state, text }) => {
  pill.className = `pill ${state}`;
  label.textContent = text;
});
