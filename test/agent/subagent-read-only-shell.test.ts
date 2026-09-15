import { describe, expect, it } from "vitest";
import { parseReadOnlyShell, prepareReadOnlyShell } from "../../src/agent/subagents/read-only-shell.js";

function expectDenied(...commands: readonly string[]): void {
  for (const command of commands) expect(() => parseReadOnlyShell(command)).toThrow(/denied|malformed/i);
}

describe("read-only shell parser", () => {
  it("returns validated argv arrays with operators attached to the following command", () => {
    expect(parseReadOnlyShell("cat /tmp/input | grep needle &&\n rg result ../project || echo missing; pwd")).toEqual([
      { argv: ["cat", "/tmp/input"] },
      { argv: ["grep", "needle"], operator: "|" },
      { argv: ["rg", "--no-config", "result", "../project"], operator: "&&" },
      { argv: ["echo", "missing"], operator: "||" },
      { argv: ["pwd"], operator: ";" },
    ]);
  });

  it("canonicalizes literal arguments without restricting explicit paths", () => {
    expect(prepareReadOnlyShell("grep -rn \"a; b\" /tmp/project | head -20 && printf '%s' foo\\|bar")).toBe("'grep' '-rn' 'a; b' '/tmp/project' | 'head' '-20' && 'printf' '%s' 'foo|bar'");
    expect(prepareReadOnlyShell("pwd\nls ../project\necho '' '~' '$literal'")).toBe("'pwd'\n'ls' '../project'\n'echo' '' '~' '$literal'");
    expect(prepareReadOnlyShell("cat /var/log/system.log; cat ~/notes.txt || echo \"not found\"")).toBe("'cat' '/var/log/system.log' ; 'cat' '~/notes.txt' || 'echo' 'not found'");
  });

  it("preserves quoted and escaped shell syntax as literal arguments", () => {
    expect(parseReadOnlyShell("echo a\\;b a\\&b a\\$b \\* '$HOME' \"a\\q\" '(literal)'")).toEqual([
      { argv: ["echo", "a;b", "a&b", "a$b", "*", "$HOME", "a\\q", "(literal)"] },
    ]);
    expect(prepareReadOnlyShell("find /tmp -name '*.ts' | sort | uniq")).toBe("'find' '/tmp' '-name' '*.ts' | 'sort' | 'uniq'");
  });

  it("validates unselected conditional branches before any dispatch", () => {
    expectDenied("echo safe && rm -rf /tmp/nope", "echo safe || python3 -c pass", "cat one | node -e process.exit()", "echo safe &&\n rm target");
  });

  it("rejects shell grammar that could be reinterpreted after dispatch", () => {
    expectDenied(
      "echo $HOME",
      "echo \"$HOME\"",
      "echo $(id)",
      "echo `id`",
      "echo > output",
      "cat input <<EOF",
      "echo done &",
      "(cat input)",
      "{ cat input; }",
      "NAME=value cat input",
      "echo *.ts",
      "echo ?",
      "echo [abc]",
      "echo 'unterminated",
      "echo \\",
      "echo ok &&",
      "cat input |",
      "echo ok; ; cat input",
    );
  });

  it("permits assignment-shaped arguments but rejects writing and execution options", () => {
    expect(parseReadOnlyShell("echo FOO=bar")).toEqual([{ argv: ["echo", "FOO=bar"] }]);
    expectDenied(
      "sort -o result.txt input.txt",
      "sort -noresult.txt input.txt",
      "sort --out=result.txt input.txt",
      "sort --temporary-directory=/tmp input.txt",
      "sort --compress-program=sh input.txt",
      "uniq input.txt output.txt",
      "uniq --all-repeated input.txt output.txt",
      "xxd input.bin output.txt",
      "xxd input.bin -p",
      "xxd input.bin -s 1",
      "uniq input.txt -f 2",
      "file -C magic",
      "file --comp magic",
      "file -z compressed.gz",
      "rg --pre=cat needle .",
      "rg --pr cat needle .",
      "rg --config=project.conf needle .",
      "rg --hostname-bin=./project-script --hyperlink-format=default needle .",
      "find . -ex sh -c id \\;",
      "find . -execdir id \\;",
      "find . -delete",
      "find . -fprint matches.txt",
      "find . -fprintf matches.txt",
    );
    expect(parseReadOnlyShell("uniq -f 2 input.txt")).toEqual([{ argv: ["uniq", "-f", "2", "input.txt"] }]);
    expect(parseReadOnlyShell("xxd -g 2 input.bin")).toEqual([{ argv: ["xxd", "-g", "2", "input.bin"] }]);
    expect(parseReadOnlyShell("sort -- input.txt")).toEqual([{ argv: ["sort", "--", "input.txt"] }]);
    expect(parseReadOnlyShell("rg -- --pre file.txt")[0]!.argv).toEqual(["rg", "--no-config", "--", "--pre", "file.txt"]);
  });

  it("allows constrained read-only git and injects safeguards", () => {
    const prepared = parseReadOnlyShell("git -C /tmp/project diff --stat")[0]!.argv;
    expect(prepared).toEqual(expect.arrayContaining(["git", "--no-pager", "--no-optional-locks", "core.fsmonitor=false", "core.hooksPath=/dev/null", "diff.external=", "-C", "/tmp/project", "diff", "--no-ext-diff", "--no-textconv", "--stat"]));
    expect(parseReadOnlyShell("git grep needle src")[0]!.argv).toContain("grep");
    expect(parseReadOnlyShell("git blame src/file.ts")[0]!.argv).toContain("blame");
    expect(parseReadOnlyShell("git -C ../project status")[0]!.argv).toContain("../project");
    expect(parseReadOnlyShell("git -C 'C:\\project' status")[0]!.argv).toContain("C:\\project");
    expect(parseReadOnlyShell("git diff -- src/file.ts")[0]!.argv).toContain("--");
    expect(prepared).toEqual(expect.arrayContaining(["log.showSignature=false", "gpg.program=false", "gpg.openpgp.program=false", "gpg.x509.program=false", "gpg.ssh.program=false"]));
  });

  it("rejects git mutations, configuration injection, external helpers, tags, and remotes", () => {
    expectDenied(
      "git push origin main",
      "git config user.name changed",
      "git -c core.pager=sh status",
      "git --config-env=core.pager=HOME status",
      "git tag -l",
      "git remote -v",
      "git diff --ext-diff",
      "git diff --ext",
      "git diff --text",
      "git diff --out=result.patch",
      "git diff --paginate",
      "git log --show-signature",
      "git show --show-sign",
      "git log --format=%G?",
      "git cat-file --filters --path=sample.txt HEAD:sample.txt",
      "git grep --open-files-in-pager needle",
      "git grep -On needle",
    );
  });

  it("rejects interpreters and wrappers rather than attempting source inspection", () => {
    expectDenied("python -c pass", "python3 -c pass", "node -e process.exit()", "bash -c true", "sh -c true", "env cat file");
  });
});
