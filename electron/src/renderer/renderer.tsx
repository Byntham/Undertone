import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import type { SettingsPatch, SettingsSnapshot } from "../shared/settings";
import "./style.css";

type Section = "general" | "about";
const settingsApi = settingsApiForRenderer();

function SettingsApp(): React.JSX.Element {
  const [section, setSection] = useState<Section>("general");
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void settingsApi.load()
      .then(setSettings)
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, []);

  const update = async (patch: SettingsPatch): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await settingsApi.update(patch));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
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
  update: (patch: SettingsPatch) => Promise<void>;
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
  };
  return {
    async load() { return preview; },
    async update(patch) {
      preview = { ...preview, ...patch };
      return preview;
    },
  };
}

const root = document.getElementById("root");
if (root === null) throw new Error("Settings root is missing");
createRoot(root).render(<SettingsApp />);
