import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type {
  CloudProviderId,
  LocalEngineAction,
  LocalEngineKind,
  LocalEngineSnapshot,
  SettingsPatch,
  SettingsProviderId,
  SettingsSnapshot,
} from "../shared/settings";
import "./style.css";

type Section = "general" | "providers" | "about";
const settingsApi = settingsApiForRenderer();

function SettingsApp(): React.JSX.Element {
  const [section, setSection] = useState<Section>("general");
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = (): void => {
      void settingsApi.load()
        .then((snapshot) => { if (active) setSettings(snapshot); })
        .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); });
    };
    refresh();
    const timer = setInterval(refresh, 1_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const update = async (patch: SettingsPatch): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await settingsApi.update(patch));
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setSaving(false);
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

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand">
        <span className="brandMark" aria-hidden="true">U</span>
        <div><strong>Undertone</strong><small>Electron preview</small></div>
      </div>
      <nav aria-label="Settings sections">
        <NavItem active={section === "general"} onClick={() => setSection("general")}>
          General
        </NavItem>
        <NavItem active={section === "providers"} onClick={() => setSection("providers")}>
          Providers
        </NavItem>
        <NavItem active={section === "about"} onClick={() => setSection("about")}>
          About
        </NavItem>
      </nav>
      <div className="sidebarFoot">
        Hold {settings?.hotkey ?? "right ctrl"} to dictate
      </div>
    </aside>
    <main className="content">
      {settings === null
        ? <div className="loading">{error ?? "Loading settings…"}</div>
        : section === "general"
          ? <General settings={settings} update={update} />
          : section === "providers"
            ? <Providers settings={settings} update={update} localAction={localAction} />
            : <About settings={settings} />}
      <div className={`saveState ${error !== null ? "failed" : ""}`} role="status">
        {error ?? (saving ? "Saving…" : settings === null ? "" : "✓ Saved")}
      </div>
    </main>
  </div>;
}

function General({
  settings,
  update,
}: {
  settings: SettingsSnapshot;
  update: (patch: SettingsPatch) => Promise<boolean>;
}): React.JSX.Element {
  return <section>
    <header className="pageHeader">
      <p className="eyebrow">SETTINGS</p>
      <h1>General</h1>
      <p>Core dictation behavior for the isolated Electron preview.</p>
    </header>
    <div className="card">
      <SettingRow title="Push-to-talk shortcut" description="Shortcut capture ports in a later milestone.">
        <span className="keycap">{settings.hotkey}</span>
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
    </div>
    <h2>Formatting</h2>
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
  </section>;
}

const PROVIDERS: readonly { id: SettingsProviderId; label: string }[] = [
  { id: "xai", label: "xAI" },
  { id: "openai", label: "OpenAI" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "local", label: "Local" },
];

function Providers({
  settings,
  update,
  localAction,
}: {
  settings: SettingsSnapshot;
  update: (patch: SettingsPatch) => Promise<boolean>;
  localAction: (kind: LocalEngineKind, action: LocalEngineAction) => Promise<boolean>;
}): React.JSX.Element {
  return <section>
    <header className="pageHeader">
      <p className="eyebrow">SETTINGS</p>
      <h1>Providers</h1>
      <p>Choose cloud services and store their credentials with Windows encryption.</p>
    </header>
    <h2>Services</h2>
    <div className="card">
      <SettingRow title="Transcription" description="Turns your speech into text.">
        <ProviderSelect
          label="Transcription provider"
          value={settings.provider}
          localAvailable={settings.localEngines.stt.installed}
          onChange={(provider) => { void update({ provider }); }}
        />
      </SettingRow>
      <SettingRow title="AI cleanup" description="Polishes the wording before it is pasted.">
        <ProviderSelect
          label="Cleanup provider"
          value={settings.cleanupProvider}
          localAvailable={settings.localEngines.cleanup.installed}
          onChange={(cleanupProvider) => { void update({ cleanupProvider }); }}
        />
      </SettingRow>
    </div>

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
    <h2>API keys</h2>
    <div className="providerGrid">
      <KeyCard
        provider="xai"
        name="xAI"
        configured={settings.keyConfigured.xai}
        update={update}
      />
      <KeyCard
        provider="openai"
        name="OpenAI"
        configured={settings.keyConfigured.openai}
        update={update}
      />
      <KeyCard
        provider="openrouter"
        name="OpenRouter"
        configured={settings.keyConfigured.openrouter}
        update={update}
      />
    </div>
    <p className="privacyNote">
      Saved keys are DPAPI-encrypted by the main process and are never returned to this page.
    </p>

    <h2>Model overrides</h2>
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
  </section>;
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

function About({ settings }: { settings: SettingsSnapshot }): React.JSX.Element {
  return <section>
    <header className="pageHeader">
      <p className="eyebrow">UNDERTONE</p>
      <h1>About</h1>
      <p>Push-to-talk dictation, transitioning to Electron and TypeScript.</p>
    </header>
    <div className="card aboutCard">
      <div className="aboutIcon" aria-hidden="true">U</div>
      <div>
        <h2>Undertone {settings.appVersion}</h2>
        <p>{settings.preview ? "Isolated Electron preview" : "Production channel"}</p>
      </div>
    </div>
    <div className="notice">
      The Python application remains the production reference while parity,
      upgrade, and rollback gates are still open.
    </div>
  </section>;
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
    hotkey: "right ctrl",
    appVersion: "1.3.0-electron.0",
    preview: true,
    provider: "xai",
    cleanupProvider: "xai",
    keyConfigured: { xai: false, openai: false, openrouter: false },
    sttModel: "",
    cleanupModel: "",
    localLoaded: false,
    localIdleMinutes: 0,
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
  };
}

const root = document.getElementById("root");
if (root === null) throw new Error("Settings root is missing");
createRoot(root).render(<SettingsApp />);
