#!/usr/bin/env node
/**
 * Self-test for `mock-anthropic-server.mjs`.
 *
 * It starts the mock as a child process (exactly the way the E2E harness does),
 * reads `PORT=<n>` from its stdout, and drives the Anthropic Messages endpoints
 * with `fetch` to check the three things the E2E fixture depends on:
 *
 *   1. the streaming SSE event sequence is complete and parseable, and the
 *      non-streaming JSON shape matches the same completion;
 *   2. an overflowing request answers HTTP 400 with the byte-exact body the
 *      incident recorded, including the incrementing `request_id`;
 *   3. the per-segment and structured-checkpoint branches answer 200 with
 *      short, marker-free text (so the final synthesis cannot be re-classified
 *      as a full replay);
 *
 * A second mock instance runs with `--always-overflow` to check that only the
 * ordinary branch is forced to 400 (the circuit-breaker / retry-cap scenario).
 *
 * Usage: node selftest.mjs
 * Exit code: 0 when every assertion passes, 1 otherwise.
 *
 * @module dsh-session-enhance/test/e2e/selftest
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, 'mock-anthropic-server.mjs')

/** The official compaction instruction's stable first line (`dsh-compaction-basic`). */
const OFFICIAL = 'You are now acting as a compaction engine for this AI coding assistant.'
/** The plugin's per-segment instruction's stable first line (`lib/compact/summarizer.mjs`). */
const SEGMENT = 'You are condensing one segment of a longer engineering conversation.'
/** Fixture markers defined by the task contract. */
const FULL_REPLAY = 'E2E-FULL-REPLAY'
const FORCE = 'E2E-FORCE-OVERFLOW'

/** Byte-exact 400 body expected for the first overflow (`gw-e2e-1`). */
const EXPECTED_OVERFLOW_BODY_V1 = `{"error":{"message":"Upstream request failed: [invalid_request_error] worker: this model's maximum context length is 1048576 tokens, but the prompt contains 1049641 input tokens (request_id: gw-e2e-1)","type":"invalid_request_error"},"type":"error"}`

/** Collected results so one failed assertion still lets the others be reported. */
const results = []

/**
 * Record one assertion.
 * @param {string} name - what was checked.
 * @param {boolean} ok - whether it passed.
 * @param {string} [detail] - what was observed (used on failure).
 * @returns {void}
 */
function check(name, ok, detail = '') {
  results.push({ name, ok: ok === true, detail })
  process.stdout.write(`${ok ? '[ok]' : '[FAIL]'} ${name}${ok || detail === '' ? '' : ` -- ${detail}`}\n`)
}

/**
 * Assert equality with a readable diff.
 * @param {string} name - assertion name.
 * @param {unknown} actual - observed value.
 * @param {unknown} expected - expected value.
 * @returns {void}
 */
function equal(name, actual, expected) {
  const ok = actual === expected
  check(name, ok, ok ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/**
 * Start the mock and resolve once it printed `PORT=<n>`.
 * @param {{ alwaysOverflow?: boolean, logFile?: string }} [options] - mock options.
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, stderr: () => string, stop: () => Promise<void> }>} handle.
 */
function startMock(options = {}) {
  const args = [SERVER, '--port', '0']
  if (options.alwaysOverflow === true) args.push('--always-overflow')
  if (options.logFile !== undefined) args.push(`--log-file=${options.logFile}`)
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderrText = ''
  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8')
  })

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`mock did not print PORT= within 10s. stderr: ${stderrText}`))
    }, 10_000)
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      const match = /^PORT=(\d+)$/.exec(line)
      if (match === null) return
      clearTimeout(timer)
      lines.close()
      const port = Number(match[1])
      resolve({
        child,
        port,
        stderr: () => stderrText,
        stop: async () => {
          if (child.exitCode !== null) return
          child.kill('SIGTERM')
          await new Promise((done) => {
            const force = setTimeout(() => {
              child.kill('SIGKILL')
              done()
            }, 5_000)
            child.once('exit', () => {
              clearTimeout(force)
              done()
            })
          })
        },
      })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/**
 * POST one Anthropic Messages request.
 * @param {number} port - mock port.
 * @param {Record<string, unknown>} body - request body.
 * @returns {Promise<{ status: number, contentType: string, text: string }>} response facts.
 */
