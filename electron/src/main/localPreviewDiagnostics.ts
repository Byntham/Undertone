import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  LOCAL_PREVIEW_DIAGNOSTIC_PARAMETERS,
  type LocalPreviewDiagnosticEvent,
} from "../core/localLiveTranscriber";

const FORMAT_VERSION = 1;
const MAX_SAVED_SESSIONS = 10;
const SESSION_PREFIX = "preview-";

export interface LocalPreviewDiagnosticBundle {
  captureId: number;
  createdAt: string;
  appVersion: string;
  language: string;
  model: string;
  wav: Uint8Array;
  previewAtStop: string;
  finalTranscript: string | null;
  events: readonly LocalPreviewDiagnosticEvent[];
}

export async function saveLocalPreviewDiagnostic(
  root: string,
  bundle: LocalPreviewDiagnosticBundle,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const directory = path.join(
    root,
    `${SESSION_PREFIX}${fileTimestamp(bundle.createdAt)}-${bundle.captureId}`,
  );
  await mkdir(directory, { recursive: false });
  const trace = {
    formatVersion: FORMAT_VERSION,
    createdAt: bundle.createdAt,
    captureId: bundle.captureId,
    appVersion: bundle.appVersion,
    language: bundle.language,
    model: bundle.model,
    previewParameters: LOCAL_PREVIEW_DIAGNOSTIC_PARAMETERS,
    audioFile: "audio.wav",
    previewAtStop: bundle.previewAtStop,
    finalTranscript: bundle.finalTranscript,
    events: bundle.events,
  };
  await Promise.all([
    writeFile(path.join(directory, "audio.wav"), bundle.wav),
    writeFile(path.join(directory, "trace.json"), `${JSON.stringify(trace, null, 2)}\n`, "utf8"),
    writeFile(
      path.join(directory, "README.txt"),
      "This folder contains microphone audio and transcription text. Review it before sharing.\r\n",
      "utf8",
    ),
  ]);
  await pruneOldSessions(root, directory);
  return directory;
}

export async function ensureLocalPreviewDiagnosticFolder(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
}

async function pruneOldSessions(root: string, newest: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const sessions = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(SESSION_PREFIX))
    .map((entry) => path.join(root, entry.name))
    .sort();
  const removeCount = Math.max(0, sessions.length - MAX_SAVED_SESSIONS);
  await Promise.all(sessions.slice(0, removeCount)
    .filter((directory) => directory !== newest)
    .map(async (directory) => await rm(directory, { recursive: true, force: true })));
}

function fileTimestamp(value: string): string {
  const parsed = new Date(value);
  const timestamp = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return timestamp.toISOString().replace(/[:.]/gu, "-");
}
