# triage-agent

Point it at a GitHub issue. It clones the repository, reads around in it, and
tells you which files to start with.

```
pnpm dev https://github.com/corsairdev/corsair/issues/1718
```

```
issue: corsairdev/corsair#1718
cloning https://github.com/corsairdev/corsair.git
  into /home/monis/triage-agent/.cache/corsairdev-corsair
cloned in 22s
[0] calling model...
[0] ok list_files({}) -> 23 lines
[1] calling model...
[1] ok list_files({"path":"packages"}) -> 101 lines
[2] calling model...
[2] ok read_file({"path":"scripts/generate-plugin.ts"}) -> 101 lines
[3] calling model... (final, no tools)

### What the issue is asking for
...
### Files and directories to start with
...
### Concrete first step
...

run log: /home/monis/triage-agent/runs/2026-09-10T09-55-13-209Z.json
```

The answer is the point, but so is the run log. Every run writes a JSON file
you can read afterwards to work out *why* the model said what it said.

## What it is

An agent loop, not a model. The loop is about a hundred lines:

1. Send the system prompt, the issue text, and a list of tools to the model.
2. The model replies with either prose or a request to call a tool.
3. If it is a tool call, run the tool, append the result, and go back to 1.
4. If it is prose, that is the answer.

On the last turn the tools are withheld, which forces the model to answer with
what it has rather than searching forever.

## Setup

Requires Node 22+, `pnpm`, and `git` and `ripgrep` (`rg`) on your PATH.

```bash
pnpm install
cp .env.example .env
```

Then fill in `.env`:

| Variable | Required | What it is |
| --- | --- | --- |
| `GOOGLE_API_KEY` | yes | Gemini API key from [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `GITHUB_TOKEN` | no | Raises the GitHub API limit from 60 to 5,000 requests an hour, and lets you read private repositories |
| `BASE_URL` | no | Overrides the model endpoint, for pointing the loop at a local stub |

## Usage

Both forms work:

```bash
pnpm dev https://github.com/owner/repo/issues/123
pnpm dev 'owner/repo#123'          # quote it, or your shell eats the #
```

A pull request URL is rejected on purpose. GitHub serves pull requests from the
issues endpoint too, so `/issues/123` succeeds for a PR — the response is
checked for a `pull_request` key and refused.

The repository is cloned into `.cache/<owner>-<repo>` and reused on later runs.
The clone is deliberately **not** shallow: `--depth 1` cannot check out the
parent commit of a merge, which is exactly what evaluating this thing needs.

## The tools

The model gets four. All of them are read-only, and all of them are capped so a
single call cannot flood the context.

| Tool | What it does | Cap |
| --- | --- | --- |
| `list_files` | Lists a directory | 100 entries |
| `read_file` | Reads a file | 100 lines |
| `search_code` | Regex search over file contents, returns paths | 20 files |
| `recent_changes` | `git log` for a path: hash, author, relative date, subject | 5 commits |

Every result is also capped at 8,000 characters, because a minified bundle is
one line no matter how long it is.

### How the tools defend themselves

The model's arguments arrive as a string it generated token by token. Nothing
guarantees they are valid JSON, let alone the right shape, so each tool has a
Zod schema that does double duty: it generates the JSON Schema sent to the
model, and it validates what comes back.

- **Argument injection.** `execFile` stops shell metacharacters but does nothing
  about a value landing in flag position. A query of `--pre=/tmp/x` is a
  ripgrep flag that runs a program of the model's choosing. The pattern is
  passed with `-e` and paths come after `--`.
- **Path traversal.** `..` segments, absolute paths and drive letters are
  rejected, since all three escape the cloned repository.
- **Honest failures.** A bad regex is not "no files matched", and a directory is
  not "no such file". Failures are separated into `INVALID_CALL:` (the model
  built the call wrong and should retry) and `ERROR:` (the call was fine and the
  repository said no). Both go back to the model as tool results, so a mistake
  costs one turn instead of killing the run.
- **Broken environment.** If `rg` or `git` cannot be spawned at all, the run
  throws. That is not something the model can act on.

## Run logs

Every run writes `runs/<timestamp>.json`, including runs that crash. The write
is in a `finally`, and `endedAs` starts at `"threw"` — the truthful default if
the process dies before anything else is set.

```jsonc
{
  "startedAt": "2026-09-10T09:55:13.209Z",
  "model": "gemini-3.8-flash",
  "repo": "corsairdev/corsair",
  "issueNumber": 1718,
  "issue": "...",          // title and body, as sent
  "systemPrompt": "...",   // the exact prompt this run used
  "rounds": [
    {
      "index": 0,
      "content": null,     // the model's prose, if any
      "usage": { "prompt_tokens": 1090, "completion_tokens": 10, "total_tokens": 1118 },
      "toolCalls": [
        {
          "name": "list_files",
          "rawArguments": "{\"path\":\".\"}",
          "outcome": "ok",  // "ok" | "tool_error" | "invalid_call"
          "result": "..."
        }
      ]
    }
  ],
  "answer": "...",
  "endedAs": "answered"     // "answered" | "out_of_turns" | "threw"
}
```

`systemPrompt` is stored per run on purpose. The prompt is the thing you iterate
most, and a log that does not record which version produced it cannot be
compared against anything.

## Layout

```
src/
  index.ts    entry point: argv in, parse, fetch, clone, run
  github.ts   parse an issue URL or owner/repo#123, fetch title and body
  clone.ts    clone into .cache/, reuse if already there
  agent.ts    the loop, the turn budget, retries
  tools.ts    schemas, tool definitions, and the four implementations
  prompt.ts   the system prompt, alone in a file so it is easy to diff
  log.ts      RunLog types and the writer
```

`prompt.ts` is separate because it changes more often than the code does, and
fifty lines of prose in the middle of a source file makes the code hard to read.

## Knobs

All in `src/agent.ts`:

| Constant | Default | Why |
| --- | --- | --- |
| `MODEL` | `gemini-3.8-flash` | Free-tier quota is per model, so switching models gets a fresh daily bucket |
| `MAX_TURNS` | `6` | Five tool rounds, then a forced answer |
| `WARN_AT` | `2` | Turns remaining when the model is told to start narrowing down |
| `PACE_MS` | `13_000` | Sleep between rounds, for per-minute rate limits |

Retries are status-aware: `500`, `502`, `503` and `504` are retried three times
with backoff, and `429` is never retried. A daily quota does not refill in the
few seconds the error suggests, so retrying it just spends four requests instead
of one.

## Known limits

- **The free tier is 20 requests per day, per model.** A run costs about six, so
  that is three runs before you have to switch models or enable billing.
- **The Google AI Pro subscription does not help.** It applies to the Gemini
  apps and AI Studio, not to API keys. Confirmed the hard way.
- **Prompt instructions about tool use do not reliably stick.** Telling the
  model "call `recent_changes` on at least one thing you recommend" was ignored
  by one model and obeyed unprompted by another. The run logs are how you find
  that out.
