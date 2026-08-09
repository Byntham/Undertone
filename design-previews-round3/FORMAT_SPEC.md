# Undertone Dynamic Island mockup contract

Every concept must use this exact presentation contract so the gallery compares the design, not the demo framing.

## Standalone file

- One self-contained `index.html`; no external assets, fonts, libraries, network requests, or personal data.
- The document is only the mock desktop stage. Do not add a concept title, description, legend, toolbar, phase label, toast, or explanatory copy inside the page. The parent gallery owns all of that.
- `html`, `body`, and `#stage` fill the iframe (`100%` width/height), have zero margin, and hide page overflow.
- Use system UI fonts. Support `prefers-reduced-motion`.

## Shared stage

- Simulate the same neutral desktop in every concept: dark navy/graphite default, a light scene, and a busy scene. Scene changes must not alter island geometry.
- Anchor the island at horizontal center and 88px above the stage bottom.
- Recording indicator content footprint: exactly `54 × 36` CSS px.
- Settled open-turn footprint: exactly `540 × 96` CSS px at viewport widths of at least 700px.
- At narrow widths, the open turn may shrink to `calc(100% - 32px)` but must not overflow.
- Use this exact transcript for `first`: `This is what the turn window looks like right now.`
- Use this exact transcript for `append`: `This is what the turn window looks like right now. The voice indicator and open turn now feel like one continuous surface.`
- No “Open turn,” fragment count, “Live,” or similar metadata.

## Shared lifecycle

Expose exactly this global API after `DOMContentLoaded`:

```js
window.undertonePreview = {
  setPhase(phase), // "recording" | "transcribing" | "first" | "append"
  setScene(scene), // "dark" | "light" | "busy"
  replay(),
  inspect()
};
```

`inspect()` returns a serializable object with at least:

```js
{
  concept: "Concept name",
  phase: "first",
  scene: "dark",
  islandWidth: 540,
  islandHeight: 96,
  controlsOpacity: 0,
  transcript: "..."
}
```

- Also honor `?phase=` and `?scene=` query parameters on first load.
- `replay()` follows the same timing in every concept: recording immediately; transcribing at 1400ms; first/open at 2250ms; append at 3600ms. It must finish in `append` and re-enable any disabled replay state.
- Simulate reactive amplitude during `recording`; processing motion during `transcribing`; settle all signal motion after text appears unless the concept uses a clearly non-live structural trace.
- Phase changes must be deterministic and cancellable: calling `setPhase` cancels replay timers.

## Shared interaction rules

- The transcript is the visual priority in `first` and `append`.
- Snap and discard are present, pointer-only, accessible by `aria-label`, and hidden at rest (`opacity: 0`, `pointer-events: none`). They reveal only when the settled island is hovered.
- Include a subtle drag affordance without permanent instructional copy.
- Discard may animate locally but must restore automatically so comparison remains possible.
- Do not imply the user can type into the unfocusable production window.

## Creative scope

Only vary:

- the island’s material and shape;
- where the live waveform sits;
- how the 54×36 indicator becomes the 540×96 turn;
- how the visualizer settles into the final surface;
- subtle hover treatment.

Do not vary the outer stage, samples, control behavior, dimensions, or timing.
