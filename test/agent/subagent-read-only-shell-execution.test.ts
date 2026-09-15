import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeReadOnlyShell } from "../../src/agent/subagents/read-only-shell-execution.js";
import { spawnArgv } from "../../src/tools/shell/spawn-argv.js";

vi.mock("../../src/tools/shell/spawn-argv.js", () => ({ spawnArgv: vi.fn() }));

describe("read-only inspection execution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(spawnArgv).mockResolvedValue({ ok: true, exitCode: 0, output: "" });
  });

  it("validates the entire chain before starting even its first read", async () => {
    await expect(executeReadOnlyShell("cat a || rm a", "/workspace", 40_000, {})).rejects.toThrow(/denied/i);
    expect(spawnArgv).not.toHaveBeenCalled();
  });

  it("passes literal argv and only stdout between bounded stages", async () => {
    vi.mocked(spawnArgv)
      .mockImplementationOnce(async (args) => {
        args.onOutput?.("raw input\n", "stdout");
        args.onOutput?.("diagnostic\n", "stderr");
        return { ok: true, exitCode: 0, output: "$ cat a\nraw input" };
      })
      .mockImplementationOnce(async (args) => {
        args.onOutput?.("raw input\n", "stdout");
        return { ok: true, exitCode: 0, output: "$ head -n 1\nraw input" };
      });
    const result = await executeReadOnlyShell("cat '/workspace/a; literal' | head -n 1", "/workspace", 40_000, {});
    expect(spawnArgv).toHaveBeenNthCalledWith(1, expect.objectContaining({
      command: "cat", argv: ["/workspace/a; literal"], cwd: "/workspace", stdinText: "", noArtifact: true,
      interactiveStdin: false, onLimit: "terminate", maxCaptureBytes: 1_048_576,
    }));
    expect(spawnArgv).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: "head", argv: ["-n", "1"], stdinText: "raw input\n" }));
    expect(result).toMatchObject({ ok: true, output: "diagnostic\nraw input\n" });
  });

  it.each([0, 1])("applies conditional operators to pipelines using exit status %i", async (code) => {
    vi.mocked(spawnArgv).mockResolvedValueOnce({ ok: true, exitCode: code, output: "" });
    await executeReadOnlyShell("grep missing a && cat b | head -n 1 || cat c; cat d", "/workspace", 40_000, {});
    expect(vi.mocked(spawnArgv).mock.calls.map(([args]) => [args.command, ...args.argv])).toEqual(code === 0
      ? [["grep", "missing", "a"], ["cat", "b"], ["head", "-n", "1"], ["cat", "d"]]
      : [["grep", "missing", "a"], ["cat", "c"], ["cat", "d"]]);
  });

  it("does not feed a partial capture into the next pipeline command", async () => {
    vi.mocked(spawnArgv).mockResolvedValueOnce({
      ok: false, exitCode: 137, output: "Command exceeded capture cap.", truncated: true,
      stats: { bytesRead: 1_048_577, bytesDropped: 1, linesRead: 1, elapsedMs: 1, captureLimitHit: true },
    });
    const result = await executeReadOnlyShell("cat large | head -n 1; cat next", "/workspace", 40_000, {});
    expect(result.ok).toBe(false);
    expect(result.output).toContain("capture cap");
    expect(spawnArgv).toHaveBeenCalledOnce();
  });

  it("allows a read-only fallback when the preferred executable is unavailable", async () => {
    vi.mocked(spawnArgv).mockResolvedValueOnce({ ok: false, exitCode: 127, output: "rg was not found on PATH." });
    const result = await executeReadOnlyShell("rg answer a || grep answer a", "/workspace", 40_000, {});
    expect(spawnArgv).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("rg was not found");
  });

  it("retains benign no-match evidence while preserving the exit code", async () => {
    vi.mocked(spawnArgv).mockResolvedValueOnce({ ok: true, exitCode: 1, output: "[note: no matching lines]" });
    const result = await executeReadOnlyShell("grep missing a", "/workspace", 40_000, {});
    expect(result).toMatchObject({ ok: true, exitCode: 1, output: "[note: no matching lines]\n" });
  });

  it("disables Git lazy fetching, network transports and interactive prompts", async () => {
    await executeReadOnlyShell("git status --short", "/workspace", 40_000, {});
    expect(spawnArgv).toHaveBeenCalledWith(expect.objectContaining({
      env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" },
    }));
  });

  it.each([false, true])("isolates and removes sort spill files after failure=%s", async (fail) => {
    let directory = "";
    vi.mocked(spawnArgv).mockImplementationOnce(async (args) => {
      directory = args.env!.TMPDIR!;
      expect(args.env).toMatchObject({ TMP: directory, TEMP: directory });
      await writeFile(join(directory, "spill"), "temporary evidence");
      if (fail) throw new Error("interrupted sort");
      return { ok: true, exitCode: 0, output: "" };
    });
    const result = executeReadOnlyShell("sort input.txt", "/workspace", 40_000, {});
    if (fail) await expect(result).rejects.toThrow("interrupted sort");
    else expect((await result).ok).toBe(true);
    expect(directory).toContain("clai-inspection-sort-");
    await expect(access(directory)).rejects.toThrow();
  });

  it("uses one deadline for all commands", async () => {
    const clock = vi.spyOn(Date, "now");
    clock.mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValueOnce(40_100);
    try {
      const result = await executeReadOnlyShell("cat a; cat b", "/workspace", 40_000, {});
      expect(result.exitCode).toBe(124);
      expect(spawnArgv).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it("honors cancellation before and between commands", async () => {
    const controller = new AbortController();
    vi.mocked(spawnArgv).mockImplementationOnce(async () => {
      controller.abort(new Error("stop inspection"));
      return { ok: true, exitCode: 0, output: "" };
    });
    await expect(executeReadOnlyShell("cat a; cat b", "/workspace", 40_000, { signal: controller.signal })).rejects.toThrow("stop inspection");
    expect(spawnArgv).toHaveBeenCalledOnce();
    await expect(executeReadOnlyShell("cat a", "/workspace", 40_000, { signal: controller.signal })).rejects.toThrow("stop inspection");
    expect(spawnArgv).toHaveBeenCalledOnce();
  });

  it("bounds combined output across commands and reports incomplete coverage", async () => {
    vi.mocked(spawnArgv).mockImplementation(async (args) => {
      args.onOutput?.("x".repeat(8_000), "stdout");
      return { ok: true, exitCode: 0, output: "" };
    });
    const result = await executeReadOnlyShell("cat a; cat b", "/workspace", 40_000, {});
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(12_000);
    expect(result.output).toContain("Coverage is incomplete");
  });

  it("reports clipped stderr even when the final pipeline stage succeeds", async () => {
    vi.mocked(spawnArgv).mockImplementationOnce(async (args) => {
      args.onOutput?.("x".repeat(20_000), "stderr");
      return { ok: true, exitCode: 0, output: "", truncated: true };
    });
    const result = await executeReadOnlyShell("cat a | head -n 1", "/workspace", 40_000, {});
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(12_000);
    expect(result.output).toContain("Coverage is incomplete");
  });
});
