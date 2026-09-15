import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets } from "../../llm/provider.js";
import { spawnArgv, type SpawnArgvArgs } from "../../tools/shell/spawn-argv.js";
import type { ToolRunOptions } from "../../tools/tool-types.js";
import type { ToolResult } from "../../types.js";
import { parseReadOnlyShell } from "./read-only-shell.js";

const PIPE_LIMIT = 1_048_576;
const OUTPUT_LIMIT = 12_000;

async function spawnInspection(args: SpawnArgvArgs): Promise<ToolResult> {
  if (args.command !== "sort") return spawnArgv(args);
  const directory = await mkdtemp(join(tmpdir(), "clai-inspection-sort-"));
  try {
    return await spawnArgv({ ...args, env: { ...args.env, TMPDIR: directory, TMP: directory, TEMP: directory } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function finish(result: ToolResult): ToolResult {
  const output = redactSecrets(result.output);
  const suffix = "\n[Output truncated; narrow the query. Coverage is incomplete.]";
  const truncated = result.truncated || output.length > OUTPUT_LIMIT;
  return {
    ...result,
    output: truncated ? output.slice(0, OUTPUT_LIMIT - suffix.length) + suffix : output,
    truncated,
  };
}

export async function executeReadOnlyShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  options: ToolRunOptions,
): Promise<ToolResult> {
  const commands = parseReadOnlyShell(command);
  const deadline = Date.now() + timeoutMs;
  let output = "";
  let truncated = false;
  let exitCode = 0;
  let ok = true;
  let runPipeline = true;
  let stdin = "";
  for (let i = 0; i < commands.length; i++) {
    options.signal?.throwIfAborted();
    const step = commands[i]!;
    if (step.operator !== "|") {
      runPipeline = step.operator === "&&" ? exitCode === 0 : step.operator === "||" ? exitCode !== 0 : true;
      stdin = "";
    }
    if (!runPipeline) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return finish({ ok: false, exitCode: 124, output: `${output}\nCommand timed out.`, truncated });
    let stdout = "";
    let stderr = "";
    const result = await spawnInspection({
      command: step.argv[0]!,
      argv: step.argv.slice(1),
      cwd,
      timeoutMs: remaining,
      signal: options.signal,
      stdinText: stdin,
      noArtifact: true,
      interactiveStdin: false,
      ...(step.argv[0] === "git" ? { env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" } } : {}),
      maxModelBytes: OUTPUT_LIMIT,
      maxCaptureBytes: PIPE_LIMIT,
      onLimit: "terminate",
      onOutput: (chunk, stream) => {
        if (stream === "stdout") stdout += chunk.slice(0, Math.max(0, PIPE_LIMIT - stdout.length));
        else {
          if (stderr.length + chunk.length > OUTPUT_LIMIT) truncated = true;
          stderr += chunk.slice(0, Math.max(0, OUTPUT_LIMIT - stderr.length));
        }
      },
    });
    options.signal?.throwIfAborted();
    exitCode = result.exitCode ?? 1;
    ok = result.ok;
    const piping = commands[i + 1]?.operator === "|";
    const text = stderr + (piping ? "" : stdout) || (!result.ok || (!piping && exitCode !== 0) ? `${result.output}\n` : "");
    if (output.length + text.length > OUTPUT_LIMIT) truncated = true;
    output += text.slice(0, Math.max(0, OUTPUT_LIMIT - output.length));
    if (result.stats?.captureLimitHit || [124, 130, 137].includes(exitCode)) {
      const reason = result.stats?.captureLimitHit ? "Pipeline capture cap exceeded; remaining commands were not executed."
        : exitCode === 124 ? "Command timed out." : "Command terminated; remaining commands were not executed.";
      return finish({ ...result, ok: false, output: `${reason}\n${output}`, truncated: truncated || result.truncated });
    }
    stdin = piping ? stdout : "";
  }
  return finish({ ok, exitCode, output, truncated });
}
