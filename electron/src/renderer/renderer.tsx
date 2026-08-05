import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  AppUpdateSnapshot,
  CloudProviderId,
  LocalEngineAction,
  LocalEngineKind,
  LocalEngineSnapshot,
  HistoryAction,
  HistorySnapshotEntry,
  ProviderTestKind,
  SettingsPatch,
  SettingsProviderId,
  SettingsSnapshot,
  ShortcutSetting,
  SystemAction,
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
            ? <SpeechAi settings={settings} update={update} localAction={localAction} />
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
      <SettingRow title="Smart formatting" description="Use caret context for spacing and capitalization.">
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
const PROVIDERS: readonly { id: SettingsProviderId; label: string }[] = [
  ...CLOUD_PROVIDERS,
  { id: "local", label: "Local" },
];

function SpeechAi({
  settings,
  update,
  localAction,
}: {
  settings: SettingsSnapshot;
  update: (patch: SettingsPatch) => Promise<boolean>;
  localAction: (kind: LocalEngineKind, action: LocalEngineAction) => Promise<boolean>;
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
      <p>Choose transcription and cleanup services, credentials, and local models.</p>
    </header>
    <h2>Services</h2>
    <div className="card">
      <SettingRow title="Transcription" description="Turns your speech into text.">
        <div className="serviceControl">
          <ProviderSelect
            label="Transcription provider"
            value={settings.provider}
            localAvailable={settings.localEngines.stt.installed}
            onChange={(provider) => { void update({ provider }); }}
          />
          <button type="button" className="smallButton" disabled={testing !== null} onClick={() => { void test("stt"); }}>
            {testing === "stt" ? "Testing…" : "Test"}
          </button>
          {testResults.stt && <small role="status">{testResults.stt}</small>}
        </div>
      </SettingRow>
      <SettingRow title="AI cleanup" description="Polishes the wording before it is pasted.">
        <div className="serviceControl">
          <ProviderSelect
            label="Cleanup provider"
            value={settings.cleanupProvider}
            localAvailable={settings.localEngines.cleanup.installed}
            onChange={(cleanupProvider) => { void update({ cleanupProvider }); }}
          />
          <button type="button" className="smallButton" disabled={testing !== null} onClick={() => { void test("cleanup"); }}>
            {testing === "cleanup" ? "Testing…" : "Test"}
          </button>
          {testResults.cleanup && <small role="status">{testResults.cleanup}</small>}
        </div>
      </SettingRow>
    </div>

    <h2>Credentials</h2>
    {activeCredentialProviders.length === 0
      ? <div className="card emptyList">No cloud credentials are needed for the selected services.</div>
      : <div className="providerGrid">
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
      </div>
    </details>}
    <p className="privacyNote">
      Saved keys are DPAPI-encrypted by the main process and are never returned to this page.
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
    <details className="advancedSection">
      <summary>Advanced</summary>
      <div className="advancedGroup">
        <h3>Model overrides</h3>
        <div className="card modelCard">
          <ModelControl
            key={`stt-${settings.provider}`}
            label="Transcription model"
            kind="stt"
            provider={settings.provider}
            current={settings.sttModel}
            update={update}
          />
          <ModelControl
            key={`cleanup-${settings.cleanupProvider}`}
            label="Cleanup model"
            kind="cleanup"
            provider={settings.cleanupProvider}
            current={settings.cleanupModel}
            update={update}
          />
        </div>
      </div>
      <div className="advancedGroup">
        <h3>On-device behavior</h3>
        <div className="card">
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
      </div>
      <div className="advancedGroup">
        <h3>Cleanup tuning</h3>
        <div className="card modelCard">
          <form className="modelControl" onSubmit={(event) => {
            event.preventDefault();
            const field = event.currentTarget.elements.namedItem("cleanupTimeout");
            if (field instanceof HTMLInputElement) {
              void update({ cleanupTimeout: Number(field.value) });
            }
          }}>
            <label htmlFor="cleanup-timeout">Cleanup timeout (seconds)</label>
            <div className="modelEntry">
              <input id="cleanup-timeout" name="cleanupTimeout" type="number" min="0.5" max="30" step="0.1" defaultValue={settings.cleanupTimeout} />
              <button type="submit" className="smallButton accent">Save</button>
            </div>
          </form>
          <PromptControl current={settings.cleanupPrompt} saved={settings.cleanupPrompts} update={update} />
        </div>
      </div>
    </details>
  </section>;
}

function PromptControl({
  current,
  saved,
  update,
}: {
  current: string;
  saved: Record<string, string>;
  update: (patch: SettingsPatch) => Promise<boolean>;
}): React.JSX.Element {
  const [value, setValue] = useState(current);
  const [selected, setSelected] = useState("");
  const [saveName, setSaveName] = useState("");
  const save = (): void => {
    const patch: SettingsPatch = { cleanupPrompt: value };
    if (selected.length > 0) patch.cleanupPrompts = { ...saved, [selected]: value };
    void update(patch);
  };
  const saveAs = (): void => {
    const name = saveName.trim();
    if (name.length === 0 || value.trim().length === 0) return;
    void update({ cleanupPrompt: value, cleanupPrompts: { ...saved, [name]: value } });
    setSelected(name);
    setSaveName("");
  };
  return <form className="modelControl" onSubmit={(event) => {
    event.preventDefault();
    save();
  }}>
    <div className="promptHead">
      <label htmlFor="cleanup-prompt">Cleanup system prompt</label>
      <select aria-label="Saved cleanup prompt" value={selected} onChange={(event) => {
        const name = event.target.value;
        setSelected(name);
        setValue(name.length === 0 ? "" : saved[name] ?? "");
        void update({ cleanupPrompt: name.length === 0 ? "" : saved[name] ?? "" });
      }}>
        <option value="">Built-in default</option>
        {Object.keys(saved).sort((left, right) => left.localeCompare(right)).map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </div>
    <textarea id="cleanup-prompt" value={value} placeholder="Empty uses the built-in prompt." onChange={(event) => setValue(event.target.value)} />
    <div className="promptActions">
      <small>Empty uses the built-in default.</small>
      <button type="submit" className="smallButton accent">Save</button>
    </div>
    <div className="promptActions">
      <input aria-label="New prompt save name" placeholder="New save name" value={saveName} onChange={(event) => setSaveName(event.target.value)} />
      <button type="button" className="smallButton" onClick={saveAs}>Save as new</button>
      {selected.length > 0 && <button type="button" className="clearButton" onClick={() => {
        const next = { ...saved };
        delete next[selected];
        setSelected("");
        setValue("");
        void update({ cleanupPrompt: "", cleanupPrompts: next });
      }}>Delete save</button>}
    </div>
  </form>;
}

function ProviderSelect({
  label,
  value,
  localAvailable,
  onChange,
}: {
  label: string;
  value: SettingsProviderId;
  localAvailable: boolean;
  onChange: (value: SettingsProviderId) => void;
}): React.JSX.Element {
  return <select
    aria-label={label}
    value={value}
    onChange={(event) => onChange(event.target.value as SettingsProviderId)}
  >
    {PROVIDERS.map((provider) => <option
      key={provider.id}
      value={provider.id}
      disabled={provider.id === "local" && !localAvailable}
    >{provider.label}</option>)}
  </select>;
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

function ModelControl({
  label,
  kind,
  provider,
  current,
  update,
}: {
  label: string;
  kind: "stt" | "cleanup";
  provider: SettingsProviderId;
  current: string;
  update: (patch: SettingsPatch) => Promise<boolean>;
}): React.JSX.Element {
  const [value, setValue] = useState(current);
  const save = (): void => {
    const model = { provider, value };
    void update(kind === "stt" ? { sttModel: model } : { cleanupModel: model });
  };
  return <form className="modelControl" onSubmit={(event) => { event.preventDefault(); save(); }}>
    <label htmlFor={`${kind}-model`}>{label}</label>
    <div className="modelEntry">
      <input
        id={`${kind}-model`}
        value={value}
        placeholder="Provider default"
        spellCheck={false}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit" className="smallButton accent">Save</button>
    </div>
    <small>Empty uses the {providerLabel(provider)} default.</small>
  </form>;
}

function providerLabel(provider: SettingsProviderId): string {
  return PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider;
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
    hotkey: "right ctrl",
    repasteHotkey: "ctrl+alt+v",
    inputDevice: "",
    microphones: ["Microphone Array (Realtek Audio)", "USB Podcast Mic"],
    appVersion: "1.7.1",
    preview: true,
    provider: "local",
    cleanupProvider: "local",
    keyConfigured: { xai: false, openai: false, openrouter: false },
    sttModel: "",
    cleanupModel: "",
    localLoaded: false,
    localIdleMinutes: 0,
    sttVocabHints: true,
    vocabulary: ["Undertone", "Kubernetes"],
    corrections: { "under tone": "Undertone" },
    cleanupTimeout: 2.5,
    cleanupPrompt: "",
    cleanupPrompts: {},
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
    currentVersion: "1.7.1",
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
      if (patch.sttModel !== undefined && patch.sttModel.provider === preview.provider) {
        preview = { ...preview, sttModel: patch.sttModel.value.trim() };
      }
      if (patch.cleanupModel !== undefined
        && patch.cleanupModel.provider === preview.cleanupProvider) {
        preview = { ...preview, cleanupModel: patch.cleanupModel.value.trim() };
      }
      if (patch.provider !== undefined && patch.provider !== preview.provider) {
        preview = { ...preview, sttModel: "" };
      }
      if (patch.cleanupProvider !== undefined
        && patch.cleanupProvider !== preview.cleanupProvider) {
        preview = { ...preview, cleanupModel: "" };
      }
      const { providerKey: _providerKey, sttModel: _sttModel, cleanupModel: _cleanupModel, ...plain } = patch;
      preview = { ...preview, ...plain };
      return preview;
    },
    async captureShortcut(field) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      preview = {
        ...preview,
        [field]: field === "hotkey" ? "f13" : "ctrl+shift+v",
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
