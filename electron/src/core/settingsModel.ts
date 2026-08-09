import {
  DEFAULT_CONFIG,
  KEY_FIELDS,
  modelOverride,
  normalizeConfig,
  providerKey,
  type ProviderId,
  type UndertoneConfig,
} from "./config";
import {
  DEFAULT_CLEANUP_MODELS,
  DEFAULT_STT_MODELS,
  LIVE_STT_MODELS,
} from "../shared/models";
import type {
  CloudProviderId,
  CleanupProviderId,
  LocalEngineSnapshot,
  SettingsSnapshot,
  TranscriptionProviderId,
} from "../shared/settings";
import { isTurnWindowDesign } from "../shared/turnWindow";
import {
  actionShortcutsOverlap,
  KEEP_OPEN_SHORTCUT,
  normalizeReleaseShortcut,
  normalizeShortcut,
  normalizeTriggerShortcut,
  pttActionShortcutsOverlap,
} from "./shortcuts";

const PATCH_FIELDS = new Set([
  "language",
  "aiCleanup",
  "restoreClipboard",
  "soundCues",
  "startWithWindows",
  "hotkey",
  "repasteHotkey",
  "commitHotkey",
  "scratchHotkey",
  "discardHotkey",
  "liveTranscription",
  "openTurnCleanupStrategy",
  "turnWindowDesign",
  "inputDevice",
  "provider",
  "cleanupProvider",
  "providerKey",
  "localLoaded",
  "localIdleMinutes",
  "sttVocabHints",
  "vocabulary",
  "corrections",
]);

const TRANSCRIPTION_PROVIDERS = new Set<ProviderId>(["xai", "openai", "openrouter", "local"]);
const CLEANUP_PROVIDERS = new Set<ProviderId>([
  "xai",
  "openai",
  "openai-subscription",
  "openrouter",
  "local",
]);
const CLOUD_PROVIDERS = new Set<CloudProviderId>(["xai", "openai", "openrouter"]);
export function settingsSnapshot(
  config: UndertoneConfig,
  appVersion: string,
  preview: boolean,
  localEngines: {
    stt: LocalEngineSnapshot;
    cleanup: LocalEngineSnapshot;
  } = EMPTY_LOCAL_ENGINES,
  microphones: readonly string[] = [],
  startWithWindows = false,
): SettingsSnapshot {
  const provider = snapshotProvider(
    config.provider,
    TRANSCRIPTION_PROVIDERS,
  ) as TranscriptionProviderId;
  const cleanupProvider = snapshotProvider(
    config.cleanup_provider,
    CLEANUP_PROVIDERS,
  ) as CleanupProviderId;
  return {
    language: config.language,
    aiCleanup: config.ai_cleanup,
    restoreClipboard: config.restore_clipboard,
    soundCues: config.sound_cues,
    startWithWindows,
    hotkey: config.hotkey,
    repasteHotkey: config.repaste_hotkey,
    commitHotkey: config.commit_hotkey,
    scratchHotkey: config.scratch_hotkey,
    discardHotkey: config.discard_hotkey,
    shortcutWarning: shortcutWarning(config),
    liveTranscription: config.live_transcription,
    openTurnCleanupStrategy: config.stack_cleanup_strategy,
    turnWindowDesign: config.turn_window_design,
    inputDevice: config.input_device,
    microphones: [...microphones],
    appVersion,
    preview,
    provider,
    cleanupProvider,
    keyConfigured: {
      xai: providerKey(config, "xai").trim().length > 0,
      openai: providerKey(config, "openai").trim().length > 0,
      openrouter: providerKey(config, "openrouter").trim().length > 0,
    },
    openAiSubscriptionConnected: config.openai_oauth_access_token.trim().length > 0
      && config.openai_oauth_refresh_token.trim().length > 0
      && config.openai_oauth_account_id.trim().length > 0,
    sttModel: activeSttModel(config, provider),
    cleanupModel: modelOverride(config, "cleanup", cleanupProvider)
      || DEFAULT_CLEANUP_MODELS[cleanupProvider]
      || "",
    localLoaded: config.local_loaded,
    localIdleMinutes: config.local_idle_minutes,
    sttVocabHints: config.stt_vocab_hints,
    vocabulary: [...config.vocabulary],
    corrections: { ...config.corrections },
    localEngines: {
      stt: { ...localEngines.stt },
      cleanup: { ...localEngines.cleanup },
    },
  };
}