async function post(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text: await response.text(),
  }
}

/**
 * Parse an SSE body into `{event, data}` records, the same two fields
 * pi-ai's `decodeSseLine` reads.
 * @param {string} raw - raw response text.
 * @returns {Array<{ event: string | null, data: string }>} parsed records.
 */
function parseSse(raw) {
  const records = []
  let event = null
  let data = []
  for (const line of raw.split(/\r?\n/)) {
    if (line === '') {
      if (event !== null || data.length > 0) {
        records.push({ event, data: data.join('\n') })
        event = null
        data = []
      }
      continue
    }
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  if (event !== null || data.length > 0) records.push({ event, data: data.join('\n') })
  return records
}

/**
 * Build a streaming text response body reader that also validates the pi-ai
 * contract: the six expected events, in order, with parseable JSON payloads.
 * @param {string} raw - raw SSE text.
 * @returns {{ events: string[], payloads: any[], text: string, errors: string[] }} parsed summary.
 */
function summarizeSse(raw) {
  const records = parseSse(raw)
  const events = records.map((record) => record.event)
  const payloads = []
  const errors = []
  for (const record of records) {
    try {
      payloads.push(JSON.parse(record.data))
    } catch {
      errors.push(`unparseable data for event ${record.event}: ${record.data.slice(0, 120)}`)
    }
  }
  let text = ''
  for (const payload of payloads) {
    if (payload?.type === 'content_block_delta' && payload?.delta?.type === 'text_delta') {
      text += payload.delta.text
    }
  }
  return { events, payloads, text, errors }
}

/**
 * Read the `{n, classification, promptChars, decision}` log lines of a run.
 * @param {string} file - log file path.
 * @returns {Array<Record<string, unknown>>} parsed entries.
 */
function readLog(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/**
 * Run the whole self-test.
 * @returns {Promise<void>}
 */
async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-e2e-mock-'))
  const logFile = path.join(tempDir, 'mock.log')
  const logFileAlways = path.join(tempDir, 'mock-always.log')
  const mock = await startMock({ logFile })
  /** Every request body shape a compaction flow can send. */
  const officialWithFiller = {
    model: 'deepseek-flash',
    max_tokens: 1024,
    stream: true,
    system: 'system head',
    messages: [
      { role: 'user', content: `Reply with exactly OK. Marker: ${FULL_REPLAY}` },
      { role: 'assistant', content: [{ type: 'text', text: 'OK' }] },
      { role: 'user', content: [{ type: 'text', text: OFFICIAL }] },
    ],
  }
  const normalBody = (stream) => ({
    model: 'deepseek-flash',
    max_tokens: 1024,
    stream,
    messages: [{ role: 'user', content: 'Reply with exactly OK.' }],
  })

  try {
    // 1. Full replay request (official instruction + marker in history) -> 400 byte-exact.
    const fullReplay = await post(mock.port, officialWithFiller)
    equal('full-replay status is 400', fullReplay.status, 400)
    equal('full-replay body is byte-identical to the incident wording with gw-e2e-1', fullReplay.text, EXPECTED_OVERFLOW_BODY_V1)

    // 2. First ordinary request -> 400 (the failure that starts overflow recovery).
    const firstNormal = await post(mock.port, normalBody(true))
    equal('first ordinary request is 400', firstNormal.status, 400)
    check(
      'first ordinary 400 keeps the overflow wording and increments request_id',
      firstNormal.text.includes("maximum context length is 1048576 tokens") && firstNormal.text.includes('(request_id: gw-e2e-2)'),
      firstNormal.text,
    )

    // 3. Second ordinary request -> 200, streaming, pi-ai-compatible event sequence.
    const okStream = await post(mock.port, normalBody(true))
    equal('second ordinary request is 200', okStream.status, 200)
    check('stream response is text/event-stream', okStream.contentType.includes('text/event-stream'), okStream.contentType)
    const sse = summarizeSse(okStream.text)
    equal('SSE event sequence', JSON.stringify(sse.events), JSON.stringify([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]))
    check('every SSE data line parses as JSON', sse.errors.length === 0, sse.errors.join('; '))
    const byType = Object.fromEntries(sse.payloads.map((payload) => [payload.type, payload]))
    equal('SSE text is OK', sse.text, 'OK')
    equal('message_start carries assistant role', byType.message_start?.message?.role, 'assistant')
    check(
      'message_start usage.input_tokens is a positive number',
      typeof byType.message_start?.message?.usage?.input_tokens === 'number'
        && byType.message_start.message.usage.input_tokens > 0,
      JSON.stringify(byType.message_start?.message?.usage),
    )
    equal('content_block_start declares a text block', byType.content_block_start?.content_block?.type, 'text')
    equal('message_delta stop_reason is end_turn', byType.message_delta?.delta?.stop_reason, 'end_turn')
    check(
      'message_delta reports output_tokens',
      typeof byType.message_delta?.usage?.output_tokens === 'number' && byType.message_delta.usage.output_tokens >= 1,
      JSON.stringify(byType.message_delta?.usage),
    )
    check('message_stop is the terminal event', sse.events.at(-1) === 'message_stop')

    // 4. Non-streaming shape returns the same completion as JSON.
    const okJson = await post(mock.port, normalBody(false))
    equal('non-stream request is 200', okJson.status, 200)
    check('non-stream response is application/json', okJson.contentType.includes('application/json'), okJson.contentType)
    const jsonBody = JSON.parse(okJson.text)
    equal('non-stream content text is OK', jsonBody.content?.[0]?.text, 'OK')
    equal('non-stream stop_reason is end_turn', jsonBody.stop_reason, 'end_turn')
    equal('non-stream content block type is text', jsonBody.content?.[0]?.type, 'text')

    // 5. Per-segment (chunked map) request -> 200 short summary, no fixture markers echoed.
    const segment = await post(mock.port, {
      model: 'deepseek-flash',
      max_tokens: 8192,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: `${SEGMENT}\n\n<segment index="1" of="1">\n[tool result]\nsome transcript\n</segment>` }] }],
    })
    equal('segment request is 200', segment.status, 200)
    const segmentSse = summarizeSse(segment.text)
    check('segment summary is short', segmentSse.text.length > 0 && segmentSse.text.length < 600, `${segmentSse.text.length} chars`)
    check(
      'segment summary does not echo any fixture marker or the official instruction',
      !segmentSse.text.includes(FULL_REPLAY)
        && !segmentSse.text.includes(FORCE)
        && !segmentSse.text.includes('You are now acting as a compaction engine'),
      segmentSse.text.slice(0, 200),
    )

    // 6. Structured checkpoint (official instruction without the replay marker) -> 200.
    const checkpoint = await post(mock.port, {
      model: 'deepseek-flash',
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: 'system', content: 'system head' },
        { role: 'user', content: [{ type: 'text', text: `Here are the consolidated summaries of the earlier conversation, in order:\n\n- segment one\n\n${OFFICIAL}` }] },
      ],
    })
    equal('checkpoint request is 200', checkpoint.status, 200)
    const checkpointSse = summarizeSse(checkpoint.text)
    check('checkpoint contains the Primary Request section', checkpointSse.text.includes('## Primary Request and Intent'), checkpointSse.text.slice(0, 120))
    check('checkpoint contains the Next Step section', checkpointSse.text.includes('## Next Step'), checkpointSse.text.slice(0, 120))
    check('checkpoint does not echo the replay marker', !checkpointSse.text.includes(FULL_REPLAY))

    // 7. Forced-overflow marker -> 400 with an incrementing request id.
    const forced = await post(mock.port, {
      model: 'deepseek-flash',
      max_tokens: 1024,
      stream: true,
      messages: [{ role: 'user', content: `Reply OK. Marker: ${FORCE}` }],
    })
    equal('forced-overflow request is 400', forced.status, 400)
    check(
      'forced-overflow body increments request_id past the earlier overflows',
      /\(request_id: gw-e2e-\d+\)/.test(forced.text) && !forced.text.includes('gw-e2e-2)'),
      forced.text,
    )

    // 8. Log contract: one JSON line per request with exactly the documented fields.
    const entries = readLog(logFile)
    equal('log line count equals request count', entries.length, 7)
    check(
      'every log line carries n/classification/promptChars/decision',
      entries.every((entry) => typeof entry.n === 'number'
        && typeof entry.classification === 'string'
        && typeof entry.promptChars === 'number'
        && typeof entry.decision === 'string'),
      JSON.stringify(entries.slice(0, 2)),
    )
    equal(
      'log classifications follow the request order',
      JSON.stringify(entries.map((entry) => entry.classification)),
      JSON.stringify([
        'compaction_full_replay',
        'normal',
        'normal',
        'normal',
        'segment_summary',
        'compaction_checkpoint',
        'force_overflow',
      ]),
    )
    check(
      'log promptChars grows with the prompt',
      entries[5].promptChars > entries[1].promptChars,
      `${entries[1].promptChars} vs ${entries[5].promptChars}`,
    )

    // 9. Optional read-only helper endpoints.
    const stats = await fetch(`http://127.0.0.1:${mock.port}/__mock/stats`).then((response) => response.json())
    equal('stats reports the request count', stats.requests, 7)
    equal('stats counts the full-replay classification', stats.classifications.compaction_full_replay, 1)
    const health = await fetch(`http://127.0.0.1:${mock.port}/healthz`).then((response) => response.json())
    equal('healthz answers ok', health.ok, true)

    // 10. Unknown route -> 404 JSON, not a crash.
    const missing = await fetch(`http://127.0.0.1:${mock.port}/v1/other`, { method: 'POST' })
    equal('unknown route is 404', missing.status, 404)

    await mock.stop()

    // 11. --always-overflow only forces the ordinary branch, leaving compaction hops intact.
    const always = await startMock({ logFile: logFileAlways, alwaysOverflow: true })
    try {
      const first = await post(always.port, normalBody(true))
      const second = await post(always.port, normalBody(true))
      equal('always-overflow: first ordinary request is 400', first.status, 400)
      equal('always-overflow: second ordinary request is still 400', second.status, 400)
      const segmentUnderAlways = await post(always.port, {
        model: 'deepseek-flash',
        max_tokens: 8192,
        stream: true,
        messages: [{ role: 'user', content: SEGMENT }],
      })
      equal('always-overflow: the segment branch still answers 200', segmentUnderAlways.status, 200)
      const alwaysEntries = readLog(logFileAlways)
      equal('always-overflow log has three requests', alwaysEntries.length, 3)
      equal(
        'always-overflow decisions are 400/400/200',
        JSON.stringify(alwaysEntries.map((entry) => entry.decision)),
        JSON.stringify(['400 overflow (always)', '400 overflow (always)', '200 segment summary']),
      )
    } finally {
      await always.stop()
    }

    const failed = results.filter((result) => !result.ok)
    process.stdout.write(`\nselftest: ${results.length - failed.length}/${results.length} passed\n`)
    if (failed.length > 0) {
      process.exitCode = 1
      process.stdout.write(`failed: ${failed.map((result) => result.name).join(' | ')}\n`)
    }
  } finally {
    await mock.stop().catch(() => {})
    fs.rmSync(tempDir, { recursive: true, force: true })
  }

  // Self-exiting on purpose: the fixture must never leave a listening mock or an
  // open handle behind when a release gate runs this script.
  await new Promise((resolve) => process.stdout.write('', resolve))
  process.exit(process.exitCode ?? 0)
}

main().catch((error) => {
  process.stderr.write(`selftest crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
