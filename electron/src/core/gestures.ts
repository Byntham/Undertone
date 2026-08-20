export const GestureState = {
  idle: "idle",
  held: "held",
  locked: "locked",
  stopping: "stopping",
} as const;

export type GestureState = (typeof GestureState)[keyof typeof GestureState];
export type DictationCompletion = "commit" | "open-turn" | "timeout";

const DEFAULT_TAP_MS = 300;

export interface GestureCallbacks {
  onStart: () => boolean;
  onFinish: (completion: DictationCompletion) => void;
  onDiscard: () => void;
  onLock?: () => void;
  onStopRequested?: () => void;
}

export interface GestureOptions {
  tapMs?: number;
  toggleOnly?: () => boolean;
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
  private readonly toggleOnly: () => boolean;
  private startDeferred = false;
  private recordingStarted = false;

  constructor(
    private readonly callbacks: GestureCallbacks,
    options: GestureOptions = {},
  ) {
    this.tapMs = options.tapMs ?? DEFAULT_TAP_MS;
    this.toggleOnly = options.toggleOnly ?? (() => false);
  }

  get state(): GestureState {
    return this.currentState;
  }

  press(): void {
    if (this.currentState === GestureState.idle) {
      this.pressTimeMs = Date.now();
      this.startDeferred = this.toggleOnly();
      if (this.startDeferred) {
        this.currentState = GestureState.held;
      } else {
        this.recordingStarted = this.callbacks.onStart();
        this.currentState = this.recordingStarted ? GestureState.held : GestureState.idle;
      }
    } else if (this.currentState === GestureState.locked) {
      this.currentState = GestureState.stopping;
      this.callbacks.onStopRequested?.();
    }
  }

  release(): void {
    if (this.currentState === GestureState.stopping) {
      this.currentState = GestureState.idle;
      if (this.recordingStarted) this.callbacks.onFinish("commit");
      this.recordingStarted = false;
      return;
    }
    if (this.currentState !== GestureState.held) return;
    if (this.startDeferred) {
      this.startDeferred = false;
      this.recordingStarted = this.callbacks.onStart();
      this.currentState = this.recordingStarted ? GestureState.locked : GestureState.idle;
      if (this.recordingStarted) this.callbacks.onLock?.();
      return;
    }
    if (Date.now() - this.pressTimeMs < this.tapMs) {
      this.currentState = GestureState.locked;
      this.callbacks.onLock?.();
      return;
    }
    this.currentState = GestureState.idle;
    this.callbacks.onFinish("commit");
    this.recordingStarted = false;
  }

  finishOpenTurn(): boolean {
    if (this.currentState === GestureState.idle) return false;
    this.currentState = GestureState.idle;
    this.startDeferred = false;
    if (this.recordingStarted) this.callbacks.onFinish("open-turn");
    this.recordingStarted = false;
    return true;
  }

  timeout(): boolean {
    if (this.currentState === GestureState.idle) return false;
    this.currentState = GestureState.idle;
    this.startDeferred = false;
    if (this.recordingStarted) this.callbacks.onFinish("timeout");
    this.recordingStarted = false;
    return true;
  }

  cancel(): boolean {
    if (this.currentState === GestureState.idle) return false;
    this.currentState = GestureState.idle;
    this.startDeferred = false;
    if (this.recordingStarted) this.callbacks.onDiscard();
    this.recordingStarted = false;
    return true;
  }
}
