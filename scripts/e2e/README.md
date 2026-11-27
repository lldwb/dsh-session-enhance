# Compaction-overflow E2E fixture

Local fixture for the failure mode **"the compaction request itself overflows the
model window"**: DSH asks the provider to summarize the whole replayed history,
the provider answers `HTTP 400 context length exceeded`, and the plugin's
chunked-summary fallback is what has to recover.

The provider the fixture fakes is pi-ai's `anthropic-messages` route
(`@deepseek-ai/dsh-llm-pi-ai` -> `@earendil-works/pi-ai`), so the mock speaks the
exact SSE/JSON protocol that adapter parses.

Files:

| File | Purpose |
|---|---|
| `mock-anthropic-server.mjs` | Zero-dependency (`node:http` only) mock of `POST /v1/messages` with SSE and non-stream JSON; classifies each request from its prompt text |
| `sandbox-patch.yml` | Loader `--patch` layer pointing `llm-pi-ai` at the mock, tightening `compaction-basic`, and selecting the mock model as default |
| `selftest.mjs` | Starts the mock as a child process and asserts the fixture contract (SSE sequence, byte-exact 400, segment/checkpoint branches, log shape, `--always-overflow`) |
| `probe-pi-ai.mjs` | Optional: drives the fixture through a **real** pi-ai install and the real overflow classifiers, to prove the mock is protocol-correct |
| `README.md` | This file |

`README.md` describes the fixture only. The plugin's behaviour under test lives in
`lib/compact/summarizer.mjs` (chunked summary) and `lib/compact/host.mjs`
(wiring); this directory never changes plugin code.

## Status / known gaps

The mock runs in **ordinary mode** only:

* ordinary request #1 -> `400` overflow, every later ordinary request -> `200 "OK"`;
* `--always-overflow` forces every ordinary request to `400`.

A **scripted `--e2e` mode** (ordinary requests #1/#2 answering a `pwsh` `tool_use`
so the surface grows to >= 3 nodes, #3 overflowing, later requests ending with
`e2e done`) is **not implemented** in this revision. Without it, a headless run
whose surface only has two nodes may be rejected by the official
`selectCompactableRange` before a compaction transaction starts, so do not treat
a run of this fixture alone as proof that the whole compaction recovery path
executed. What this fixture *does* pin down without a sandbox: the provider
protocol (SSE/JSON), the exact overflow body, and the request classification.

## Run the mock

```powershell
node scripts/e2e/mock-anthropic-server.mjs --port 0
# -> PORT=54321      (single line on stdout; parse this)
```

Options:

| Flag | Meaning |
|---|---|
| `--port <n>` | listen port; `0` (default) = ephemeral, prints the real one |
| `--always-overflow` | every ordinary request answers `400` (retry-cap / circuit-breaker tests) |
| `--log-file=<path>` | also append the per-request JSON log to this file |
| `--help` | usage |

Every request prints one JSON line to stdout (and to `--log-file` when given):

```json
{"n":1,"classification":"normal","promptChars":29,"decision":"400 overflow (first normal)"}
```

`classification` is one of `normal`, `compaction_full_replay`, `segment_summary`,
`compaction_checkpoint`, `force_overflow` (plus `invalid_json` for a malformed
body); `decision` is the human-readable outcome.

Read-only helper endpoints: `GET /healthz` and `GET /__mock/stats` (request count,
per-classification counts, full entry list) — handy for fast assertions without
parsing stdout.

## Request classification (order matters)

The mock concatenates the prompt text of `messages` (plus `system`) and applies
these rules top to bottom:

