#!/usr/bin/env node
//
// PreToolUse guard — refuse shell commands that would print a secret-bearing
// file's contents into the session transcript.
//
// WHY THIS EXISTS
//   2026-07-28: a grep over `aws.txt` looking for one connection string printed
//   the live AWS console password and Cloudflare password into the transcript.
//   Second occurrence. Both times the only control was "the agent chooses not
//   to", which is not a control.
//
//   `permissions.deny` in .claude/settings.json blocks the Read/Grep/Glob tools.
//   It does NOT block a shell `Get-Content aws.txt`. This hook closes that path.
//
// WHY IT IS NOT A BLANKET FILENAME BLOCK
//   `ssh -i omwa-key.pem ubuntu@...` is the documented, required way to reach the
//   cluster, and `--env-file api/.env` is how services start. Those *name* a
//   protected file without ever printing it. Blocking them would break real work
//   and get the guard disabled, which is worse than no guard.
//
//   So: a .pem / .env / .key is blocked only when paired with a verb that prints
//   file contents. `aws.txt` is blocked unconditionally — nothing legitimately
//   names it in a shell command, because nothing consumes it.
//
// WHAT IT CANNOT DO
//   It matches command text, so a sufficiently creative reader (an unlisted verb,
//   a base64 round-trip, a script written to disk first) gets through. That is
//   why this is layer 2. Layer 1 is not keeping the secrets here at all.
//
// Contract: reads the PreToolUse JSON payload on stdin, prints a deny decision
// as JSON when it objects, prints nothing and exits 0 otherwise.

const PROTECTED_WHEN_READ = [
  { pattern: /aws\.txt/i, label: "aws.txt, a plaintext secrets file" },
  { pattern: /\.pem\b/i, label: "a .pem private key" },
  { pattern: /(^|[^\w.])\.env\b(?!\.example)/i, label: "a .env file" },
  { pattern: /\.key\b/i, label: "a .key file" },
];

// `aws.txt` gets an extra rule the others cannot have: nothing consumes it, so
// relocating it is never legitimate either — copying it somewhere unguarded and
// reading it there would walk straight around the read-verb list.
//
// It is NOT hard-blocked on bare mention. v2 was, and it blocked this very repo's
// documentation and learning-log entries from naming the file they describe.
// A guard that stops you writing about itself is one you route around.
const RELOCATE_VERB =
  /(^|[|;&(`{\s])(cp|copy|mv|move|scp|rsync|Copy-Item|Move-Item|tee|curl|Invoke-WebRequest|Invoke-RestMethod)\b/i;
const AWS_TXT = /aws\.txt/i;

// Verbs that emit file contents to stdout. Shell builtins and PowerShell cmdlets
// and aliases, plus the common "read a file from a one-liner" escapes.
const READ_VERB =
  /(^|[|;&(`{\s])(cat|tac|head|tail|less|more|nl|strings|xxd|od|base64|grep|egrep|fgrep|rg|ack|awk|sed|findstr|type|gc|Get-Content|Select-String|sls|Get-Item|Import-Csv|Format-List|Format-Table|Out-String|Write-Host)\b/i;

const READ_ESCAPE =
  /(readFileSync|readFile\s*\(|\bopen\s*\(|\[IO\.File\]::Read|\[System\.IO\.File\]::Read|Get-Content)/i;

// Co-presence of a read verb and a protected filename is NOT evidence, because
// `ssh -i omwa-key.pem host | head -5` contains both and reads nothing. The verb
// applies to ssh's output, not to the key. So: split into pipeline segments and
// require the verb to actually precede the filename inside one segment.
//
// Found the hard way — the first version of this hook blocked exactly that ssh
// command while its unit tests were green, because every test case was a single
// clean segment. The regression is now case #1 in the allow list.
function segments(command) {
  return command.split(/\|\||&&|[|;\n]/);
}

function firstIndex(segment, re) {
  const m = segment.match(re);
  return m ? m.index : -1;
}

function decide(command) {
  for (const segment of segments(command)) {
    if (AWS_TXT.test(segment) && RELOCATE_VERB.test(segment)) {
      return `This command would copy or transmit aws.txt. Nothing consumes that file, so moving it somewhere unguarded has no legitimate purpose — and it would walk around the read guard. To retrieve the prod DATABASE_URL, read the k8s secret instead: ssh -i omwa-key.pem ubuntu@<eip> "sudo kubectl get secret omwa-api-secrets -o jsonpath='{.data.DATABASE_URL}' | base64 -d"`;
    }
  }

  for (const segment of segments(command)) {
    // Earliest of the two, ignoring misses. Math.max would pick the LATER verb
    // and wrongly clear a file that sits after the earlier one.
    const verbHits = [
      firstIndex(segment, READ_VERB),
      firstIndex(segment, READ_ESCAPE),
    ].filter((i) => i !== -1);
    const verbAt = verbHits.length ? Math.min(...verbHits) : -1;

    for (const { pattern, label } of PROTECTED_WHEN_READ) {
      const fileAt = firstIndex(segment, pattern);
      if (fileAt === -1) continue;

      // A read verb earlier in this same segment, or an input redirect onto the
      // file, means the file itself is what gets printed.
      const redirected = new RegExp(`<\\s*[^\\s<>|]*${pattern.source}`, "i").test(segment);
      if ((verbAt !== -1 && verbAt < fileAt) || redirected) {
        return `This command would print the contents of ${label} into the transcript. Passing the path to a program that consumes it (ssh -i, --env-file) is allowed; printing it is not. If you need a single value, have the consuming program read the file itself.`;
      }
    }
  }

  return null;
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let command = "";
  try {
    command = JSON.parse(raw)?.tool_input?.command ?? "";
  } catch {
    // A payload we cannot parse is not evidence of wrongdoing. Fail open here:
    // the tool-level deny rules still stand, and failing closed would wedge
    // every shell command on an unrelated schema change.
    process.exit(0);
  }

  const reason = decide(String(command));
  if (!reason) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
      systemMessage: "Blocked: command would expose a secret-bearing file.",
    }),
  );
  process.exit(0);
});
