export interface ShortcutKeyEvent {
  eventType: "down" | "up";
  virtualKey: number;
  injected?: boolean;
}

export interface ShortcutTransition {
  pressed: boolean;
  released: boolean;
  completed: boolean;
  keyBelongsToShortcut: boolean;
}

interface ShortcutPart {
  name: string;
  virtualKeys: ReadonlySet<number>;
  modifier: boolean;
}

const NAMED_KEYS: Readonly<Record<string, readonly number[]>> = {
  ctrl: [0x11, 0xa2, 0xa3],
  "left ctrl": [0xa2],
  "right ctrl": [0xa3],
  shift: [0x10, 0xa0, 0xa1],
  "left shift": [0xa0],
  "right shift": [0xa1],
  alt: [0x12, 0xa4, 0xa5],
  "left alt": [0xa4],
  "right alt": [0xa5],
  windows: [0x5b, 0x5c],
  "left windows": [0x5b],
  "right windows": [0x5c],
  backspace: [0x08],
  tab: [0x09],
  enter: [0x0d],
  "caps lock": [0x14],
  esc: [0x1b],
  space: [0x20],
  "page up": [0x21],
  "page down": [0x22],
  end: [0x23],
  home: [0x24],
  left: [0x25],
  up: [0x26],
  right: [0x27],
  down: [0x28],
  "print screen": [0x2c],
  insert: [0x2d],
  delete: [0x2e],
  "num lock": [0x90],
  "scroll lock": [0x91],
  "num multiply": [0x6a],
  "num add": [0x6b],
  "num subtract": [0x6d],
  "num decimal": [0x6e],
  "num divide": [0x6f],
  "volume mute": [0xad],
  "volume down": [0xae],
  "volume up": [0xaf],
  "media next": [0xb0],
  "media previous": [0xb1],
  "media stop": [0xb2],
  "media play pause": [0xb3],
  semicolon: [0xba],
  equals: [0xbb],
  comma: [0xbc],
  minus: [0xbd],
  period: [0xbe],
  slash: [0xbf],
  backtick: [0xc0],
  "left bracket": [0xdb],
  backslash: [0xdc],
  "right bracket": [0xdd],
  quote: [0xde],
};

const ALIASES: Readonly<Record<string, string>> = {
  control: "ctrl",
  "left control": "left ctrl",
  "right control": "right ctrl",
  win: "windows",
  "left win": "left windows",
  "right win": "right windows",
  escape: "esc",
  return: "enter",
  del: "delete",
  ins: "insert",
  pgup: "page up",
  pgdn: "page down",
  " ": "space",
};

export class ShortcutBinding {
  private parts: readonly ShortcutPart[] = [];
  private readonly down = new Set<number>();
  private active = false;
  private completionPending = false;

  constructor(shortcut = "", allowEmpty = false) {
    this.set(shortcut, allowEmpty);
  }

  set(shortcut: string, allowEmpty = false): void {
    this.parts = parseShortcut(shortcut, allowEmpty);
    this.down.clear();
    this.active = false;
    this.completionPending = false;
  }

  update(event: ShortcutKeyEvent): ShortcutTransition {
    if (event.eventType === "down") this.down.add(event.virtualKey);
    else this.down.delete(event.virtualKey);
    const nextActive = this.parts.length > 0
      && this.parts.every((part) => intersects(part.virtualKeys, this.down));
    const pressed = nextActive && !this.active;
    if (pressed) this.completionPending = true;
    const completed = event.eventType === "up"
      && this.completionPending
      && !this.hasShortcutKeyDown();
    if (completed) this.completionPending = false;
    const transition = {
      pressed,
      released: !nextActive && this.active,
      completed,
      keyBelongsToShortcut: this.matchesKey(event.virtualKey),
    };
    this.active = nextActive;
    return transition;
  }

  matchesKey(virtualKey: number): boolean {
    return this.parts.some((part) => part.virtualKeys.has(virtualKey));
  }

  private hasShortcutKeyDown(): boolean {
    return this.parts.some((part) => intersects(part.virtualKeys, this.down));
  }
}

