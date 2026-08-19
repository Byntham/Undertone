import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  AppUpdateSnapshot,
  CloudProviderId,
  CleanupProviderId,
  LocalEngineAction,
  LocalEngineKind,
  LocalEngineSnapshot,
  LocalRuntimeBuild,
  HistoryAction,
  HistorySnapshotEntry,
  OpenAiSubscriptionAction,
  ProviderTestKind,
  SettingsPatch,
  SettingsProviderId,
  SettingsSnapshot,
  ShortcutSetting,
  SystemAction,
  TranscriptionProviderId,
} from "../shared/settings";
import "./style.css";

type Section = "general" | "speechAi" | "dictionary" | "history";
const settingsApi = window.undertoneSettings;
if (settingsApi === undefined) throw new Error("Settings preload is unavailable");

function SettingsApp(): React.JSX.Element {
  const [section, setSection] = useState<Section>("general");
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [capturing, setCapturing] = useState<ShortcutSetting | null>(null);
  const [history, setHistory] = useState<HistorySnapshotEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);
  const mounted = useRef(true);
  const activeSection = useRef<Section>(section);
  const settingsActionRequest = useRef(0);
  const localActionRequest = useRef<Record<LocalEngineKind, number>>({ stt: 0, cleanup: 0 });
  const settingsPollBlockers = useRef(0);
  const settingsPollEpoch = useRef(0);
  const settingsPollRequest = useRef(0);
  const historyActions = useRef(0);
  const historyRequest = useRef(0);

  const refreshSettings = (allowHidden = false): void => {
    if ((!allowHidden && document.hidden) || settingsPollBlockers.current > 0) return;
    const epoch = settingsPollEpoch.current;
    const request = ++settingsPollRequest.current;
    void settingsApi.load()
      .then((snapshot) => {
        if (mounted.current
          && (allowHidden || !document.hidden)
          && settingsPollBlockers.current === 0
          && settingsPollEpoch.current === epoch
          && settingsPollRequest.current === request) {
          setSettings(snapshot);
        }
      })
      .catch((reason: unknown) => {
        if (mounted.current
          && (allowHidden || !document.hidden)
          && settingsPollBlockers.current === 0
          && settingsPollEpoch.current === epoch
          && settingsPollRequest.current === request) {
          setError(errorMessage(reason));
        }
      });
  };

  const refreshHistory = (): void => {
    if (document.hidden || activeSection.current !== "history" || historyActions.current > 0) return;
    const request = ++historyRequest.current;
    void settingsApi.history()
      .then((entries) => {
        if (mounted.current
          && !document.hidden
          && activeSection.current === "history"
          && historyActions.current === 0
          && historyRequest.current === request) {
          setHistory(entries);
        }
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    mounted.current = true;
    refreshSettings(true);
    const refreshVisible = (): void => {
      if (document.hidden) return;
      refreshSettings();
      refreshHistory();
    };
    document.addEventListener("visibilitychange", refreshVisible);
    const timer = setInterval(refreshVisible, 1_000);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", refreshVisible);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    activeSection.current = section;
    contentRef.current?.scrollTo({ top: 0 });
    if (section === "history") refreshHistory();
  }, [section]);

  const settingsAction = async (
    action: () => Promise<SettingsSnapshot>,
    localChannel?: LocalEngineKind,
  ): Promise<boolean> => {
    const request = ++settingsActionRequest.current;
    const channelRequest = localChannel === undefined
      ? 0
      : ++localActionRequest.current[localChannel];
    settingsPollEpoch.current += 1;
    if (localChannel === undefined) settingsPollBlockers.current += 1;
    setError(null);
    try {
      const snapshot = await action();
      if (mounted.current && settingsActionRequest.current === request) {
        settingsPollEpoch.current += 1;
        setSettings(snapshot);
      }
      return true;
    } catch (reason) {
      const latestError = localChannel === undefined
        ? settingsActionRequest.current === request
        : localActionRequest.current[localChannel] === channelRequest;
      if (mounted.current && latestError) {
        settingsPollEpoch.current += 1;
        setError(errorMessage(reason));
      }
      return false;
    } finally {
      if (localChannel === undefined) settingsPollBlockers.current -= 1;
    }
  };

  const update = async (patch: SettingsPatch): Promise<boolean> => (
    settingsAction(() => settingsApi.update(patch))
  );

  const setStartWithWindows = async (enabled: boolean): Promise<boolean> => (
    settingsAction(() => settingsApi.setStartWithWindows(enabled))
  );

  const historyAction = async (id: number, action: HistoryAction): Promise<void> => {
    const request = ++historyRequest.current;
    historyActions.current += 1;
    setError(null);
    try {
      await settingsApi.historyAction(id, action);
      const entries = await settingsApi.history();
      if (mounted.current && historyRequest.current === request) {
        setHistory(entries);
      }
    } catch (reason) {
      if (mounted.current && historyRequest.current === request) {
        setError(errorMessage(reason));
      }
    } finally {
      historyActions.current -= 1;
    }
  };

  const systemAction = async (action: SystemAction): Promise<void> => {
    setError(null);
    try {
      await settingsApi.systemAction(action);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const localAction = async (
    kind: LocalEngineKind,
    action: LocalEngineAction,
    build?: LocalRuntimeBuild,
  ): Promise<boolean> => {
    return settingsAction(() => settingsApi.localAction(kind, action, build), kind);
  };

  const openAiSubscriptionAction = async (
    action: OpenAiSubscriptionAction,
  ): Promise<boolean> => {
    return settingsAction(() => settingsApi.openAiSubscriptionAction(action));
  };

  const captureShortcut = async (field: ShortcutSetting): Promise<void> => {
    setError(null);
    setCapturing(field);
    try {
      await settingsAction(() => settingsApi.captureShortcut(field));
    } finally {
      setCapturing(null);
    }
  };

  return <div className="shell">
    <aside className="sidebar">
      <nav aria-label="Settings sections">
        <NavItem
          active={section === "general"}
          icon="general"
          label="General"
          description="Shortcuts, dictation, input, and app behavior"
          onClick={() => setSection("general")}
        />
        <NavItem
          active={section === "speechAi"}
          icon="speechAi"
          label="Speech & AI"
          description="Language, providers, cleanup, credentials, and local models"
          onClick={() => setSection("speechAi")}
        />
        <NavItem
          active={section === "dictionary"}
          icon="dictionary"
          label="Dictionary"
          description="Local transcript corrections"
          onClick={() => setSection("dictionary")}
        />
        <NavItem
          active={section === "history"}
          icon="history"
          label="History"
          description="Recent dictations and retries"
          onClick={() => setSection("history")}
        />
      </nav>
    </aside>
    <main ref={contentRef} className="content">
      {settings === null
        ? <div className="loading">{error ?? "Loading settings…"}</div>
        : section === "general"
          ? <General
              settings={settings}
              update={update}
              setStartWithWindows={setStartWithWindows}
              capturing={capturing}
              captureShortcut={captureShortcut}
              systemAction={systemAction}
            />
          : section === "speechAi"
            ? <SpeechAi
                settings={settings}
                update={update}
                localAction={localAction}
                openAiSubscriptionAction={openAiSubscriptionAction}
              />
            : section === "dictionary"
              ? <Dictionary settings={settings} update={update} />
              : <History entries={history} action={historyAction} />}
      {error !== null && <div className="errorState" role="status">{error}</div>}
    </main>
  </div>;
}

function General({
  settings,
  update,
  setStartWithWindows,
  capturing,
  captureShortcut,
  systemAction,
}: {
  settings: SettingsSnapshot;
  update: (patch: SettingsPatch) => Promise<boolean>;
  setStartWithWindows: (enabled: boolean) => Promise<boolean>;
  capturing: ShortcutSetting | null;
  captureShortcut: (field: ShortcutSetting) => Promise<void>;
  systemAction: (action: SystemAction) => Promise<void>;
}): React.JSX.Element {
  const directLiveSupported = settings.provider === "openai"
    || (settings.provider === "local" && settings.localSttEngine === "nemotron");
  const [microphoneStatus, setMicrophoneStatus] = useState<string | null>(null);
  const [testingMicrophone, setTestingMicrophone] = useState(false);
  const testMicrophone = async (): Promise<void> => {
    setTestingMicrophone(true);
    setMicrophoneStatus("Listening... speak normally");
    try {
      const peak = await settingsApi.microphoneTest();
      const level = Math.round(peak * 100);
      setMicrophoneStatus(level < 1 ? "No speech detected" : `Input level ${level}%`);
    } catch (reason) {
      setMicrophoneStatus(errorMessage(reason));
    } finally {
      setTestingMicrophone(false);
    }
  };
  return <section>
    <header className="pageHeader"><h1>General</h1></header>

    <h2>Dictation controls</h2>
    <div className="card shortcutGrid">
      {settings.shortcutWarning !== null
        && <p className="shortcutWarning" role="status">{settings.shortcutWarning}</p>}
      <ShortcutItem
        primary
        title="Dictate and auto-commit"
        description="Hold and release to paste, or tap once to start and tap again to paste."
        field="hotkey"
        value={settings.hotkey}
        capturing={capturing}
        capture={captureShortcut}
      />
      <FixedShortcutItem
        title="Keep in open turn"
        description="Press while recording to stop without pasting."
        value="left alt"
      />
      <ShortcutItem
        title="Commit open turn"
        description="Paste everything previously kept in the open turn."
        field="commitHotkey"
        value={settings.commitHotkey}
        capturing={capturing}
        capture={captureShortcut}
      />
    </div>

    <h2>Other shortcuts</h2>
    <div className="card shortcutGrid">
      <ShortcutItem
        title="Remove last fragment"
        field="scratchHotkey"
        value={settings.scratchHotkey}
        capturing={capturing}
        capture={captureShortcut}
      />
      <ShortcutItem
        title="Discard open turn"
        field="discardHotkey"
        value={settings.discardHotkey}
        capturing={capturing}
        capture={captureShortcut}
      />
      <ShortcutItem
        wide
        title="Re-paste last dictation"
        field="repasteHotkey"
        value={settings.repasteHotkey}
        capturing={capturing}
        capture={captureShortcut}
      />
    </div>

    <div className="settingsColumns">
      <div>
        <h2>Dictation</h2>
        <div className="card">
          <SettingRow title="Open-turn cleanup" description="Choose when AI cleanup runs while building an open turn.">
            <select
              aria-label="Cleanup timing"
              value={settings.openTurnCleanupStrategy}
              onChange={(event) => {
                void update({
                  openTurnCleanupStrategy: event.target.value === "commit-full"
                    ? "commit-full"
                    : "live-full",
                });
              }}
            >
              <option value="live-full">After every fragment</option>
              <option value="commit-full">When committing</option>
            </select>
          </SettingRow>
          <SettingRow
            title={directLiveSupported ? "Direct live insert (test)" : "Live text preview"}
            description={directLiveSupported
              ? "Tap Dictate to start and tap again to stop. Inserts into the focused app without the turn window or cleanup; revised words already inserted are not corrected."
              : "Show text in the open turn while you speak. Available with xAI."}
          >
            <Toggle
              label={directLiveSupported ? "Insert text while speaking" : "Show live text preview"}
              checked={directLiveSupported
                ? settings.directLiveInsert
                : settings.liveTranscription}
              disabled={!directLiveSupported && settings.provider !== "xai"}
              onChange={(enabled) => {
                void update(directLiveSupported
                  ? { directLiveInsert: enabled }
                  : { liveTranscription: enabled });
              }}
            />
          </SettingRow>
        </div>

        <h2>Output</h2>
        <div className="card">
          <SettingRow title="Restore clipboard" description="Put previous clipboard text back after pasting.">
            <Toggle
              label="Restore clipboard"
              checked={settings.restoreClipboard}
              onChange={(restoreClipboard) => { void update({ restoreClipboard }); }}
            />
          </SettingRow>
        </div>
      </div>

      <div>
        <h2>Input &amp; feedback</h2>
        <div className="card">
          <SettingRow title="Microphone" description={settings.inputDevice || "System default input"}>
            <div className="microphoneControl">
              <select
                aria-label="Microphone"
                value={settings.inputDevice}
                onChange={(event) => { void update({ inputDevice: event.target.value }); }}
              >
                <option value="">System default</option>
                {settings.inputDevice !== "" && !settings.microphones.includes(settings.inputDevice)
                  && <option value={settings.inputDevice}>{settings.inputDevice} (disconnected)</option>}
                {settings.microphones.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <button
                type="button"
                className="smallButton"
                disabled={testingMicrophone}
                onClick={() => { void testMicrophone(); }}
              >{testingMicrophone ? "Testing…" : "Test"}</button>
              {microphoneStatus !== null && <small role="status">{microphoneStatus}</small>}
            </div>
          </SettingRow>
          <SettingRow title="Dictation sound cues">
            <Toggle
              label="Dictation sound cues"
              checked={settings.soundCues}
              onChange={(soundCues) => { void update({ soundCues }); }}
            />
          </SettingRow>
        </div>
        <p className="infoNote">The visual status overlay is always on. It appears only while dictating or processing and never takes focus.</p>

        <h2>Application</h2>
        <div className="card">
          <SettingRow title="Start with Windows" description="Launch quietly in the tray.">
            <Toggle
              label="Start with Windows"
              checked={settings.startWithWindows}
              onChange={(enabled) => { void setStartWithWindows(enabled); }}
            />
          </SettingRow>
          <AppUpdates appVersion={settings.appVersion} />
          <SettingRow title="Diagnostics" description="Settings folder and application log">
            <div className="buttonGroup">
              <button type="button" className="smallButton" onClick={() => { void systemAction("openSettingsFolder"); }}>Settings</button>
              <button type="button" className="smallButton" onClick={() => { void systemAction("openLog"); }}>Log</button>
            </div>
          </SettingRow>
        </div>
      </div>
    </div>
  </section>;
}

function ShortcutItem({
  primary = false,
  wide = false,
  title,
  description,
  field,
  value,
  capturing,
  capture,
}: {
  primary?: boolean;
  wide?: boolean;
  title: string;
  description?: string;
  field: ShortcutSetting;
  value: string;
  capturing: ShortcutSetting | null;
  capture: (field: ShortcutSetting) => Promise<void>;
}): React.JSX.Element {
  return <div className="shortcutItem" data-primary={primary} data-wide={wide}>
    <div>
      <h3>{title}</h3>
      {description !== undefined && <p>{description}</p>}
    </div>
    <ShortcutControl
      field={field}
      value={value}
      capturing={capturing}
      capture={capture}
    />
  </div>;
}

function FixedShortcutItem({
  title,
  description,
  value,
}: {
  title: string;
  description: string;
  value: string;
}): React.JSX.Element {
  return <div className="shortcutItem">
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
    <span className="keycaps">{shortcutParts(value).map((part) => (
      <span className="keycap" key={part}>{part}</span>
    ))}</span>
  </div>;
}

function ShortcutControl({
  field,
  value,
  capturing,
  capture,
}: {
  field: ShortcutSetting;
  value: string;
  capturing: ShortcutSetting | null;
  capture: (field: ShortcutSetting) => Promise<void>;
}): React.JSX.Element {
  const active = capturing === field;
  const parts = active ? ["Press shortcut…"] : shortcutParts(value);
  return <div className="shortcutControl">
    <span className="keycaps">{parts.map((part, index) => (
      <span className="keycap" key={`${part}-${index}`}>{part}</span>
    ))}</span>
    <button
      type="button"
      className="smallButton"
      disabled={capturing !== null}
      onClick={() => { void capture(field); }}
    >{active ? "Listening…" : "Change"}</button>
  </div>;
}

function shortcutParts(value: string): string[] {
  if (value.length === 0) return ["Disabled"];
  const names: Readonly<Record<string, string>> = {
    "left ctrl": "Ctrl",
    "right ctrl": "Ctrl",
    ctrl: "Ctrl",
    "left alt": "Alt",
    "right alt": "Alt",
    alt: "Alt",
    "left shift": "Shift",
    "right shift": "Shift",
    shift: "Shift",
    "left windows": "Win",
    "right windows": "Win",
    windows: "Win",
    backspace: "⌫",
    enter: "Enter",
  };
  return value.split("+").map((part) => {
    const normalized = part.trim().toLowerCase();
    return names[normalized] ?? normalized.toUpperCase();
  });
}

function Dictionary({
  settings,
  update,
}: {
  settings: SettingsSnapshot;
  update: (patch: SettingsPatch) => Promise<boolean>;
}): React.JSX.Element {
  const [heard, setHeard] = useState("");
  const [replacement, setReplacement] = useState("");
  const addCorrection = (): void => {
    const key = heard.trim();
    const value = replacement.trim();
    if (key.length === 0 || value.length === 0) return;
    void update({ corrections: { ...settings.corrections, [key]: value } }).then((saved) => {
      if (saved) {
        setHeard("");
        setReplacement("");
      }
    });
  };
  return <section>
    <header className="pageHeader"><h1>Dictionary</h1></header>
    <h2>Corrections</h2>
    <div className="card">
      <form className="entryForm" onSubmit={(event) => { event.preventDefault(); addCorrection(); }}>
        <input aria-label="Misheard phrase" placeholder="What was heard" value={heard} onChange={(event) => setHeard(event.target.value)} />
        <span aria-hidden="true">→</span>
        <input aria-label="Replacement" placeholder="Replacement" value={replacement} onChange={(event) => setReplacement(event.target.value)} />
        <button type="submit" className="smallButton accent">Add</button>
      </form>
      <EditableList
        empty="No corrections yet."
        entries={Object.entries(settings.corrections).map(([key, value]) => ({ key, label: `${key} → ${value}` }))}
        remove={(key) => {
          const next = { ...settings.corrections };
          delete next[key];
          void update({ corrections: next });
        }}
      />
    </div>
    <p className="supportNote">Corrections run locally after transcription and AI cleanup.</p>
  </section>;
}

function EditableList({
  entries,
  empty,
  remove,
}: {
  entries: { key: string; label: string }[];
  empty: string;
  remove: (key: string) => void;
}): React.JSX.Element {
  if (entries.length === 0) return <p className="emptyList">{empty}</p>;
  return <div className="editableList">{entries.map((entry) => <div key={entry.key}>
    <span>{entry.label}</span>
    <button type="button" aria-label={`Remove ${entry.key}`} onClick={() => remove(entry.key)}>×</button>
  </div>)}</div>;
}

function History({
  entries,
  action,
}: {
  entries: HistorySnapshotEntry[];
  action: (id: number, action: HistoryAction) => Promise<void>;
}): React.JSX.Element {
  return <section>
    <header className="pageHeader">
      <h1>History</h1>
      <p>Recent dictations live in memory and disappear when Undertone exits.</p>
    </header>
    <div className="historyList">
      {entries.length === 0 && <div className="card emptyList">Nothing dictated yet this session.</div>}
      {entries.map((entry) => <article key={entry.id} className="historyEntry" data-ok={entry.ok}>
        <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        <p>{entry.ok ? entry.text : entry.error}</p>
        <div className="historyActions">
          {entry.ok && <button type="button" className="smallButton" onClick={() => { void action(entry.id, "copy"); }}>Copy</button>}
          {entry.ok && <button type="button" className="smallButton accent" onClick={() => { void action(entry.id, "repaste"); }}>Re-paste</button>}
          {!entry.ok && entry.retryable && <button type="button" className="smallButton accent" onClick={() => { void action(entry.id, "retry"); }}>Retry</button>}
        </div>
      </article>)}
    </div>
  </section>;
}

const CLOUD_PROVIDERS: readonly { id: CloudProviderId; label: string }[] = [
  { id: "xai", label: "xAI" },
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
];
const TRANSCRIPTION_PROVIDERS: readonly { id: TranscriptionProviderId; label: string }[] = [
  ...CLOUD_PROVIDERS,
  { id: "local", label: "Local" },
];
const CLEANUP_PROVIDERS: readonly { id: CleanupProviderId; label: string }[] = [
  { id: "xai", label: "xAI" },
  { id: "openai", label: "OpenAI API" },
  { id: "openai-subscription", label: "OpenAI Subscription" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "local", label: "Local" },
];

function SpeechAi({
  settings,
  update,
  localAction,
  openAiSubscriptionAction,
}: {
  settings: SettingsSnapshot;
  update: (patch: SettingsPatch) => Promise<boolean>;
  localAction: (
    kind: LocalEngineKind,
    action: LocalEngineAction,
    build?: LocalRuntimeBuild,
  ) => Promise<boolean>;
  openAiSubscriptionAction: (action: OpenAiSubscriptionAction) => Promise<boolean>;
}): React.JSX.Element {
  const [testing, setTesting] = useState<ProviderTestKind | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<ProviderTestKind, string>>>({});
  const testRequests = useRef<Record<ProviderTestKind, number>>({ stt: 0, cleanup: 0 });
  useEffect(() => {
    testRequests.current.stt += 1;
    setTesting((current) => current === "stt" ? null : current);
    setTestResults(({ stt: _stt, ...current }) => current);
  }, [settings.provider]);
  useEffect(() => {
    testRequests.current.cleanup += 1;
    setTesting((current) => current === "cleanup" ? null : current);
    setTestResults(({ cleanup: _cleanup, ...current }) => current);
  }, [settings.cleanupProvider]);
  const test = async (kind: ProviderTestKind): Promise<void> => {
    const request = ++testRequests.current[kind];
    setTesting(kind);
    setTestResults((current) => ({ ...current, [kind]: "" }));
    try {
      const message = `✓ ${await settingsApi.providerTest(kind)}`;
      if (testRequests.current[kind] === request) {
        setTestResults((current) => ({ ...current, [kind]: message }));
      }
    } catch (reason) {
      if (testRequests.current[kind] === request) {
        setTestResults((current) => ({ ...current, [kind]: errorMessage(reason) }));
      }
    } finally {
      if (testRequests.current[kind] === request) setTesting(null);
    }
  };
  const cleanupSubscriptionActive = settings.aiCleanup
    && settings.cleanupProvider === "openai-subscription";
  const activeCredentialProviders = CLOUD_PROVIDERS.filter(({ id }) => (
    settings.provider === id || (settings.aiCleanup && settings.cleanupProvider === id)
  ));
  const otherCredentialProviders = CLOUD_PROVIDERS.filter(({ id }) => (
    settings.provider !== id && (!settings.aiCleanup || settings.cleanupProvider !== id)
  ));
  return <section>
    <header className="pageHeader"><h1>Speech &amp; AI</h1></header>
    <div className="settingsColumns">
      <div>
        <h2>Services</h2>
        <div className="card">
          <SettingRow title="Transcription">
            <div className="serviceControl">
              <ProviderSelect
                label="Transcription provider"
                value={settings.provider}
                localAvailable={settings.localEngines.stt.installed}
                providers={TRANSCRIPTION_PROVIDERS}
                onChange={(provider) => { void update({ provider }); }}
              />
              <button type="button" className="smallButton" disabled={testing !== null} onClick={() => { void test("stt"); }}>
                {testing === "stt" ? "Testing…" : "Test"}
              </button>
              <small className="modelSummary">Model · {settings.sttModel || "Provider managed"}</small>
              {testResults.stt && <small role="status">{testResults.stt}</small>}
            </div>
          </SettingRow>
          <SettingRow title="Transcription language">
            <select
              aria-label="Transcription language"
              value={settings.language}
              disabled={settings.provider === "local" && settings.localSttEngine === "nemotron"}
              onChange={(event) => { void update({ language: event.target.value }); }}
            >
              <option value="en">English</option>
              <option value="de">German</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
            </select>
          </SettingRow>
          <SettingRow title="Use AI cleanup">
            <Toggle
              label="Use AI cleanup"
              checked={settings.aiCleanup}
              onChange={(aiCleanup) => { void update({ aiCleanup }); }}
            />
          </SettingRow>
          <SettingRow title="Cleanup provider">
            <div className="serviceControl" data-disabled={!settings.aiCleanup}>
              <ProviderSelect
                label="Cleanup provider"
                value={settings.cleanupProvider}
                localAvailable={settings.localEngines.cleanup.installed}
                providers={CLEANUP_PROVIDERS}
                disabled={!settings.aiCleanup}
                onChange={(cleanupProvider) => { void update({ cleanupProvider }); }}
              />
              <button type="button" className="smallButton" disabled={testing !== null || !settings.aiCleanup} onClick={() => { void test("cleanup"); }}>
                {testing === "cleanup" ? "Testing…" : "Test"}
              </button>
              <small className="modelSummary">Model · {settings.cleanupModel || "Provider managed"}</small>
              {testResults.cleanup && <small role="status">{testResults.cleanup}</small>}
            </div>
          </SettingRow>
        </div>

        <h2>Credentials</h2>
        {activeCredentialProviders.length === 0 && !cleanupSubscriptionActive
          ? <div className="card emptyList">No cloud credentials are needed.</div>
          : <div className="providerGrid">
              {cleanupSubscriptionActive && <SubscriptionCard
                connected={settings.openAiSubscriptionConnected}
                action={openAiSubscriptionAction}
              />}
              {activeCredentialProviders.map(({ id, label }) => <KeyCard
                key={id}
                provider={id}
                name={label}
                configured={settings.keyConfigured[id]}
                update={update}
              />)}
            </div>}
        {otherCredentialProviders.length > 0 && <details className="otherCredentials">
          <summary>Other credentials</summary>
          <div className="providerGrid">
            {otherCredentialProviders.map(({ id, label }) => <KeyCard
              key={id}
              provider={id}
              name={label}
              configured={settings.keyConfigured[id]}
              update={update}
            />)}
            {!cleanupSubscriptionActive && <SubscriptionCard
              connected={settings.openAiSubscriptionConnected}
              action={openAiSubscriptionAction}
            />}
          </div>
        </details>}
        <p className="privacyNote">Keys and sign-in tokens are encrypted on this computer.</p>
      </div>

      <div>
        <h2>On-device</h2>
        <div className="providerGrid">
          <div className="card">
            <SettingRow
              title="Local transcription engine"
              description={settings.localSttEngine === "nemotron"
                ? "True streaming. The same model produces both the preview and final transcript."
                : "Whisper Large V3 Turbo for completed recordings. Live preview requires Nemotron."}
            >
              <select
                aria-label="Local transcription engine"
                value={settings.localSttEngine}
                onChange={(event) => {
                  void update({
                    localSttEngine: event.target.value === "nemotron" ? "nemotron" : "whisper",
                  });
                }}
              >
                <option value="whisper">Whisper</option>
                <option value="nemotron">Nemotron</option>
              </select>
            </SettingRow>
          </div>
          <LocalEngineCard
            kind="stt"
            name="Transcription model"
            status={settings.localEngines.stt}
            action={localAction}
            buildChoice={settings.localSttEngine === "nemotron"}
          />
          <LocalEngineCard
            kind="cleanup"
            name="Cleanup model"
            status={settings.localEngines.cleanup}
            action={localAction}
          />
        </div>

        <h2>Local behavior</h2>
        <div className="card">
          <SettingRow title="Load models on startup">
            <Toggle
              label="Load local models on startup"
              checked={settings.localLoaded}
              onChange={(localLoaded) => { void update({ localLoaded }); }}
            />
          </SettingRow>
          <SettingRow title="Unload models when idle">
            <select
              aria-label="Local model idle timeout"
              value={settings.localIdleMinutes}
              onChange={(event) => { void update({ localIdleMinutes: Number(event.target.value) }); }}
            >
              <option value={0}>Never</option>
              <option value={5}>After 5 min</option>
              <option value={15}>After 15 min</option>
              <option value={30}>After 30 min</option>
              <option value={60}>After 1 hour</option>
            </select>
          </SettingRow>
        </div>
      </div>
    </div>
  </section>;
}

function ProviderSelect<T extends SettingsProviderId>({
  label,
  value,
  localAvailable,
  providers,
  disabled = false,
  onChange,
}: {
  label: string;
  value: T;
  localAvailable: boolean;
  providers: readonly { id: T; label: string }[];
  disabled?: boolean;
  onChange: (value: T) => void;
}): React.JSX.Element {
  return <select
    aria-label={label}
    value={value}
    disabled={disabled}
    onChange={(event) => onChange(event.target.value as T)}
  >
    {providers.map((provider) => <option
      key={provider.id}
      value={provider.id}
      disabled={provider.id === "local" && !localAvailable}
    >{provider.label}</option>)}
  </select>;
}

function SubscriptionCard({
  connected,
  action,
}: {
  connected: boolean;
  action: (action: OpenAiSubscriptionAction) => Promise<boolean>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const invoke = async (): Promise<void> => {
    setBusy(true);
    try {
      await action(connected ? "disconnect" : "connect");
    } finally {
      setBusy(false);
    }
  };
  return <div className="keyCard subscriptionCard">
    <div className="keyHead">
      <div>
        <strong>OpenAI Subscription</strong>
        <small>AI cleanup only</small>
      </div>
      <span data-configured={connected}>{connected ? "Connected" : "Not connected"}</span>
    </div>
    <button
      type="button"
      className={`smallButton${connected ? "" : " accent"}`}
      disabled={busy}
      onClick={() => { void invoke(); }}
    >
      {busy ? "Working…" : connected ? "Disconnect" : "Connect OpenAI"}
    </button>
  </div>;
}

function LocalEngineCard({
  kind,
  name,
  status,
  action,
  buildChoice = false,
}: {
  kind: LocalEngineKind;
  name: string;
  status: LocalEngineSnapshot;
  action: (
    kind: LocalEngineKind,
    action: LocalEngineAction,
    build?: LocalRuntimeBuild,
  ) => Promise<boolean>;
  buildChoice?: boolean;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [installBuild, setInstallBuild] = useState<LocalRuntimeBuild>(
    status.installedBuild ?? status.recommendedBuild ?? "cpu",
  );
  useEffect(() => {
    setInstallBuild(status.installedBuild ?? status.recommendedBuild ?? "cpu");
  }, [status.installedBuild, status.recommendedBuild]);
  const running = status.loaded || status.loading;
  const working = busy || status.installing;
  const nextAction: LocalEngineAction = running
    ? "eject"
    : !status.installed || (buildChoice && status.installedBuild !== installBuild)
      ? "install"
      : "load";
  const label = status.installing
    ? `${status.installPhase || "Installing"} · ${Math.round(status.installFraction * 100)}%`
    : !status.installed
      ? `Not installed · ${formatDownloadSize(
          status.installBytesByBuild?.[installBuild] ?? status.installBytes,
        )} download`
      : status.loading
        ? "Loading…"
        : status.loaded
          ? `Loaded · ${status.build === "cuda" ? "NVIDIA GPU" : "CPU"}`
          : status.installedBuild === "cuda"
            ? "Installed · NVIDIA GPU"
            : status.installedBuild === "cpu"
              ? "Installed · CPU"
              : "Installed · Ejected";
  const invoke = async (): Promise<void> => {
    setBusy(true);
    try {
      await action(
        kind,
        nextAction,
        nextAction === "install" && buildChoice ? installBuild : undefined,
      );
    } finally {
      setBusy(false);
    }
  };
  const showBuildSelector = buildChoice && !running;
  return <div className="localEngineCard" data-build-selector={showBuildSelector}>
    <div>
      <strong>{name}</strong>
      <span data-running={running} data-installing={status.installing}>{label}</span>
    </div>
    <div className="localEngineActions">
      {showBuildSelector && <select
        aria-label="Nemotron runtime"
        value={installBuild}
        disabled={working}
        onChange={(event) => {
          setInstallBuild(event.target.value === "cuda" ? "cuda" : "cpu");
        }}
      >
        <option value="cuda">
          NVIDIA{status.recommendedBuild === "cuda" ? " (Recommended)" : " GPU"}
        </option>
        <option value="cpu">
          CPU{status.recommendedBuild === "cpu" ? " (Recommended)" : ""}
        </option>
      </select>}
      <button
        type="button"
        className="smallButton accent"
        disabled={working}
        onClick={() => { void invoke(); }}
      >
        {working ? "Working…" : nextAction === "install" ? "Install" : running ? "Eject" : "Load"}
      </button>
    </div>
  </div>;
}

function formatDownloadSize(bytes: number): string {
  if (bytes <= 0) return "no additional";
  if (bytes < 100 * 1024 * 1024) return `${Math.ceil(bytes / (1 << 20))} MB`;
  return `${(bytes / (1 << 30)).toFixed(1)} GB`;
}

function KeyCard({
  provider,
  name,
  configured,
  update,
}: {
  provider: CloudProviderId;
  name: string;
  configured: boolean;
  update: (patch: SettingsPatch) => Promise<boolean>;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const save = async (nextValue: string): Promise<void> => {
    if (await update({ providerKey: { provider, value: nextValue } })) setValue("");
  };
  return <form
    className="keyCard"
    onSubmit={(event) => {
      event.preventDefault();
      if (value.trim().length > 0) void save(value);
    }}
  >
    <div className="keyHead">
      <strong>{name}</strong>
      <span data-configured={configured}>{configured ? "Saved" : "No key"}</span>
    </div>
    <div className="keyEntry">
      <input
        aria-label={`${name} API key`}
        type={visible ? "text" : "password"}
        value={value}
        placeholder={configured ? "Enter a replacement" : "Enter API key"}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="button" className="smallButton" onClick={() => setVisible(!visible)}>
        {visible ? "Hide" : "Show"}
      </button>
      <button type="submit" className="smallButton accent" disabled={value.trim().length === 0}>
        Save
      </button>
    </div>
    {configured && <button type="button" className="clearButton" onClick={() => { void save(""); }}>
      Clear saved key
    </button>}
  </form>;
}

function AppUpdates({ appVersion }: { appVersion: string }): React.JSX.Element {
  const [updateStatus, setUpdateStatus] = useState<AppUpdateSnapshot | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void settingsApi.updateStatus()
      .then((snapshot) => { if (active) setUpdateStatus(snapshot); })
      .catch((reason: unknown) => { if (active) setUpdateError(errorMessage(reason)); });
    const unsubscribe = settingsApi.onUpdateStatus((snapshot) => {
      if (active) {
        setUpdateStatus(snapshot);
        setUpdateError(null);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const checkForUpdates = async (): Promise<void> => {
    setUpdateError(null);
    try {
      setUpdateStatus(await settingsApi.checkForUpdates());
    } catch (reason) {
      setUpdateError(errorMessage(reason));
    }
  };

  const installUpdate = async (): Promise<void> => {
    setUpdateError(null);
    try {
      await settingsApi.installUpdate();
    } catch (reason) {
      setUpdateError(errorMessage(reason));
    }
  };

  const busy = updateStatus?.phase === "checking" || updateStatus?.phase === "downloading";
  const status = updateError ?? updateStatus?.message ?? "Loading update status…";
  return <SettingRow title="App updates" description={`Version ${updateStatus?.currentVersion ?? appVersion} · ${status}`}>
    <div className="updateControl">
      {updateStatus?.phase === "downloaded"
        ? <button type="button" className="smallButton accent" onClick={() => { void installUpdate(); }}>
            Restart and install
          </button>
        : <button
            type="button"
            className="smallButton"
            disabled={busy || updateStatus?.supported !== true}
            onClick={() => { void checkForUpdates(); }}
          >
            {updateStatus?.phase === "checking"
              ? "Checking…"
              : updateStatus?.phase === "downloading"
                ? `${Math.round(updateStatus.progress ?? 0)}%`
                : "Check"}
          </button>}
      {updateStatus?.phase === "downloading" && <progress
        aria-label="Update download progress"
        max={100}
        value={updateStatus.progress ?? 0}
      />}
    </div>
  </SettingRow>;
}

function SettingRow({
  title,
  description,
  children,
}: React.PropsWithChildren<{ title: string; description?: React.ReactNode }>): React.JSX.Element {
  return <div className="settingRow">
    <div><h3>{title}</h3>{description !== undefined && <p>{description}</p>}</div>
    <div className="control">{children}</div>
  </div>;
}

function Toggle({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return <button
    type="button"
    className="toggle"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    data-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
  ><span /></button>;
}

function NavItem({
  active,
  icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: Section;
  label: string;
  description: string;
  onClick: () => void;
}): React.JSX.Element {
  return <button
    type="button"
    className="navItem"
    data-active={active}
    aria-label={`${label} — ${description}`}
    aria-current={active ? "page" : undefined}
    onClick={onClick}
  >
    <NavIcon icon={icon} />
    <span className="navTip"><strong>{label}</strong><small>{description}</small></span>
  </button>;
}

function NavIcon({ icon }: { icon: Section }): React.JSX.Element {
  if (icon === "general") return <svg className="navIcon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="m4 10 8-6 8 6v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z" />
  </svg>;
  if (icon === "speechAi") return <svg className="navIcon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.6 4.6a10.5 10.5 0 0 0 0 14.8M19.4 4.6a10.5 10.5 0 0 1 0 14.8" />
  </svg>;
  if (icon === "dictionary") return <svg className="navIcon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 4h5a3 3 0 0 1 2 1 3 3 0 0 1 2-1h5v15h-5a3 3 0 0 0-2 1 3 3 0 0 0-2-1H5zM12 5v15" />
  </svg>;
  return <svg className="navIcon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6M4 4v4.6h4.6M12 7v5l3 2" />
  </svg>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

const root = document.getElementById("root");
if (root === null) throw new Error("Settings root is missing");
createRoot(root).render(<SettingsApp />);
