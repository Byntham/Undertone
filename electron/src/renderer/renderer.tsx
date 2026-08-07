import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  AppUpdateSnapshot,
  CloudProviderId,
  CleanupProviderId,
  LocalEngineAction,
  LocalEngineKind,
  LocalEngineSnapshot,
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
import desktopIconUrl from "../../../assets/icon.png";
import "./style.css";

type Section = "general" | "speechAi" | "dictionary" | "history";
const settingsApi = settingsApiForRenderer();

function SettingsApp(): React.JSX.Element {
  const [section, setSection] = useState<Section>("general");
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [capturing, setCapturing] = useState<ShortcutSetting | null>(null);
  const [history, setHistory] = useState<HistorySnapshotEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void settingsApi.load()
        .then((snapshot) => { if (active) setSettings(snapshot); })
        .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
      void settingsApi.history()
        .then((entries) => { if (active) setHistory(entries); })
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [section]);

  const update = async (patch: SettingsPatch): Promise<boolean> => {
    setError(null);
    try {
      setSettings(await settingsApi.update(patch));
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    }
  };

  const historyAction = async (id: number, action: HistoryAction): Promise<void> => {
    setError(null);
    try {
      await settingsApi.historyAction(id, action);
      setHistory(await settingsApi.history());
    } catch (reason) {
      setError(errorMessage(reason));
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
  ): Promise<boolean> => {
    setError(null);
    try {
      setSettings(await settingsApi.localAction(kind, action));
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    }
  };

  const openAiSubscriptionAction = async (
    action: OpenAiSubscriptionAction,
  ): Promise<boolean> => {
    setError(null);
    try {
      setSettings(await settingsApi.openAiSubscriptionAction(action));
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    }
  };

  const captureShortcut = async (field: ShortcutSetting): Promise<void> => {
    setError(null);
    setCapturing(field);
    try {
      setSettings(await settingsApi.captureShortcut(field));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setCapturing(null);
    }
  };

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <img className="brandMark" src={desktopIconUrl} alt="" />
      </div>
      <nav aria-label="Settings sections">
        <NavItem active={section === "general"} onClick={() => setSection("general")}>
          General
        </NavItem>
        <NavItem active={section === "speechAi"} onClick={() => setSection("speechAi")}>
          Speech &amp; AI
        </NavItem>
        <NavItem active={section === "dictionary"} onClick={() => setSection("dictionary")}>
          Dictionary
        </NavItem>
        <NavItem active={section === "history"} onClick={() => setSection("history")}>
          History
        </NavItem>
      </nav>
    </aside>
    <main ref={contentRef} className="content">
      {settings === null
        ? <div className="loading">{error ?? "Loading settings…"}</div>
        : section === "general"
          ? <General
              settings={settings}
              update={update}
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
  capturing,
  captureShortcut,
  systemAction,
}: {
  settings: SettingsSnapshot;
  update: (patch: SettingsPatch) => Promise<boolean>;
  capturing: ShortcutSetting | null;
  captureShortcut: (field: ShortcutSetting) => Promise<void>;
  systemAction: (action: SystemAction) => Promise<void>;
}): React.JSX.Element {
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
    <header className="pageHeader">
      <p className="eyebrow">SETTINGS</p>
      <h1>General</h1>
      <p>Recording, output, and application behavior.</p>
    </header>
    <div className="card">
      {settings.shortcutWarning !== null
        && <p className="shortcutWarning" role="status">{settings.shortcutWarning}</p>}
      <SettingRow title="Push-to-talk shortcut" description="Hold this shortcut while you speak.">
        <ShortcutControl
          field="hotkey"
          value={settings.hotkey}
          capturing={capturing}
          capture={captureShortcut}
        />
      </SettingRow>
      <SettingRow title="Re-paste last dictation" description="Paste the newest successful result again.">
        <ShortcutControl
          field="repasteHotkey"
          value={settings.repasteHotkey}
          capturing={capturing}
          capture={captureShortcut}
        />
      </SettingRow>
      <SettingRow
        title="Commit open turn"
        description="In stack mode, paste the full turn into the focused app."
      >
        <ShortcutControl
          field="commitHotkey"
          value={settings.commitHotkey}
          capturing={capturing}
          capture={captureShortcut}
        />
      </SettingRow>
      <SettingRow
        title="Scratch last fragment"
        description="Drop only the newest fragment from the open turn."
      >
        <ShortcutControl
          field="scratchHotkey"
          value={settings.scratchHotkey}
          capturing={capturing}
          capture={captureShortcut}
        />
      </SettingRow>
      <SettingRow
        title="Discard open turn"
        description="Clear the whole unfinished turn without pasting."
      >
        <ShortcutControl
          field="discardHotkey"
          value={settings.discardHotkey}
          capturing={capturing}
          capture={captureShortcut}
        />
      </SettingRow>
      <SettingRow
        title="Dictation mode"
        description="Stack builds a turn from fragments. Instant pastes each utterance."
      >
        <select
          aria-label="Dictation mode"
          value={settings.dictationMode}
          onChange={(event) => {
            void update({
              dictationMode: event.target.value === "instant" ? "instant" : "stack",
            });
          }}
        >
          <option value="stack">Stack fragments (commit to send)</option>
          <option value="instant">Instant paste</option>
        </select>
      </SettingRow>
      <SettingRow
        title="Stack cleanup timing"
        description="Choose when AI cleanup rewrites an open turn. Instant mode is unaffected."
      >
        <select
          aria-label="Stack cleanup timing"
          value={settings.stackCleanupStrategy}
          disabled={settings.dictationMode !== "stack"}
          onChange={(event) => {
            void update({
              stackCleanupStrategy: event.target.value === "commit-full"
                ? "commit-full"
                : "live-full",
            });
          }}
        >
          <option value="live-full">Whole turn after every fragment</option>
          <option value="commit-full">Whole turn only when committing</option>
        </select>
      </SettingRow>
      <SettingRow title="Microphone" description="Select the input device by its Windows name.">
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
          >{testingMicrophone ? "Testing..." : "Test"}</button>
          {microphoneStatus !== null && <small role="status">{microphoneStatus}</small>}
        </div>
      </SettingRow>
      <SettingRow title="Transcription language" description="Language hint sent to the selected speech provider.">
        <select
          aria-label="Transcription language"
          value={settings.language}
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
      <SettingRow title="Sound cues" description="Play short tones for start, stop, lock, and cancel.">
        <Toggle
          label="Sound cues"
          checked={settings.soundCues}
          onChange={(soundCues) => { void update({ soundCues }); }}
        />
      </SettingRow>
    </div>
    <h2>Output</h2>
    <div className="card">
      <SettingRow
        title="Smart formatting"
        description="Use surrounding context for spacing and capitalization (turn buffer in stack mode)."
      >
        <Toggle
          label="Smart formatting"
          checked={settings.smartFormatting}
          onChange={(checked) => { void update({ smartFormatting: checked }); }}
        />
      </SettingRow>
      <SettingRow title="AI cleanup" description="Polish transcript wording; failures fall back to local rules.">
        <Toggle
          label="AI cleanup"
          checked={settings.aiCleanup}
          onChange={(checked) => { void update({ aiCleanup: checked }); }}
        />
      </SettingRow>
      <SettingRow title="Restore clipboard" description="Put previous clipboard text back after a successful paste.">
        <Toggle
          label="Restore clipboard"
          checked={settings.restoreClipboard}
          onChange={(checked) => { void update({ restoreClipboard: checked }); }}
        />
      </SettingRow>
    </div>
    <h2>Application</h2>
    <div className="card">
      <SettingRow title="Start with Windows" description="Launch quietly in the tray when you sign in.">
        <Toggle
          label="Start with Windows"
          checked={settings.startWithWindows}
          onChange={(startWithWindows) => { void update({ startWithWindows }); }}
        />
      </SettingRow>
    </div>
    <h2>About</h2>
    <div className="card aboutCard">
      <img className="aboutIcon" src={desktopIconUrl} alt="" />
      <div>
        <h2>Undertone {settings.appVersion}</h2>
        <p>{settings.preview ? "Isolated Electron preview" : "Production channel"}</p>
      </div>
    </div>
    <AppUpdates />
    <div className="aboutLinks">
      <button type="button" className="smallButton" onClick={() => { void systemAction("openSettingsFolder"); }}>Open settings folder</button>
      <button type="button" className="smallButton" onClick={() => { void systemAction("openLog"); }}>View log</button>
    </div>
  </section>;
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
  return <div className="shortcutControl">
    <span className="keycap">{active ? "Press shortcut…" : value || "Disabled"}</span>
    <button
      type="button"
      className="smallButton"
      disabled={capturing !== null}
      onClick={() => { void capture(field); }}
    >{active ? "Listening…" : "Change"}</button>
  </div>;
}

