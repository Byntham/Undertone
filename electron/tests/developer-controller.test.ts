import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DeveloperController,
  parseWorktreeList,
  worktreeDisplayName,
} from "../src/main/developerController";

describe("developer controller", () => {
  it("parses branch and detached worktrees", () => {
    expect(parseWorktreeList([
      "worktree C:/Projects/Undertone",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree C:/Worktrees/live",
      "HEAD def456",
      "branch refs/heads/t3code/add-live-transcription",
      "",
      "worktree C:/Worktrees/detached",
      "HEAD 123456",
      "detached",
      "",
    ].join("\n"))).toEqual([
      { root: "C:/Projects/Undertone", branch: "main" },
      { root: "C:/Worktrees/live", branch: "t3code/add-live-transcription" },
      { root: "C:/Worktrees/detached", branch: "detached HEAD" },
    ]);
  });

  it("turns Git branches into readable worktree names", () => {
    expect(worktreeDisplayName("t3code/streamline-dev-build-testing"))
      .toBe("Streamline dev build testing");
    expect(worktreeDisplayName("dev/integration")).toBe("Integration");
    expect(worktreeDisplayName("main")).toBe("Main");
  });

  it.skipIf(process.env.UNDERTONE_DEVELOPER_E2E !== "1")(
    "builds, launches, and stops a managed worktree",
    async () => {
      const repositoryRoot = path.resolve(__dirname, "../..");
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData === undefined) throw new Error("LOCALAPPDATA is unavailable");
      const configPath = path.join(__dirname, "../test-output/developer-controller.json");
      let paused = false;
      const controller = new DeveloperController({
        configPath,
        buildRoot: path.join(localAppData, "Undertone", "DevBuilds"),
        onBeforeDevStart: async () => { paused = true; },
        onDevUnavailable: async () => { paused = false; },
        onStateChange: () => undefined,
      });
      try {
        await controller.setRepository(repositoryRoot);
        const worktree = (await controller.worktrees()).find(
          (item) => path.resolve(item.root).toLowerCase() === repositoryRoot.toLowerCase(),
        );
        if (worktree === undefined) throw new Error("Current worktree was not discovered");
        await controller.activate(worktree);
        expect(controller.snapshot().phase).toBe("dev");
        expect(controller.snapshot().activeWorktree?.branch).toBe(worktree.branch);
        expect(paused).toBe(true);
        await controller.returnToProduction();
        expect(controller.snapshot().phase).toBe("production");
        expect(paused).toBe(false);
      } finally {
        await controller.dispose();
        await rm(configPath, { force: true });
      }
    },
    60_000,
  );
});
