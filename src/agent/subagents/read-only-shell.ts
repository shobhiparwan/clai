type Operator = ";" | "&&" | "||" | "|" | "\n";
type ExecutionOperator = Exclude<Operator, "\n">;

type Word = {
  value: string;
  hasUnquotedWildcard: boolean;
};

type Token = Word | Operator;
type ParsedCommand = {
  argv: string[];
  operator?: Operator;
};

type QuoteMode = "single" | "double" | undefined;
type EscapeMode = "outside" | "double" | undefined;

const commands = new Set([
  "pwd", "printf", "echo", "cat", "ls", "grep", "rg", "find", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "file", "stat", "du", "git", "jq", "diff", "cmp", "comm", "strings", "xxd", "od",
]);
const gitCommands = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "cat-file", "describe", "grep", "blame"]);
const gitInspectionConfig = [
  "core.fsmonitor=false", "core.hooksPath=/dev/null", "core.pager=cat",
  "diff.external=", "diff.trustExitCode=false", "log.showSignature=false", "format.pretty=medium",
  "gpg.program=false", "gpg.openpgp.program=false", "gpg.x509.program=false", "gpg.ssh.program=false",
  "gpg.ssh.allowedSignersCommand=",
];
const xxdFlags = new Set(["-a", "-b", "-e", "-i", "-p", "-ps", "-r", "-u", "--autoskip", "--bits", "--capitalize", "--little-endian", "--include", "--plain", "--revert", "--postscript", "--version"]);
const xxdValueOptions = new Set(["-c", "-g", "-l", "-s", "-o", "--cols", "--groupsize", "--length", "--seek", "--offset"]);
const uniqFlags = new Set(["-c", "-d", "-D", "-i", "-u", "-z", "--count", "--repeated", "--ignore-case", "--unique", "--zero-terminated"]);
const uniqValueOptions = new Set(["-f", "-s", "-w", "--all-repeated", "--check-chars", "--skip-fields", "--skip-chars", "--group"]);
const uniqRequiredValueOptions = new Set(["-f", "-s", "-w", "--check-chars", "--skip-fields", "--skip-chars"]);

function denied(reason: string): never {
  throw new Error(`Read-only shell command denied: ${reason}`);
}

function isOperator(token: Token): token is Operator {
  return typeof token === "string";
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tokenize(command: string): Token[] {
  const result: Token[] = [];
  let value = "";
  let hasUnquotedWildcard = false;
  let wordStarted = false;
  let quoteMode: QuoteMode;
  let escapeMode: EscapeMode;

  const pushWord = (): void => {
    if (!wordStarted) return;
    result.push({ value, hasUnquotedWildcard });
    value = "";
    hasUnquotedWildcard = false;
    wordStarted = false;
  };
  const pushOperator = (operator: Operator): void => {
    pushWord();
    result.push(operator);
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\0" || char === "\r" || (char < " " && char !== "\t" && char !== "\n")) {
      denied("control characters are not allowed");
    }
    if (escapeMode) {
      if (char === "\n") denied("line continuations are not allowed");
      if (escapeMode === "double" && !["$", "`", '"', "\\"].includes(char)) value += "\\";
      value += char;
      wordStarted = true;
      escapeMode = undefined;
      continue;
    }
    if (quoteMode === "single") {
      if (char === "'") quoteMode = undefined;
      else value += char;
      wordStarted = true;
      continue;
    }
    if (quoteMode === "double") {
      if (char === '"') quoteMode = undefined;
      else if (char === "\\") escapeMode = "double";
      else if (char === "$" || char === "`") denied("expansions and substitutions are not allowed");
      else value += char;
      wordStarted = true;
      continue;
    }
    if (char === "'") {
      quoteMode = "single";
      wordStarted = true;
      continue;
    }
    if (char === '"') {
      quoteMode = "double";
      wordStarted = true;
      continue;
    }
    if (char === "\\") {
      escapeMode = "outside";
      wordStarted = true;
      continue;
    }
    if (char === "$" || char === "`") denied("expansions and substitutions are not allowed");
    if (char === ">" || char === "<") denied("redirections and heredocs are not allowed");
    if (char === "(" || char === ")" || char === "{" || char === "}") denied("shell groups are not allowed");
    if (char === "&") {
      if (command[index + 1] !== "&") denied("background commands are not allowed");
      pushOperator("&&");
      index += 1;
      continue;
    }
    if (char === "|") {
      if (command[index + 1] === "|") {
        pushOperator("||");
        index += 1;
      } else {
        pushOperator("|");
      }
      continue;
    }
    if (char === ";" || char === "\n") {
      pushOperator(char);
      continue;
    }
    if (char === " " || char === "\t") {
      pushWord();
      continue;
    }
    if (char === "*" || char === "?" || char === "[" || char === "]") hasUnquotedWildcard = true;
    value += char;
    wordStarted = true;
  }
  if (escapeMode || quoteMode) denied("malformed quoted literal");
  pushWord();
  return result;
}

function shellAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function optionName(value: string): string {
  const equals = value.indexOf("=");
  return equals === -1 ? value : value.slice(0, equals);
}

function matchesLongOption(value: string, unsafe: readonly string[]): boolean {
  if (!value.startsWith("--") || value === "--") return false;
  const name = optionName(value);
  return unsafe.some((option) => option.startsWith(name) || name.startsWith(option));
}

function optionWords(words: readonly Word[]): readonly Word[] {
  const end = words.findIndex((word) => word.value === "--");
  return end < 0 ? words : words.slice(0, end);
}

function matchingLongOption(value: string, options: ReadonlySet<string>): string | undefined {
  if (!value.startsWith("--")) return undefined;
  const name = optionName(value);
  const matches = [...options].filter((option) => option.startsWith(name) || name.startsWith(option));
  return matches.length === 1 ? matches[0] : undefined;
}

function validateSort(words: readonly Word[]): void {
  for (const { value } of optionWords(words.slice(1))) {
    if (matchesLongOption(value, ["--output", "--temporary-directory", "--compress-program"])) {
      denied("sort output or temporary-file options are not allowed");
    }
    if (value.startsWith("-") && !value.startsWith("--") && /[oT]/.test(value.slice(1))) {
      denied("sort output or temporary-file options are not allowed");
    }
  }
}

function validateRg(words: readonly Word[]): void {
  for (const { value } of optionWords(words.slice(1))) {
    if (matchesLongOption(value, ["--pre", "--pre-glob", "--config", "--hostname-bin"])) {
      denied("rg preprocessors and configuration are not allowed");
    }
  }
}

function validateFind(words: readonly Word[]): void {
  const unsafe = ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"];
  for (const { value } of words.slice(1)) {
    if (unsafe.some((option) => option.startsWith(value) || value.startsWith(option))) {
      denied("find actions that execute or write files are not allowed");
    }
  }
}

function validateUniq(words: readonly Word[]): void {
  let operands = 0;
  let options = true;
  for (let index = 1; index < words.length; index += 1) {
    const value = words[index]!.value;
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (!options || !value.startsWith("-") || value === "-") {
      operands += 1;
      options = false;
      continue;
    }
    if (uniqFlags.has(value)) continue;
    const long = matchingLongOption(value, uniqValueOptions);
    if (long) {
      if (!value.includes("=") && uniqRequiredValueOptions.has(long)) {
        if (!words[index + 1]) denied("uniq option needs a value");
        index += 1;
      }
      continue;
    }
    if (value.startsWith("--")) denied("uniq option is not allowed");
    const short = value.slice(0, 2);
    if (uniqRequiredValueOptions.has(short)) {
      if (value.length === 2) {
        if (!words[index + 1]) denied("uniq option needs a value");
        index += 1;
      }
      continue;
    }
    if ([...value.slice(1)].every((flag) => uniqFlags.has(`-${flag}`))) continue;
    denied("uniq option is not allowed");
  }
  if (operands > 1) denied("uniq output-file operands are not allowed");
}

function validateXxd(words: readonly Word[]): void {
  let operands = 0;
  let options = true;
  for (let index = 1; index < words.length; index += 1) {
    const value = words[index]!.value;
    if (options && value === "--") {
      options = false;
      continue;
    }
    if (!options || !value.startsWith("-") || value === "-") {
      operands += 1;
      options = false;
      continue;
    }
    const name = value.startsWith("--") ? optionName(value) : value.slice(0, 2);
    if (xxdFlags.has(value) || xxdFlags.has(name)) continue;
    if (xxdValueOptions.has(name)) {
      if (value === name) {
        if (!words[index + 1]) denied("xxd option needs a value");
        index += 1;
      }
      continue;
    }
    denied("xxd option is not allowed");
  }
  if (operands > 1) denied("xxd output-file operands are not allowed");
}