function Dictionary({
  settings,
  update,
}: {
  settings: SettingsSnapshot;
  update: (patch: SettingsPatch) => Promise<boolean>;
}): React.JSX.Element {
  const [term, setTerm] = useState("");
  const [heard, setHeard] = useState("");
  const [replacement, setReplacement] = useState("");
  const addTerm = (): void => {
    const value = term.trim();
    if (value.length === 0 || settings.vocabulary.includes(value)) return;
    void update({ vocabulary: [...settings.vocabulary, value] }).then((saved) => {
      if (saved) setTerm("");
    });
  };
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
    <header className="pageHeader">
      <p className="eyebrow">SETTINGS</p>
      <h1>Dictionary</h1>
      <p>Teach Undertone names, jargon, and exact replacements.</p>
    </header>
    <h2>Vocabulary</h2>
    <div className="card">
      <form className="entryForm" onSubmit={(event) => { event.preventDefault(); addTerm(); }}>
        <input aria-label="Vocabulary term" value={term} onChange={(event) => setTerm(event.target.value)} />
        <button type="submit" className="smallButton accent">Add</button>
      </form>
      <EditableList
        empty="No terms yet."
        entries={settings.vocabulary.map((value) => ({ key: value, label: value }))}
        remove={(value) => { void update({ vocabulary: settings.vocabulary.filter((item) => item !== value) }); }}
      />
    </div>
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
    {settings.provider === "xai" && <div className="card localPolicy">
      <SettingRow title="Send recognition hints" description="xAI receives these terms as key-term hints; other providers do not.">
        <Toggle label="Send recognition hints" checked={settings.sttVocabHints} onChange={(sttVocabHints) => {
          void update({ sttVocabHints });
        }} />
      </SettingRow>
    </div>}
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
      <p className="eyebrow">SESSION</p>
      <h1>History</h1>
      <p>Recent dictations live in memory and disappear when Undertone exits.</p>
    </header>
    <div className="historyList">
      {entries.length === 0 && <div className="card emptyList">Nothing dictated yet this session.</div>}
      {entries.map((entry) => <article key={entry.id} className="historyEntry" data-ok={entry.ok}>
        <time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        <div>
          <p>{entry.ok ? entry.text : entry.error}</p>
          {entry.raw !== null && <small>Heard: {entry.raw}</small>}
        </div>
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
  localAction: (kind: LocalEngineKind, action: LocalEngineAction) => Promise<boolean>;
  openAiSubscriptionAction: (action: OpenAiSubscriptionAction) => Promise<boolean>;
}): React.JSX.Element {
  const [testing, setTesting] = useState<ProviderTestKind | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<ProviderTestKind, string>>>({});
  const test = async (kind: ProviderTestKind): Promise<void> => {
    setTesting(kind);
    setTestResults((current) => ({ ...current, [kind]: "" }));
    try {
      const message = `✓ ${await settingsApi.providerTest(kind)}`;
      setTestResults((current) => ({ ...current, [kind]: message }));
    } catch (reason) {
      setTestResults((current) => ({ ...current, [kind]: errorMessage(reason) }));
    } finally {
      setTesting(null);
    }
  };
  const activeCredentialProviders = CLOUD_PROVIDERS.filter(({ id }) => (
    settings.provider === id || settings.cleanupProvider === id
  ));
  const otherCredentialProviders = CLOUD_PROVIDERS.filter(({ id }) => (
    settings.provider !== id && settings.cleanupProvider !== id
  ));
  return <section>
    <header className="pageHeader">
      <p className="eyebrow">SETTINGS</p>
      <h1>Speech &amp; AI</h1>
      <p>Choose transcription and cleanup services and credentials.</p>
    </header>
    <h2>Services</h2>
    <div className="card">
      <SettingRow title="Transcription" description="Turns your speech into text.">
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
          <small className="modelSummary">Model: {modelLabel("stt", settings.sttModel)}</small>
          {testResults.stt && <small role="status">{testResults.stt}</small>}
        </div>
      </SettingRow>
      <SettingRow title="AI cleanup" description="Polishes the wording before it is pasted.">
        <div className="serviceControl">
          <ProviderSelect
            label="Cleanup provider"
            value={settings.cleanupProvider}
            localAvailable={settings.localEngines.cleanup.installed}
            providers={CLEANUP_PROVIDERS}
            onChange={(cleanupProvider) => { void update({ cleanupProvider }); }}
          />
          <button type="button" className="smallButton" disabled={testing !== null} onClick={() => { void test("cleanup"); }}>
            {testing === "cleanup" ? "Testing…" : "Test"}
          </button>
          <small className="modelSummary">Model: {modelLabel("cleanup", settings.cleanupModel)}</small>
          {testResults.cleanup && <small role="status">{testResults.cleanup}</small>}
        </div>
      </SettingRow>
    </div>

    <h2>Credentials</h2>
    {activeCredentialProviders.length === 0 && settings.cleanupProvider !== "openai-subscription"
      ? <div className="card emptyList">No cloud credentials are needed for the selected services.</div>
      : <div className="providerGrid">
          {settings.cleanupProvider === "openai-subscription" && <SubscriptionCard
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
        {settings.cleanupProvider !== "openai-subscription" && <SubscriptionCard
          connected={settings.openAiSubscriptionConnected}
          action={openAiSubscriptionAction}
        />}
      </div>
    </details>}
    <p className="privacyNote">
      Saved keys and OpenAI sign-in tokens are DPAPI-encrypted and never returned to this page.
    </p>

    <h2>On-device</h2>
    <div className="providerGrid">
      <LocalEngineCard
        kind="stt"
        name="Transcription model"
        status={settings.localEngines.stt}
        action={localAction}
      />
      <LocalEngineCard
        kind="cleanup"
        name="Cleanup model"
        status={settings.localEngines.cleanup}
        action={localAction}
      />
    </div>
    <div className="card localPolicy">
      <SettingRow
        title="Load models on startup"
        description="Warm selected local providers when Undertone starts."
      >
        <Toggle
          label="Load local models on startup"
          checked={settings.localLoaded}
          onChange={(localLoaded) => { void update({ localLoaded }); }}
        />
      </SettingRow>
      <SettingRow title="Auto-eject when idle" description="Free model memory after inactivity.">
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
  </section>;
}

function ProviderSelect<T extends SettingsProviderId>({
  label,
  value,
  localAvailable,
  providers,
  onChange,
}: {
  label: string;
  value: T;
  localAvailable: boolean;
  providers: readonly { id: T; label: string }[];
  onChange: (value: T) => void;
}): React.JSX.Element {
  return <select
    aria-label={label}
    value={value}
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
        <small>Cleanup only. Transcription still uses an API key or a local model.</small>
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
}: {
  kind: LocalEngineKind;
  name: string;
  status: LocalEngineSnapshot;
  action: (kind: LocalEngineKind, action: LocalEngineAction) => Promise<boolean>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const running = status.loaded || status.loading;
  const working = busy || status.installing;
  const nextAction: LocalEngineAction = !status.installed
    ? "install"
    : running
      ? "eject"
      : "load";
  const label = status.installing
    ? `${status.installPhase || "Installing"} · ${Math.round(status.installFraction * 100)}%`
    : !status.installed
      ? `Not installed · ${formatDownloadSize(status.installBytes)} download`
      : status.loading
        ? "Loading…"
        : status.loaded
          ? `Loaded · ${status.build?.toUpperCase() ?? "READY"}`
          : "Installed · Ejected";
  const invoke = async (): Promise<void> => {
    setBusy(true);
    try {
      await action(kind, nextAction);
    } finally {
      setBusy(false);
    }
  };
  return <div className="localEngineCard">
    <div>
      <strong>{name}</strong>
      <span data-running={running} data-installing={status.installing}>{label}</span>
    </div>
    <button
      type="button"
      className="smallButton accent"
      disabled={working}
      onClick={() => { void invoke(); }}
    >
      {working ? "Working…" : nextAction === "install" ? "Install" : running ? "Eject" : "Load"}
    </button>
  </div>;
}

function formatDownloadSize(bytes: number): string {
  if (bytes <= 0) return "no additional";
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

function modelLabel(kind: "stt" | "cleanup", model: string): string {
  if (model.length === 0) return kind === "stt" ? "xAI managed" : "Provider managed";
  const names: Readonly<Record<string, string>> = {
    "gpt-transcribe": "GPT Transcribe",
    "openai/gpt-transcribe": "GPT Transcribe",
    "gpt-4o-transcribe": "GPT-4o Transcribe",
    "openai/gpt-4o-transcribe": "GPT-4o Transcribe",
    "gpt-5.6-luna": "GPT-5.6 Luna",
    "openai/gpt-5.6-luna": "GPT-5.6 Luna",
    "grok-4.3": "Grok 4.3",
    "ggml-large-v3-turbo.bin": "Whisper Large V3 Turbo",
    "Qwen3-4B-Instruct-2507-Q4_K_M.gguf": "Qwen3 4B Instruct",
  };
  return names[model] ?? model;
}

function AppUpdates(): React.JSX.Element {
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
  return <div className="card updateCard">
      <div className="updateCopy">
        <h3>Application updates</h3>
        <p role="status" data-error={updateStatus?.phase === "error" || updateError !== null}>
          {updateError ?? updateStatus?.message ?? "Loading update status..."}
        </p>
        {updateStatus?.phase === "downloading" && <progress
          aria-label="Update download progress"
          max={100}
          value={updateStatus.progress ?? 0}
        />}
      </div>
      {updateStatus?.phase === "downloaded"
        ? <button type="button" className="smallButton accent" onClick={() => { void installUpdate(); }}>
            Restart and install
          </button>
        : <button
            type="button"
            className="smallButton accent"
            disabled={busy || updateStatus?.supported !== true}
            onClick={() => { void checkForUpdates(); }}
          >
            {updateStatus?.phase === "checking"
              ? "Checking..."
              : updateStatus?.phase === "downloading"
                ? `${Math.round(updateStatus.progress ?? 0)}%`
                : "Check for updates"}
          </button>}
  </div>;
}

function SettingRow({
  title,
  description,
  children,
}: React.PropsWithChildren<{ title: string; description: string }>): React.JSX.Element {
  return <div className="settingRow">
    <div><h3>{title}</h3><p>{description}</p></div>
    <div className="control">{children}</div>
  </div>;
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return <button
    type="button"
    className="toggle"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    data-checked={checked}
    onClick={() => onChange(!checked)}
  ><span /></button>;
}

function NavItem({
  active,
  onClick,
  children,
}: React.PropsWithChildren<{ active: boolean; onClick: () => void }>): React.JSX.Element {
  return <button
    type="button"
    className="navItem"
    data-active={active}
    aria-current={active ? "page" : undefined}
    onClick={onClick}
  >
    {children}
  </button>;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function previewModel(kind: "stt" | "cleanup", provider: SettingsProviderId): string {
  if (kind === "stt") {
    if (provider === "xai") return "";
    if (provider === "openai") return "gpt-transcribe";
    if (provider === "openrouter") return "openai/gpt-transcribe";
    return "ggml-large-v3-turbo.bin";
  }
  if (provider === "xai") return "grok-4.3";
  if (provider === "openrouter") return "openai/gpt-5.6-luna";
  if (provider === "local") return "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
  return "gpt-5.6-luna";
}

function settingsApiForRenderer(): Window["undertoneSettings"] {
  if (window.undertoneSettings !== undefined) return window.undertoneSettings;
  const loopback = location.hostname === "localhost"
    || location.hostname === "127.0.0.1"
    || location.hostname === "[::1]";
  if (location.protocol !== "http:" || !loopback) {
    throw new Error("Settings preload is unavailable");
  }
  let preview: SettingsSnapshot = {
    language: "en",
    smartFormatting: true,
    aiCleanup: true,
    restoreClipboard: true,
    soundCues: true,
    startWithWindows: false,
    hotkey: "left ctrl+left windows",
    repasteHotkey: "left alt+v",
    commitHotkey: "left ctrl+left alt",
    scratchHotkey: "left ctrl+left alt+backspace",
    discardHotkey: "ctrl+alt+shift+backspace",
    shortcutWarning: null,
    dictationMode: "stack",
    stackCleanupStrategy: "live-full",
    inputDevice: "",
    microphones: ["Microphone Array (Realtek Audio)", "USB Podcast Mic"],
    appVersion: "1.8.0",
    preview: true,
    provider: "openai",
    cleanupProvider: "openai-subscription",
    keyConfigured: { xai: false, openai: true, openrouter: false },
    openAiSubscriptionConnected: true,
    sttModel: "gpt-transcribe",
    cleanupModel: "gpt-5.6-luna",
    localLoaded: false,
    localIdleMinutes: 0,
    sttVocabHints: true,
    vocabulary: ["Undertone", "Kubernetes"],
    corrections: { "under tone": "Undertone" },
    localEngines: {
      stt: {
        installed: true,
        loaded: false,
        loading: false,
        build: null,
        installing: false,
        installPhase: "",
        installFraction: 0,
        installBytes: 0,
      },
      cleanup: {
        installed: false,
        loaded: false,
        loading: false,
        build: null,
        installing: false,
        installPhase: "",
        installFraction: 0,
        installBytes: 3_155_769_803,
      },
    },
  };
  const previewUpdate: AppUpdateSnapshot = {
    supported: false,
    phase: "unavailable",
    currentVersion: "1.8.0",
    availableVersion: null,
    progress: null,
    message: "Update checks are available in the installed app.",
  };
  return {
    async load() { return preview; },
    async update(patch) {
      if (patch.providerKey !== undefined) {
        preview = {
          ...preview,
          keyConfigured: {
            ...preview.keyConfigured,
            [patch.providerKey.provider]: patch.providerKey.value.trim().length > 0,
          },
        };
      }
      if (patch.provider !== undefined && patch.provider !== preview.provider) {
        preview = { ...preview, sttModel: previewModel("stt", patch.provider) };
      }
      if (patch.cleanupProvider !== undefined
        && patch.cleanupProvider !== preview.cleanupProvider) {
        preview = { ...preview, cleanupModel: previewModel("cleanup", patch.cleanupProvider) };
      }
      const { providerKey: _providerKey, ...plain } = patch;
      preview = { ...preview, ...plain };
      return preview;
    },
    async captureShortcut(field) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      preview = {
        ...preview,
        [field]: field === "hotkey"
          ? "f13"
          : field === "commitHotkey"
            ? "left ctrl+left alt+enter"
            : field === "scratchHotkey"
              ? "left ctrl+left alt+backspace"
              : field === "discardHotkey"
                ? "left ctrl+left alt+left shift+backspace"
                : "left ctrl+left shift+v",
      };
      return preview;
    },
    async localAction(kind, action) {
      if (action === "install") {
        preview = {
          ...preview,
          localEngines: {
            ...preview.localEngines,
            [kind]: {
              ...preview.localEngines[kind],
              installing: true,
              installPhase: "Downloading model",
              installFraction: 0.42,
            },
          },
        };
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      preview = {
        ...preview,
        localEngines: {
          ...preview.localEngines,
          [kind]: {
            ...preview.localEngines[kind],
            installed: action === "install" || preview.localEngines[kind].installed,
            loaded: action === "load",
            loading: false,
            build: action === "load" ? "cuda" : null,
            installing: false,
            installPhase: "",
            installFraction: 0,
            installBytes: action === "install" ? 0 : preview.localEngines[kind].installBytes,
          },
        },
      };
      return preview;
    },
    async history() {
      return [
        { id: 2, ok: true, text: "Undertone is ready.", raw: null, error: null, timestamp: Date.now(), retryable: false },
        { id: 1, ok: false, text: "", raw: null, error: "A provider request timed out", timestamp: Date.now() - 60_000, retryable: true },
      ];
    },
    async historyAction() {},
    async systemAction() {},
    async providerTest(kind) { return `${kind} works`; },
    async openAiSubscriptionAction(action) {
      preview = { ...preview, openAiSubscriptionConnected: action === "connect" };
      return preview;
    },
    async microphoneTest() { return 0.18; },
    async updateStatus() { return previewUpdate; },
    async checkForUpdates() { return previewUpdate; },
    async installUpdate() { throw new Error(previewUpdate.message); },
    onUpdateStatus() { return () => undefined; },
  };
}

const root = document.getElementById("root");
if (root === null) throw new Error("Settings root is missing");
createRoot(root).render(<SettingsApp />);
