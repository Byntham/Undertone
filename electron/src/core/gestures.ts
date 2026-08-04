export const GestureState = {
  idle: "idle",
  held: "held",
  tapWait: "tap_wait",
  locked: "locked",
} as const;

export type GestureState = (typeof GestureState)[keyof typeof GestureState];

export interface GestureCallbacks {
  onStart: () => boolean;
  onFinish: () => void;
  onDiscard: (reason: "cancel" | "short-tap") => void;
  onLock?: () => void;
}

export interface GestureTiming {
  shortTapMs?: number;
  doubleTapMs?: number;
}

export class TapStateMachine {
  private currentState: GestureState = GestureState.idle;
  private pressTimeMs = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly shortTapMs: number;
  private readonly doubleTapMs: number;

  constructor(
    private readonly callbacks: GestureCallbacks,
    timing: GestureTiming = {},
  ) {
    this.shortTapMs = timing.shortTapMs ?? 300;
    this.doubleTapMs = timing.doubleTapMs ?? 400;
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
    } else if (this.currentState === GestureState.tapWait) {
      this.cancelTimer();
      this.currentState = GestureState.locked;
      this.callbacks.onLock?.();
    } else if (this.currentState === GestureState.locked) {
      this.currentState = GestureState.idle;
      this.callbacks.onFinish();
    }
  }

  release(): void {
    if (this.currentState !== GestureState.held) {
      return;
    }
    if (Date.now() - this.pressTimeMs < this.shortTapMs) {
      this.currentState = GestureState.tapWait;
      this.timer = setTimeout(() => this.expireTap(), this.doubleTapMs);
    } else {
      this.currentState = GestureState.idle;
      this.callbacks.onFinish();
    }
  }

  cancel(): boolean {
    if (this.currentState === GestureState.idle) {
      return false;
    }
    this.cancelTimer();
    this.currentState = GestureState.idle;
    this.callbacks.onDiscard("cancel");
    return true;
  }

  private expireTap(): void {
    this.timer = undefined;
    if (this.currentState !== GestureState.tapWait) {
      return;
    }
    this.currentState = GestureState.idle;
    this.callbacks.onDiscard("short-tap");
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