| # | Condition | Answer |
|---|---|---|
| 1 | contains `You are now acting as a compaction engine` **and** `E2E-FULL-REPLAY` | `400` — "full history replay overflows by construction" |
| 2 | contains `condensing one segment` | `200` — short segment summary, **never echoes** `E2E-FULL-REPLAY` (so the final synthesis cannot be re-classified as #1) |
| 3 | contains the official compaction instruction, no fixture marker | `200` — structured checkpoint (`## Primary Request and Intent`, ... `## Next Step`) |
| 4 | contains `E2E-FORCE-OVERFLOW` | `400` |
| 5 | anything else | ordinary: first `400`, later `200 "OK"` (`--always-overflow`: always `400`) |

The `400` body is byte-identical to the recorded gateway wording, with only the
`request_id` suffix incrementing per emitted 400 (`gw-e2e-1`, `gw-e2e-2`, ...):

```json
{"error":{"message":"Upstream request failed: [invalid_request_error] worker: this model's maximum context length is 1048576 tokens, but the prompt contains 1049641 input tokens (request_id: gw-e2e-1)","type":"invalid_request_error"},"type":"error"}
```

That text is recognised as a context-window overflow by all three classifiers on
the compaction path: pi-ai's `utils/overflow` `isContextOverflow`,
`@deepseek-ai/dsh-llm`'s `isContextWindowExceededError`, and the plugin's
`lib/compact/overflow.mjs` `isOverflowFailure` (see `probe-pi-ai.mjs`).

SSE responses use the event vocabulary pi-ai's `api/anthropic-messages` parser
requires: `message_start` -> `content_block_start` (`text`) ->
`content_block_delta` (`text_delta`) -> `content_block_stop` ->
`message_delta` (`stop_reason` + `usage`) -> `message_stop`, one
`event: <name>` line + one `data: <json>` line per event and a blank line after
each. `stream: false` (or an absent `stream`) gets the equivalent non-stream JSON
`message` object.

## Use it from a devkit sandbox

The patch file ships with the placeholder `__MOCK_PORT__`, because a loader patch
must be a static file. Replace it into a temporary copy before applying:

```powershell
node scripts/e2e/mock-anthropic-server.mjs --port 0 --log-file="$env:TEMP\mock-e2e.log"
# read PORT=... above, then:
$port = '<the printed port>'
(Get-Content scripts/e2e/sandbox-patch.yml -Raw).Replace('__MOCK_PORT__', $port) |
  Set-Content "$env:TEMP\sandbox-patch.e2e.yml" -Encoding utf8
```

Then, from the agent session that runs the sandbox (devkit tools):

```text
devkit_sandbox_create  { name: "session-enhance-e2e", template: "headless" }
devkit_sandbox_install { name: "session-enhance-e2e", target: "E:\\dsh-plugins\\dsh-session-enhance" }
devkit_sandbox_compose { name: "session-enhance-e2e", patch: ["<temp>/sandbox-patch.e2e.yml"], grep: "llm-pi-ai" }
devkit_sandbox_run     { name: "session-enhance-e2e", patch: ["<temp>/sandbox-patch.e2e.yml"], task: "<task>" }
devkit_sandbox_destroy { name: "session-enhance-e2e" }
```

Raw CLI equivalent, when the sandbox profile already exists:

```powershell
dsh --profile <sandbox-profile> --patch <temp>\sandbox-patch.e2e.yml "<task>"
```

Notes that decide whether the run can work at all:

* The patch targets rows by `id` (`llm-pi-ai`, `compaction-basic`,
  `agent-default-model`); an `id`-targeted patch **replaces the whole `config`**,
  which is why `llm-pi-ai` restates its only wanted provider. A later `--patch`
  layer therefore wins over earlier ones, as intended.
* The route names `apiKeyEnv: SUB2API_API_KEY`. `devkit_sandbox_run` injects the
  real `refs:` from `<realDshHome>/.credentials.yaml` as environment variables of
  the child only, and its default policy is `['*_API_KEY']`, so this route is
  authenticated without putting a key anywhere in the sandbox. Running `dsh`
  outside devkit requires `SUB2API_API_KEY` to be exported yourself.
* `contextWindow: 20000`, `compaction-basic.thresholdRatio: 0.5` make the
  pressure/overflow paths reachable on a short conversation; raise the window if
  the run's system prompt alone starts a pressure compaction before the first
  request (see the caveat below).

Recommended task prompt for the overflow scenario — the marker must appear in
the history, because rule 1 keys on it:

```text
Reply with exactly OK. Marker: E2E-FULL-REPLAY
```

### Expected mock log (ordinary mode)

If the run reaches the overflow path, the log shows, in this order:

```text
{"n":1,"classification":"normal", ..., "decision":"400 overflow (first normal)"}
{"n":2,"classification":"compaction_full_replay", ..., "decision":"400 overflow (full replay)"}
{"n":3,"classification":"segment_summary", ..., "decision":"200 segment summary"}      # 1..N
{"n":4,"classification":"compaction_checkpoint", ..., "decision":"200 checkpoint"}
{"n":5,"classification":"normal", ..., "decision":"200 ok"}                             # retry after compaction
```

Caveat: if the official single-shot summary is *estimated* above the chunk budget,
the plugin skips the doomed attempt and rule 1's 400 never appears (a fast path,
not a failure); and if the pre-step pressure compaction fires before the first
request, the sequence starts with `compaction_full_replay` instead of `normal`.
Either way, the properties to assert are: at least one `compaction_full_replay`
400, at least one `segment_summary` 200, exactly one `compaction_checkpoint` 200,
and a final ordinary `200`.

