import { lstat, opendir, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { TOOL_DEFINITIONS } from "../../tools/definitions.js";
import { globToPathRegExp } from "../../tools/fs/search.js";
import type { ToolRunOptions } from "../../tools/tool-types.js";
import type { ToolCall, ToolDefinition, ToolResult } from "../../types.js";
import { parseReadOnlyShell } from "./read-only-shell.js";
import { executeReadOnlyShell } from "./read-only-shell-execution.js";

export const TOOL_OUTPUT_LIMIT = 12_000;
const fields: Record<string, readonly string[]> = {
  "fs.read": ["path", "offset", "limit", "startLine", "endLine", "maxBytes"],
  "fs.list": ["path", "maxEntries"],
  "fs.search": ["path", "pattern", "glob", "maxMatches", "caseInsensitive", "fixedString", "hidden", "timeoutMs"],
  "web.search": ["query", "maxResults", "timeoutMs"],
  "web.fetch": ["url", "maxBytes", "timeoutMs", "responseMode", "responsePart"],
  "http.fetch": ["url", "maxBytes", "timeoutMs", "responseMode", "responsePart"],
  "pdf.read": ["path", "firstPage", "lastPage", "maxPages", "maxChars"],
  "image.view": ["path", "paths"],
  "image.ocr": ["path", "lang", "psm", "preprocess"],
  "sysinfo": [],
  "tool.check": ["tools"],
  "wordlist.find": ["query", "expand"],
  "skill.load": ["name"],
  "skill.list": ["query"],
  "shell.exec": ["command", "cwd", "timeoutMs"],
};

const descriptions: Record<string, string> = {
  "fs.read": "Read a text file by absolute path or relative to cwd, with numbered lines. At most 300 lines and 12000 characters per call. Files over 2 MiB need parent inspection.",
  "fs.list": "List directory entries by absolute path or relative to cwd.",
  "fs.search": "Bounded content search by absolute path or relative to cwd returning matching file paths only. Skips symlinks, generated directories, and files over 1 MB; scans at most 64 files.",
  "web.search": "Search the web for current information.",
  "web.fetch": "Fetch a public URL as readable text.",
  "http.fetch": "GET-only HTTP evidence for public targets. Mutating or authenticated requests are denied.",
  "pdf.read": "Extract text from a PDF by absolute path or relative to cwd with bounded paging.",
  "image.view": "View image bytes by absolute path or relative to cwd.",
  "image.ocr": "OCR text from an image by absolute path or relative to cwd.",
  "sysinfo": "OS and environment facts.",
  "tool.check": "Check tool availability on PATH.",
  "wordlist.find": "Locate wordlists on disk.",
  "skill.load": "Read one skill's instructions.",
  "skill.list": "List installed skills.",
  "shell.exec": "Read-only inspection with absolute or relative paths and optional cwd. Supports pipelines and multiple commands separated by semicolons, newlines, && or ||. Every command is validated before execution. Use literal arguments; writes, redirects, expansions, background jobs, interpreters and installs are denied.",
};

export const READ_ONLY_TOOLS: ToolDefinition[] = TOOL_DEFINITIONS
  .filter((tool) => Object.hasOwn(fields, tool.name))
  .map((tool) => ({
    ...tool,
    description: descriptions[tool.name] ?? tool.description,
    parameters: {
      ...tool.parameters,
      properties: Object.fromEntries(Object.entries(tool.parameters.properties)
        .filter(([key]) => fields[tool.name]!.includes(key))
        .map(([key, schema]) => {
          const { description: _dropped, ...rest } = schema as Record<string, unknown>;
          return [key, rest];
        })),
      additionalProperties: false,
    },
  }));

export function boundedOutput(text: string): string {
  const suffix = "\n[Output truncated; narrow the query or page the file. Coverage is incomplete.]";
  return text.length > TOOL_OUTPUT_LIMIT
    ? text.slice(0, TOOL_OUTPUT_LIMIT - suffix.length) + suffix
    : text;
}

async function resolveReadPath(root: string, value: unknown = "."): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value !== value.trim()) {
    throw new Error("Invalid path");
  }
  return realpath(resolve(await realpath(root), value));
}

function number(args: Record<string, unknown>, key: string, fallback: number, max: number, min = 1): number {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`Invalid ${key}`);
  }
  return Math.min(value, max);
}

