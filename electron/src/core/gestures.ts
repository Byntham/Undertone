export const GestureState = {
  idle: "idle",
  held: "held",
  locked: "locked",
  stopping: "stopping",
} as const;

export type GestureState = (typeof GestureState)[keyof typeof GestureState];
export type DictationCompletion = "commit" | "open-turn";

export const DEFAULT_TAP_MS = 300;

export interface GestureCallbacks {
  onStart: () => boolean;
  onFinish: (completion: DictationCompletion) => void;
  onDiscard: () => void;
  onLock?: () => void;
}

export interface GestureTiming {
  tapMs?: number;
}

/**
 * Starts recording on the first key-down. A quick release latches recording;
 * a held release finishes and commits. Either form can be diverted into the
 * open turn at any time through finishOpenTurn().
 */
export class TapStateMachine {
  private currentState: GestureState = GestureState.idle;
  private pressTimeMs = 0;
  private readonly tapMs: number;

  constructor(
    private readonly callbacks: GestureCallbacks,
    timing: GestureTiming = {},
  ) {
    this.tapMs = timing.tapMs ?? DEFAULT_TAP_MS;
  }

  get state(): GestureState {
    return this.currentState;
  }

  press(): void {
    if (this.currentState === GestureState.idle) {
      this.pressTimeMs = Date.now();
      this.currentState = this.callbacks.onStart()
        ? GestureState.held
        : GestureState.idle;
    } else if (this.currentState === GestureState.locked) {
      this.currentState = GestureState.stopping;
    }
  }

  release(): void {
    if (this.currentState === GestureState.stopping) {
      this.currentState = GestureState.idle;
      this.callbacks.onFinish("commit");
      return;
    }
    if (this.currentState !== GestureState.held) return;
    if (Date.now() - this.pressTimeMs < this.tapMs) {
      this.currentState = GestureState.locked;
      this.callbacks.onLock?.();
      return;
    }
    this.currentState = GestureState.idle;
    this.callbacks.onFinish("commit");
  }

  finishOpenTurn(): boolean {
    if (this.currentState === GestureState.idle) return false;
    this.currentState = GestureState.idle;
    this.callbacks.onFinish("open-turn");
    return true;
  }

  cancel(): boolean {
    if (this.currentState === GestureState.idle) return false;
    this.currentState = GestureState.idle;
    this.callbacks.onDiscard();
    return true;
  }
}