### Expected session log

The sandbox session log should contain the compaction transaction:

* `compaction/start`
* `compaction/summary` (the checkpoint the plugin's chunked summary produced)
* `compaction/end` **without** `data.error`

Session logs are multi-frame zstd JSONL. `zstdDecompressSync` only takes one
frame, so split on the zstd magic `28 b5 2f fd` and decode frame by frame:

```js
// Inline snippet: save it anywhere as read-session-events.mjs and run
//   node read-session-events.mjs <session.v4.jsonl.zstd>
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const starts = []
for (let i = 0; i + 3 < buf.length; i += 1) {
  if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) starts.push(i)
}
starts.push(buf.length)
let text = ''
for (let i = 0; i + 1 < starts.length; i += 1) {
  text += zstdDecompressSync(buf.subarray(starts[i], starts[i + 1])).toString('utf8')
}
const wanted = new Set(['compaction/start', 'compaction/summary', 'compaction/end'])
for (const line of text.split('\n')) {
  if (line.trim() === '') continue
  const event = JSON.parse(line)
  const type = event.type ?? event.event?.type
  if (!wanted.has(type)) continue
  const data = event.data ?? event.event?.data ?? {}
  console.log(type, type === 'compaction/end' ? (data.error === undefined ? 'ok' : `ERROR ${JSON.stringify(data.error)}`) : '')
}
```

(Session logs live under the sandbox's `DSH_HOME`, not the real one:
`<sandbox>/dsh-home/sessions/...`; the snippet is plain Node, no dependencies.)

## Self-test

```powershell
node scripts/e2e/selftest.mjs     # exits by itself; 0 = pass
```

The script starts the mock with `--port 0`, reads `PORT=`, and asserts 42
properties: the byte-exact first 400 body, incrementing `request_id`, the full
SSE event sequence and its JSON payload fields, the non-stream JSON shape, short
marker-free segment summaries, the structured checkpoint, forced overflow, the
`{n, classification, promptChars, decision}` log contract and ordering, the
helper endpoints, and the `--always-overflow` branch. Result of the last run:

```text
selftest: 42/42 passed
```

Covered failures from that run (trimmed): full-replay body byte-identical to the
incident wording, SSE sequence `message_start/content_block_start/
content_block_delta/content_block_stop/message_delta/message_stop`, `stop_reason
end_turn` with `output_tokens`, segment summary `< 600` chars without fixture
markers, `--always-overflow` answering `400/400` while the segment branch stays
`200`.

## Protocol probe (optional, needs a pi-ai install on disk)

```powershell
node scripts/e2e/probe-pi-ai.mjs
# or point at any node_modules containing @earendil-works/pi-ai and @deepseek-ai/dsh-llm:
$env:PI_AI_MODULES = 'D:\some\runtime\node_modules'
```

It imports pi-ai's real `dist/api/anthropic-messages.js` (which is also what emits
`400 <json body>` as the terminal `error` event's `errorMessage`), plus the real
`isContextOverflow`, `isContextWindowExceededError` and the plugin's
`isOverflowFailure`, and asserts 15 properties. It prints `[skip]` and exits 0
when no checkout is found. Result of the last run (pi-ai 1.5.2 from a local
`dsh@0.2.2-rc.5` npm install):

```text
probe: 15/15 passed
```

Version note: the installed desktop app bundles pi-ai 1.3.0. Its
`api/anthropic-messages.js` was read from `app.asar` while building this fixture
and uses the same event vocabulary and state machine (`event:`/`data:` lines
flushed by a blank line, `message_start`/`message_stop` required, `text_delta`
applied to a `text` block, `message_delta.stop_reason` mapped to the terminal
reason); the probe above with 1.5.2 is the executable check.