function string(args: Record<string, unknown>, key: string, max = 2048): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string, max = 2048): string | undefined {
  if (args[key] === undefined) return undefined;
  return string(args, key, max);
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== "boolean") throw new Error(`Invalid ${key}`);
  return args[key];
}

function optionalNumber(args: Record<string, unknown>, key: string, max: number, min = 1): number | undefined {
  if (args[key] === undefined) return undefined;
  return number({ ...args, [key]: args[key] }, key, args[key] as number, max, min);
}

function optionalEnum(args: Record<string, unknown>, key: string, allowed: readonly string[]): string | undefined {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== "string" || !allowed.includes(args[key])) throw new Error(`Invalid ${key}`);
  return args[key];
}

function stringList(value: unknown, key: string, min: number, max: number, itemMax = 2048): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid ${key}`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > itemMax || entry.includes("\0")) throw new Error(`Invalid ${key}`);
    return entry;
  });
}

async function prepareShellExec(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const command = string(args, "command", 16_000);
  parseReadOnlyShell(command);
  const cwd = await resolveReadPath(root, args.cwd);
  if (!(await lstat(cwd)).isDirectory()) throw new Error("cwd must be a directory");
  return { command, cwd, timeoutMs: number(args, "timeoutMs", 40_000, 1_800_000), background: "never" };
}

function publicUrl(value: unknown, maxBytesFallback: number): { url: string; maxBytes: number; timeoutMs: number } {
  const href = new URL(string({ url: value }, "url", 4096)).href;
  const parsed = new URL(href);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Only public HTTP(S) web URLs without credentials are allowed");
  return { url: parsed.href, maxBytes: maxBytesFallback, timeoutMs: 15_000 };
}

async function prepareFsRead(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (args.path === undefined) throw new Error("fs.read requires path");
  const path = await resolveReadPath(root, args.path);
  const offset = number(args, "offset", number(args, "startLine", 1, 10_000_000), 10_000_000, 0) || 1;
  const limit = number(args, "limit", 200, 300);
  const end = number(args, "endLine", offset + limit - 1, 10_000_300);
  if (end < offset) throw new Error("endLine precedes offset");
  return { path, offset, limit: Math.min(limit, end - offset + 1), maxBytes: number(args, "maxBytes", TOOL_OUTPUT_LIMIT, TOOL_OUTPUT_LIMIT) };
}

async function prepareFsList(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { path: await resolveReadPath(root, args.path), maxEntries: number(args, "maxEntries", 100, 200) };
}

async function prepareFsSearch(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const safe: Record<string, unknown> = {
    path: await resolveReadPath(root, args.path), pattern: string(args, "pattern"),
    maxMatches: number(args, "maxMatches", 30, 100),
    maxPerFile: 1, context: 0, filesOnly: true,
    timeoutMs: number(args, "timeoutMs", 2000, 2000),
  };
  for (const key of ["caseInsensitive", "fixedString", "hidden"]) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error(`Invalid ${key}`);
    safe[key] = args[key] ?? false;
  }
  if (args.glob !== undefined) safe.glob = string(args, "glob", 256);
  return safe;
}

function prepareWebSearch(args: Record<string, unknown>): Record<string, unknown> {
  return { query: string(args, "query"), maxResults: number(args, "maxResults", 5, 5), timeoutMs: number(args, "timeoutMs", 15_000, 30_000) };
}

function prepareWebFetch(args: Record<string, unknown>): Record<string, unknown> {
  const base = publicUrl(args.url, number(args, "maxBytes", 65_536, 65_536));
  base.timeoutMs = number(args, "timeoutMs", 15_000, 30_000);
  const safe: Record<string, unknown> = { url: base.url, maxBytes: base.maxBytes, timeoutMs: base.timeoutMs };
  const mode = optionalEnum(args, "responseMode", ["readable", "raw"]);
  if (mode !== undefined) safe.responseMode = mode;
  const part = optionalEnum(args, "responsePart", ["full", "headers", "body"]);
  if (part !== undefined) safe.responsePart = part;
  return safe;
}

function prepareHttpFetch(args: Record<string, unknown>): Record<string, unknown> {
  return prepareWebFetch(args);
}

async function preparePdfRead(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const safe: Record<string, unknown> = { path: await resolveReadPath(root, args.path) };
  const first = optionalNumber(args, "firstPage", 500, 1);
  if (first !== undefined) safe.firstPage = first;
  const last = optionalNumber(args, "lastPage", 500, 1);
  if (last !== undefined) safe.lastPage = last;
  const pages = optionalNumber(args, "maxPages", 50, 1);
  if (pages !== undefined) safe.maxPages = pages;
  else safe.maxPages = 50;
  const chars = optionalNumber(args, "maxChars", 50_000, 1000);
  if (chars !== undefined) safe.maxChars = chars;
  if (safe.firstPage !== undefined && safe.lastPage !== undefined && (safe.lastPage as number) < (safe.firstPage as number)) throw new Error("lastPage precedes firstPage");
  return safe;
}

async function prepareImageView(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hasPath = args.path !== undefined;
  const hasPaths = args.paths !== undefined;
  if (!hasPath && !hasPaths) throw new Error("image.view requires path or paths");
  const safe: Record<string, unknown> = {};
  if (hasPath) safe.path = await resolveReadPath(root, args.path);
  if (hasPaths) {
    const paths = stringList(args.paths, "paths", 1, 4, 4096);
    safe.paths = await Promise.all(paths.map((entry) => resolveReadPath(root, entry)));
  }
  return safe;
}

async function prepareImageOcr(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const safe: Record<string, unknown> = { path: await resolveReadPath(root, args.path) };
  const lang = optionalString(args, "lang", 64);
  if (lang !== undefined) safe.lang = lang;
  const psm = optionalNumber(args, "psm", 13, 0);
  if (psm !== undefined) safe.psm = psm;
  const preprocess = optionalBoolean(args, "preprocess");
  if (preprocess !== undefined) safe.preprocess = preprocess;
  return safe;
}

function prepareToolCheck(args: Record<string, unknown>): Record<string, unknown> {
  return { tools: stringList(args.tools, "tools", 1, 20, 256) };
}

function prepareWordlistFind(args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = { query: string(args, "query") };
  const expand = optionalBoolean(args, "expand");
  if (expand !== undefined) safe.expand = expand;
  return safe;
}

function prepareSkillLoad(args: Record<string, unknown>): Record<string, unknown> {
  return { name: string(args, "name", 256) };
}

function prepareSkillList(args: Record<string, unknown>): Record<string, unknown> {
  const query = optionalString(args, "query", 256);
  return query === undefined ? {} : { query };
}

async function normalizeReadOnlyCall(root: string, call: ToolCall): Promise<ToolCall> {
  const allowed = fields[call.name];
  if (!Object.hasOwn(fields, call.name) || !allowed) throw new Error(`Tool denied: ${call.name}`);
  if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) throw new Error("Invalid tool arguments");
  for (const key of Object.keys(call.args)) {
    if (!allowed.includes(key)) throw new Error(`Argument denied: ${call.name}.${key}`);
  }
  const args = call.args;
  switch (call.name) {
    case "fs.read": return { name: call.name, args: await prepareFsRead(root, args) };
    case "fs.list": return { name: call.name, args: await prepareFsList(root, args) };
    case "fs.search": return { name: call.name, args: await prepareFsSearch(root, args) };
    case "web.search": return { name: call.name, args: prepareWebSearch(args) };
    case "web.fetch": return { name: call.name, args: prepareWebFetch(args) };
    case "http.fetch": return { name: call.name, args: prepareHttpFetch(args) };
    case "pdf.read": return { name: call.name, args: await preparePdfRead(root, args) };
    case "image.view": return { name: call.name, args: await prepareImageView(root, args) };
    case "image.ocr": return { name: call.name, args: await prepareImageOcr(root, args) };
    case "sysinfo": return { name: call.name, args: {} };
    case "tool.check": return { name: call.name, args: prepareToolCheck(args) };
    case "wordlist.find": return { name: call.name, args: prepareWordlistFind(args) };
    case "skill.load": return { name: call.name, args: prepareSkillLoad(args) };
    case "skill.list": return { name: call.name, args: prepareSkillList(args) };
    case "shell.exec": return { name: call.name, args: await prepareShellExec(root, args) };
    default: throw new Error(`Tool denied: ${call.name}`);
  }
}

const preparedCalls = new WeakMap<ToolCall, ToolCall>();

export async function prepareReadOnlyCall(root: string, call: ToolCall): Promise<ToolCall> {
  const original = structuredClone(preparedCalls.get(call) ?? call);
  const prepared = await normalizeReadOnlyCall(root, original);
  preparedCalls.set(prepared, original);
  return prepared;
}

export type ReadOnlyRegistry = (call: ToolCall, options: ToolRunOptions) => Promise<ToolResult>;
const excluded = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", "coverage", ".next", ".venv", "__pycache__"]);

export async function executeReadOnlyCall(root: string, call: ToolCall, execute: ReadOnlyRegistry, options: ToolRunOptions): Promise<ToolResult> {
  options.signal?.throwIfAborted();
  call = await normalizeReadOnlyCall(root, preparedCalls.get(call) ?? call);
  if (call.name === "shell.exec") {
    const result = await executeReadOnlyShell(String(call.args.command), String(call.args.cwd), Number(call.args.timeoutMs), options);
    return { ...result, output: boundedOutput(result.output) };
  }
  if (call.name !== "fs.search") {
    const safe = call;
    if (safe.name === "fs.read") {
      const stat = await lstat(String(safe.args.path));
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("Only regular files and directories are readable");
      if (stat.isFile() && stat.size > 2 * 1024 * 1024) {
        throw new Error("File exceeds the child 2 MiB read limit; report this coverage gap for parent inspection");
      }
    }
    options.signal?.throwIfAborted();
    const result = await execute(safe, options);
    options.signal?.throwIfAborted();
    return { ...result, output: boundedOutput(result.output) };
  }
  const files: string[] = [];
  const gaps = new Set<string>(["Symlinks, generated directories and files over 1 MB are excluded."]);
  let entries = 0;
  const glob = typeof call.args.glob === "string" ? call.args.glob : undefined;
  const matcher = glob ? globToPathRegExp(glob.startsWith("!") ? glob.slice(1) : glob) : undefined;
  if (glob && !matcher) throw new Error("Invalid search glob");
  const start = String(call.args.path);
  const collect = async (path: string, depth: number): Promise<void> => {
    options.signal?.throwIfAborted();
    if (entries >= 2048 || files.length >= 64 || depth > 16) {
      gaps.add("Search traversal limit reached; narrow path/glob for remaining coverage.");
      return;
    }
    entries += 1;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      const rel = relative(start, path) || relative(root, path);
      if (stat.size <= 1_048_576 && (!matcher || matcher.test(rel) !== glob!.startsWith("!"))) files.push(path);
    } else if (stat.isDirectory()) {
      const dir = await opendir(path);
      for await (const entry of dir) {
        options.signal?.throwIfAborted();
        if (entries >= 2048 || files.length >= 64) {
          gaps.add("Search traversal limit reached; narrow path/glob for remaining coverage.");
          break;
        }
        entries += 1;
        if (entry.isSymbolicLink()) continue;
        if (excluded.has(entry.name) || (!call.args.hidden && entry.name.startsWith("."))) continue;
        await collect(resolve(path, entry.name), depth + 1);
      }
    }
  };
  await collect(start, 0);
  let output = "";
  let ok = true;
  let scanned = 0;
  let matched = 0;
  for (const file of files) {
    options.signal?.throwIfAborted();
    const path = await resolveReadPath(root, file);
    if (!(await lstat(path)).isFile()) throw new Error("Search target is no longer a regular file");
    options.signal?.throwIfAborted();
    const { glob: _glob, ...args } = call.args;
    const result = await execute({ name: call.name, args: { ...args, path } }, options);
    options.signal?.throwIfAborted();
    scanned += 1;
    ok = ok && result.ok;
    if (!result.ok || !/^# no matches$/m.test(result.output)) {
      output += `${result.output}\n`;
      if (result.ok) matched += 1;
    }
    if (matched >= Number(call.args.maxMatches)) {
      gaps.add("Match limit reached; remaining files were not searched.");
      break;
    }
    if (output.length >= TOOL_OUTPUT_LIMIT - 1000) {
      gaps.add("Search output limit reached; remaining files were not searched.");
      break;
    }
  }
  return { ok, output: boundedOutput(`Scanned ${scanned} files; ${matched} matching paths. Use fs.read for numbered evidence. Coverage gaps: ${[...gaps].join(" ")}\n${output || "No matches in the scanned files."}`) };
}