/**
 * A one-shot shortcut with one non-modifier trigger key. The configured
 * modifiers must match exactly when the trigger goes down. Key-repeat events
 * are ignored, but another trigger tap can fire while modifiers remain held.
 */
export class ActionShortcutBinding {
  private parts: readonly ShortcutPart[] = [];
  private modifiers: readonly ShortcutPart[] = [];
  private trigger: ShortcutPart | null = null;
  private readonly down = new Set<number>();
  private armed = false;
  private blockedUntilRelease = false;

  constructor(
    shortcut = "",
    private readonly completeOn: "trigger" | "release" = "trigger",
    allowEmpty = false,
  ) {
    this.set(shortcut, allowEmpty);
  }

  set(shortcut: string, allowEmpty = false): void {
    const parts = this.completeOn === "trigger"
      ? parseTriggerShortcut(shortcut, allowEmpty)
      : parseReleaseShortcut(shortcut, allowEmpty);
    this.parts = parts;
    this.modifiers = parts.filter((part) => part.modifier);
    this.trigger = parts.find((part) => !part.modifier) ?? null;
    this.down.clear();
    this.armed = false;
    this.blockedUntilRelease = false;
  }

  update(event: ShortcutKeyEvent): ShortcutTransition {
    const repeated = event.eventType === "down" && this.down.has(event.virtualKey);
    if (event.eventType === "down") this.down.add(event.virtualKey);
    else this.down.delete(event.virtualKey);
    const newKeyDown = !repeated && event.eventType === "down";
    if (this.completeOn === "release"
      && this.armed
      && newKeyDown
      && !this.matchesKey(event.virtualKey)) {
      this.armed = false;
      this.blockedUntilRelease = true;
    }
    const triggerPressed = newKeyDown
      && this.trigger?.virtualKeys.has(event.virtualKey) === true
      && this.modifiersMatchExactly();
    const modifierChordPressed = newKeyDown
      && this.trigger === null
      && this.parts.length > 0
      && this.modifiersMatchExactly()
      && [...this.down].every(isModifierVirtualKey);
    const pressed = !this.blockedUntilRelease
      && (triggerPressed || modifierChordPressed);
    if (pressed && this.completeOn === "release") this.armed = true;
    const released = event.eventType === "up"
      && this.armed
      && !this.hasShortcutKeyDown()
      && ![...this.down].some(isModifierVirtualKey);
    const completed = this.completeOn === "trigger" ? pressed : released;
    if (released) this.armed = false;
    if (this.blockedUntilRelease && !this.hasShortcutKeyDown()) {
      this.blockedUntilRelease = false;
    }
    return {
      pressed,
      released,
      completed,
      keyBelongsToShortcut: this.matchesKey(event.virtualKey),
    };
  }

  matchesKey(virtualKey: number): boolean {
    return this.parts.some((part) => part.virtualKeys.has(virtualKey));
  }

  private modifiersMatchExactly(): boolean {
    if (!this.modifiers.every((part) => intersects(part.virtualKeys, this.down))) {
      return false;
    }
    return [...this.down].every((virtualKey) => (
      !isModifierVirtualKey(virtualKey)
      || this.modifiers.some((part) => part.virtualKeys.has(virtualKey))
    ));
  }

  private hasShortcutKeyDown(): boolean {
    return this.parts.some((part) => intersects(part.virtualKeys, this.down));
  }
}

export class ShortcutCapture {
  private readonly down = new Set<number>();
  private readonly captured: string[] = [];
  private cancelled = false;

  update(event: ShortcutKeyEvent): { done: boolean; shortcut: string | null } {
    const name = keyName(event.virtualKey);
    if (name === null) return { done: false, shortcut: null };
    if (event.eventType === "down") {
      if (this.down.has(event.virtualKey)) return { done: false, shortcut: null };
      this.down.add(event.virtualKey);
      if (event.virtualKey === 0x1b) this.cancelled = true;
      else if (!this.captured.includes(name)) this.captured.push(name);
      return { done: false, shortcut: null };
    }
    this.down.delete(event.virtualKey);
    if (this.down.size > 0 || (!this.cancelled && this.captured.length === 0)) {
      return { done: false, shortcut: null };
    }
    return {
      done: true,
      shortcut: this.cancelled ? null : normalizeShortcut(this.captured.join("+")),
    };
  }
}