function activeSttModel(
  config: UndertoneConfig,
  provider: TranscriptionProviderId,
): string {
  if (config.live_transcription && (provider === "openai" || provider === "xai")) {
    return LIVE_STT_MODELS[provider] ?? "";
  }
  return modelOverride(config, "stt", provider) || DEFAULT_STT_MODELS[provider];
}

function snapshotProvider(value: unknown, supported: ReadonlySet<ProviderId>): ProviderId {
  return typeof value === "string" && supported.has(value as ProviderId)
    ? value as ProviderId
    : DEFAULT_CONFIG.provider;
}

export function applySettingsPatch(
  config: UndertoneConfig,
  value: unknown,
): UndertoneConfig {
  if (!isRecord(value)) throw new Error("Settings update must be an object");
  for (const key of Object.keys(value)) {
    if (!PATCH_FIELDS.has(key)) throw new Error(`Unsupported settings field: ${key}`);
  }
  const next = normalizeConfig(config);
  if (value.language !== undefined) {
    if (typeof value.language !== "string"
      || value.language.length < 2
      || value.language.length > 16
      || !/^[A-Za-z-]+$/u.test(value.language)) {
      throw new Error("Invalid transcription language");
    }
    next.language = value.language;
  }
  if (value.aiCleanup !== undefined) {
    next.ai_cleanup = booleanField(value.aiCleanup, "aiCleanup");
  }
  if (value.restoreClipboard !== undefined) {
    next.restore_clipboard = booleanField(value.restoreClipboard, "restoreClipboard");
  }
  if (value.soundCues !== undefined) {
    next.sound_cues = booleanField(value.soundCues, "soundCues");
  }
  if (value.startWithWindows !== undefined) {
    booleanField(value.startWithWindows, "startWithWindows");
  }
  const changedShortcuts = new Set<ShortcutConfigKey>();
  if (value.hotkey !== undefined) {
    if (typeof value.hotkey !== "string") throw new Error("hotkey must be a string");
    next.hotkey = normalizeShortcut(value.hotkey);
    changedShortcuts.add("hotkey");
  }
  if (value.repasteHotkey !== undefined) {
    if (typeof value.repasteHotkey !== "string") {
      throw new Error("repasteHotkey must be a string");
    }
    next.repaste_hotkey = normalizeReleaseShortcut(value.repasteHotkey, true);
    changedShortcuts.add("repaste_hotkey");
  }
  if (value.commitHotkey !== undefined) {
    if (typeof value.commitHotkey !== "string") {
      throw new Error("commitHotkey must be a string");
    }
    next.commit_hotkey = normalizeReleaseShortcut(value.commitHotkey, true);
    changedShortcuts.add("commit_hotkey");
  }
  if (value.scratchHotkey !== undefined) {
    if (typeof value.scratchHotkey !== "string") {
      throw new Error("scratchHotkey must be a string");
    }
    next.scratch_hotkey = normalizeTriggerShortcut(value.scratchHotkey, true);
    changedShortcuts.add("scratch_hotkey");
  }
  if (value.discardHotkey !== undefined) {
    if (typeof value.discardHotkey !== "string") {
      throw new Error("discardHotkey must be a string");
    }
    next.discard_hotkey = normalizeTriggerShortcut(value.discardHotkey, true);
    changedShortcuts.add("discard_hotkey");
  }
  if (changedShortcuts.size > 0) validateShortcutChanges(next, changedShortcuts);
  if (value.liveTranscription !== undefined) {
    next.live_transcription = booleanField(value.liveTranscription, "liveTranscription");
  }
  if (value.openTurnCleanupStrategy !== undefined) {
    if (value.openTurnCleanupStrategy !== "live-full"
      && value.openTurnCleanupStrategy !== "commit-full") {
      throw new Error("openTurnCleanupStrategy is invalid");
    }
    next.stack_cleanup_strategy = value.openTurnCleanupStrategy;
  }
  if (value.turnWindowDesign !== undefined) {
    if (!isTurnWindowDesign(value.turnWindowDesign)) {
      throw new Error("turnWindowDesign is invalid");
    }
    next.turn_window_design = value.turnWindowDesign;
  }
  if (value.inputDevice !== undefined) {
    next.input_device = boundedSingleLine(value.inputDevice, "inputDevice", 512);
  }
  if (value.provider !== undefined) {
    next.provider = providerField(value.provider, "provider", TRANSCRIPTION_PROVIDERS);
  }
  if (value.cleanupProvider !== undefined) {
    next.cleanup_provider = providerField(value.cleanupProvider, "cleanupProvider", CLEANUP_PROVIDERS);
  }
  if (value.providerKey !== undefined) {
    const update = providerKeyUpdate(value.providerKey);
    next[KEY_FIELDS[update.provider]] = update.value;
  }
  if (value.localLoaded !== undefined) {
    next.local_loaded = booleanField(value.localLoaded, "localLoaded");
  }
  if (value.localIdleMinutes !== undefined) {
    if (typeof value.localIdleMinutes !== "number"
      || ![0, 5, 15, 30, 60].includes(value.localIdleMinutes)) {
      throw new Error("localIdleMinutes is invalid");
    }
    next.local_idle_minutes = value.localIdleMinutes;
  }
  if (value.sttVocabHints !== undefined) {
    next.stt_vocab_hints = booleanField(value.sttVocabHints, "sttVocabHints");
  }
  if (value.vocabulary !== undefined) {
    next.vocabulary = stringList(value.vocabulary, "vocabulary", 200, 256);
  }
  if (value.corrections !== undefined) {
    next.corrections = stringMap(value.corrections, "corrections", 200, 256);
  }
  return next;
}