function validateFile(words: readonly Word[]): void {
  for (const { value } of optionWords(words.slice(1))) {
    if ((value.startsWith("-") && !value.startsWith("--") && /[CzZ]/.test(value.slice(1))) || matchesLongOption(value, ["--compile", "--uncompress"])) {
      denied("file magic compilation and external decompressors are not allowed");
    }
  }
}

function validateGit(words: readonly Word[]): Word[] {
  let index = 1;
  while (words[index]?.value === "-C") {
    const directory = words[index + 1]?.value;
    if (!directory) denied("git -C requires a path");
    index += 2;
  }
  if (words[index]?.value?.startsWith("-")) denied("git global options are not allowed");
  const subcommand = words[index]?.value;
  if (!subcommand || !gitCommands.has(subcommand)) denied("git subcommand is not read-only");
  const arguments_ = optionWords(words.slice(index + 1)).map(({ value }) => value);
  if (arguments_.some((value) => value === "-c" || value.startsWith("-c") || matchesLongOption(value, ["--config", "--config-env", "--exec-path"]))) {
    denied("git configuration overrides are not allowed");
  }
  if (arguments_.some((value) => value.includes("%G") || matchesLongOption(value, ["--ext-diff", "--textconv", "--filters", "--output", "--paginate", "--show-signature"]))) {
    denied("git external diff and output options are not allowed");
  }
  if (subcommand === "grep" && arguments_.some((value) => /^-[^-]*O/.test(value) || matchesLongOption(value, ["--open-files-in-pager"]))) {
    denied("git grep pager options are not allowed");
  }
  const prefix: Word[] = ["git", "--no-pager", "--no-optional-locks", ...gitInspectionConfig.flatMap((setting) => ["-c", setting])]
    .map((value) => ({ value, hasUnquotedWildcard: false }));
  const output = [...prefix, ...words.slice(1, index + 1)];
  if (subcommand === "diff" || subcommand === "show" || subcommand === "log") {
    output.push({ value: "--no-ext-diff", hasUnquotedWildcard: false }, { value: "--no-textconv", hasUnquotedWildcard: false });
  }
  output.push(...words.slice(index + 1));
  return output;
}

function validateStage(stage: readonly Word[]): string[] {
  if (!stage.length) denied("an empty command stage is not allowed");
  if (shellAssignment(stage[0]!.value)) denied("shell assignments are not allowed");
  for (const word of stage) {
    if (word.hasUnquotedWildcard) denied("wildcard expansion is not allowed");
  }
  const command = stage[0]!.value;
  if (!commands.has(command)) denied(`command ${command} is not allowed`);
  if (command === "sort") validateSort(stage);
  if (command === "rg") validateRg(stage);
  if (command === "find") validateFind(stage);
  if (command === "uniq") validateUniq(stage);
  if (command === "xxd") validateXxd(stage);
  if (command === "file") validateFile(stage);
  const words = command === "git" ? validateGit(stage) : [...stage];
  if (command === "rg") words.splice(1, 0, { value: "--no-config", hasUnquotedWildcard: false });
  return words.map(({ value }) => value);
}

function parse(command: string): ParsedCommand[] {
  if (!command.trim()) denied("command is empty");
  const parsed = tokenize(command);
  const result: ParsedCommand[] = [];
  let stage: Word[] = [];
  let operator: Operator | undefined;

  const finishStage = (): void => {
    result.push({ argv: validateStage(stage), ...(operator === undefined ? {} : { operator }) });
    stage = [];
    operator = undefined;
  };

  for (const token of parsed) {
    if (!isOperator(token)) {
      stage.push(token);
      continue;
    }
    if (token === "\n" && !stage.length && (operator !== undefined || result.length === 0)) {
      continue;
    }
    if (!stage.length) denied("an empty command stage is not allowed");
    finishStage();
    operator = token;
  }
  if (stage.length) finishStage();
  else if (operator === "&&" || operator === "||" || operator === "|") denied("command cannot end with a conditional or pipeline");
  if (!result.length) denied("command is empty");
  return result;
}

export function parseReadOnlyShell(command: string): { argv: string[]; operator?: ExecutionOperator }[] {
  return parse(command).map(({ argv, operator }) => ({ argv, ...(operator && { operator: operator === "\n" ? ";" : operator }) }));
}

export function prepareReadOnlyShell(command: string): string {
  return parse(command)
    .map(({ argv, operator }, index) => `${index ? `${operator === "\n" ? "\n" : ` ${operator} `}` : ""}${argv.map(quote).join(" ")}`)
    .join("");
}