export function normalizeShortcut(shortcut: string, allowEmpty = false): string {
  return parseShortcut(shortcut, allowEmpty).map((part) => part.name).join("+");
}

export function normalizeTriggerShortcut(shortcut: string, allowEmpty = false): string {
  return parseTriggerShortcut(shortcut, allowEmpty).map((part) => part.name).join("+");
}

export function normalizeReleaseShortcut(shortcut: string, allowEmpty = false): string {
  return parseReleaseShortcut(shortcut, allowEmpty).map((part) => part.name).join("+");
}

function keyName(virtualKey: number): string | null {
  if (virtualKey >= 0x41 && virtualKey <= 0x5a) {
    return String.fromCharCode(virtualKey).toLowerCase();
  }
  if (virtualKey >= 0x30 && virtualKey <= 0x39) return String.fromCharCode(virtualKey);
  if (virtualKey >= 0x70 && virtualKey <= 0x87) return `f${virtualKey - 0x6f}`;
  if (virtualKey >= 0x60 && virtualKey <= 0x69) return `num ${virtualKey - 0x60}`;
  for (const [name, codes] of Object.entries(NAMED_KEYS)) {
    if (name === "ctrl" || name === "shift" || name === "alt" || name === "windows") continue;
    if (codes.includes(virtualKey)) return name;
  }
  return null;
}

function parseShortcut(shortcut: string, allowEmpty: boolean): readonly ShortcutPart[] {
  const rawParts = shortcut.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (rawParts.length === 0) {
    if (allowEmpty) return [];
    throw new Error("Choose a key or key combination");
  }
  const names = rawParts.map((part) => ALIASES[part] ?? part);
  if (new Set(names).size !== names.length) throw new Error("Shortcut contains a duplicate key");
  return names.map((name) => {
    const virtualKeys = virtualKeysForName(name);
    if (virtualKeys === null) throw new Error(`'${name}' is not a supported key name`);
    return { name, virtualKeys: new Set(virtualKeys), modifier: isModifierName(name) };
  });
}

function parseTriggerShortcut(shortcut: string, allowEmpty: boolean): readonly ShortcutPart[] {
  const parts = parseShortcut(shortcut, allowEmpty);
  if (parts.length === 0) return parts;
  if (parts.filter((part) => !part.modifier).length !== 1) {
    throw new Error("Choose exactly one non-modifier trigger key");
  }
  return parts;
}

function parseReleaseShortcut(shortcut: string, allowEmpty: boolean): readonly ShortcutPart[] {
  const parts = parseShortcut(shortcut, allowEmpty);
  if (parts.filter((part) => !part.modifier).length > 1) {
    throw new Error("Choose at most one non-modifier trigger key");
  }
  return parts;
}

function virtualKeysForName(name: string): readonly number[] | null {
  const named = NAMED_KEYS[name];
  if (named !== undefined) return named;
  if (/^[a-z]$/u.test(name)) return [name.toUpperCase().charCodeAt(0)];
  if (/^[0-9]$/u.test(name)) return [name.charCodeAt(0)];
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/u.exec(name);
  if (functionKey !== null) return [0x6f + Number(functionKey[1])];
  const numpad = /^num ([0-9])$/u.exec(name);
  if (numpad !== null) return [0x60 + Number(numpad[1])];
  return null;
}

function intersects(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function isModifierName(name: string): boolean {
  return name === "ctrl" || name === "left ctrl" || name === "right ctrl"
    || name === "shift" || name === "left shift" || name === "right shift"
    || name === "alt" || name === "left alt" || name === "right alt"
    || name === "windows" || name === "left windows" || name === "right windows";
}

function isModifierVirtualKey(virtualKey: number): boolean {
  return NAMED_KEYS.ctrl!.includes(virtualKey)
    || NAMED_KEYS.shift!.includes(virtualKey)
    || NAMED_KEYS.alt!.includes(virtualKey)
    || NAMED_KEYS.windows!.includes(virtualKey);
}