const EMPTY_LOCAL_ENGINE: LocalEngineSnapshot = {
  installed: false,
  loaded: false,
  loading: false,
  build: null,
  installing: false,
  installPhase: "",
  installFraction: 0,
  installBytes: 0,
};

const EMPTY_LOCAL_ENGINES = {
  stt: EMPTY_LOCAL_ENGINE,
  cleanup: EMPTY_LOCAL_ENGINE,
};

function providerField(
  value: unknown,
  name: string,
  supported: ReadonlySet<ProviderId>,
): ProviderId {
  if (typeof value !== "string" || !supported.has(value as ProviderId)) {
    throw new Error(`${name} is not a supported provider`);
  }
  return value as ProviderId;
}

function providerKeyUpdate(value: unknown): { provider: CloudProviderId; value: string } {
  exactObject(value, ["provider", "value"], "providerKey");
  if (typeof value.provider !== "string"
    || !CLOUD_PROVIDERS.has(value.provider as CloudProviderId)) {
    throw new Error("providerKey has an unsupported provider");
  }
  const secret = boundedSingleLine(value.value, "providerKey.value", 4_096);
  return { provider: value.provider as CloudProviderId, value: secret };
}

function boundedSingleLine(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const result = value.trim();
  if (result.length > maxLength || /[\r\n\0]/u.test(result)) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  name: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || fields.some((key) => !(key in value))) {
    throw new Error(`${name} has invalid fields`);
  }
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function stringList(
  value: unknown,
  name: string,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new Error(`${name} is invalid`);
  }
  const result: string[] = [];
  for (const item of value) {
    const normalized = boundedSingleLine(item, name, maximumLength);
    if (normalized.length > 0 && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function stringMap(
  value: unknown,
  name: string,
  maximumEntries: number,
  maximumLength: number,
): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > maximumEntries) {
    throw new Error(`${name} is invalid`);
  }
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = boundedSingleLine(key, `${name}.key`, maximumLength);
    const normalizedValue = boundedSingleLine(child, `${name}.value`, maximumLength);
    if (normalizedKey.length === 0 || normalizedValue.length === 0) {
      throw new Error(`${name} entries cannot be empty`);
    }
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

type ShortcutConfigKey = "hotkey" | ActionShortcutConfigKey;
type ActionShortcutConfigKey =
  | "repaste_hotkey"
  | "commit_hotkey"
  | "scratch_hotkey"
  | "discard_hotkey";

const ACTION_SHORTCUTS: readonly {
  key: ActionShortcutConfigKey;
  label: string;
}[] = [
  { key: "repaste_hotkey", label: "Re-paste" },
  { key: "commit_hotkey", label: "Commit" },
  { key: "scratch_hotkey", label: "Scratch" },
  { key: "discard_hotkey", label: "Discard" },
];

function validateShortcutChanges(
  config: UndertoneConfig,
  changed: ReadonlySet<ShortcutConfigKey>,
): void {
  if (changed.has("hotkey")
    && pttActionShortcutsOverlap(config.hotkey, KEEP_OPEN_SHORTCUT)) {
    throw new Error("The Dictate shortcut cannot include Left Alt; Left Alt keeps a recording open");
  }
  for (const action of ACTION_SHORTCUTS) {
    if (changed.has(action.key)
      && actionShortcutsOverlap(config[action.key], KEEP_OPEN_SHORTCUT)) {
      throw new Error(`Left Alt is reserved for keeping a recording open`);
    }
  }
  for (const action of ACTION_SHORTCUTS) {
    if ((changed.has("hotkey") || changed.has(action.key))
      && pttActionShortcutsOverlap(config.hotkey, config[action.key])) {
      throw new Error(`The Dictate shortcut overlaps the ${action.label} shortcut`);
    }
  }
  for (let left = 0; left < ACTION_SHORTCUTS.length; left += 1) {
    for (let right = left + 1; right < ACTION_SHORTCUTS.length; right += 1) {
      const leftAction = ACTION_SHORTCUTS[left]!;
      const rightAction = ACTION_SHORTCUTS[right]!;
      if (!changed.has(leftAction.key) && !changed.has(rightAction.key)) continue;
      if (actionShortcutsOverlap(config[leftAction.key], config[rightAction.key])) {
        throw new Error("That shortcut is already assigned to another action");
      }
    }
  }
}

function shortcutWarning(config: UndertoneConfig): string | null {
  try {
    if (pttActionShortcutsOverlap(config.hotkey, KEEP_OPEN_SHORTCUT)) {
      return "The Dictate shortcut includes Left Alt, which is reserved for keeping a recording open.";
    }
  } catch {
    // Unsupported saved shortcuts are reported by the shortcut loader.
  }
  for (const action of ACTION_SHORTCUTS) {
    try {
      if (actionShortcutsOverlap(config[action.key], KEEP_OPEN_SHORTCUT)) {
        return `${action.label} uses Left Alt, which is reserved for keeping a recording open.`;
      }
    } catch {
      // Unsupported saved shortcuts are reported by the shortcut loader.
    }
  }
  const pttConflicts = ACTION_SHORTCUTS.filter((action) => {
    try {
      return pttActionShortcutsOverlap(config.hotkey, config[action.key]);
    } catch {
      return false;
    }
  }).map((action) => action.label);
  if (pttConflicts.length > 0) {
    return `The Dictate shortcut overlaps ${joinLabels(pttConflicts)}. Change one of these shortcuts.`;
  }
  for (let left = 0; left < ACTION_SHORTCUTS.length; left += 1) {
    for (let right = left + 1; right < ACTION_SHORTCUTS.length; right += 1) {
      const leftAction = ACTION_SHORTCUTS[left]!;
      const rightAction = ACTION_SHORTCUTS[right]!;
      try {
        if (actionShortcutsOverlap(config[leftAction.key], config[rightAction.key])) {
          return `${leftAction.label} and ${rightAction.label} use the same shortcut.`;
        }
      } catch {
        // Unsupported saved shortcuts are reported by the shortcut loader.
      }
    }
  }
  return null;
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length < 2) return labels[0] ?? "an action";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
