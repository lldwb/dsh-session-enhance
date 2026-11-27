#!/usr/bin/env node
/**
 * Zero-dependency mock of the Anthropic Messages API for the local E2E fixture
 * of "the compaction request itself overflows the window" (HTTP 400).
 *
 * The provider route under test is pi-ai's `anthropic-messages` adapter
 * (`@deepseek-ai/dsh-llm-pi-ai` -> `@earendil-works/pi-ai`), which posts to
 * `POST /v1/messages?beta=true` and parses the SSE events emitted here.
 *
 * Behaviour is chosen from the prompt text, so one server can play every hop of
 * the compaction drama:
 *
 *   1. official compaction instruction + `E2E-FULL-REPLAY`  -> 400 overflow
 *      (the "replay the whole history" request that overflows by construction)
 *   2. `condensing one segment`                             -> 200 short segment summary
 *   3. official compaction instruction (no fixture marker)  -> 200 structured checkpoint
 *   4. `E2E-FORCE-OVERFLOW`                                 -> 400 overflow
 *   5. anything else                                        -> first request 400 overflow,
 *                                                              later requests 200 "OK"
 *
 * Overflow bodies are byte-identical to the real gateway wording except for the
 * `request_id` suffix, which increments per emitted 400 (`gw-e2e-1`, `gw-e2e-2`, ...).
 *
 * Usage:
 *   node mock-anthropic-server.mjs [--port 0] [--always-overflow] [--log-file=<path>]
 *
 * On listen it prints exactly one `PORT=<actual-port>` line to stdout, which is
 * how the harness learns the ephemeral port. Every request also prints one JSON
 * line: `{n, classification, promptChars, decision}`.
 *
 * SSE event vocabulary matches pi-ai's parser
 * (`@earendil-works/pi-ai/dist/api/anthropic-messages.js`): `message_start`,
 * `content_block_start`, `content_block_delta` (`text_delta`), `content_block_stop`,
 * `message_delta` (`stop_reason` + `usage`), `message_stop`; each event is one
 * `event: <name>` line, one `data: <json>` line, and a blank line.
 *
 * @module dsh-session-enhance/test/e2e/mock-anthropic-server
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

/** Stable fragment of the official compaction instruction (`dsh-compaction-basic`). */
const OFFICIAL_COMPACTION_MARKER = 'You are now acting as a compaction engine'

/** Stable fragment of the plugin's per-segment instruction (`lib/compact/summarizer.mjs`). */
const SEGMENT_MARKER = 'condensing one segment'

/** Fixture marker that, once replayed into the full-history compaction request, forces the 400. */
const FULL_REPLAY_MARKER = 'E2E-FULL-REPLAY'

/** Fixture marker that forces a 400 on any request carrying it (classification runs after 1-3). */
const FORCE_OVERFLOW_MARKER = 'E2E-FORCE-OVERFLOW'

/**
 * The 400 body, byte-for-byte. `%ID%` is replaced with the incremented
 * `request_id`; everything else, including key order and spacing, is the real
 * gateway wording recorded from the incident.
 */
const OVERFLOW_BODY_TEMPLATE = `{"error":{"message":"Upstream request failed: [invalid_request_error] worker: this model's maximum context length is 1048576 tokens, but the prompt contains 1049641 input tokens (request_id: gw-e2e-%ID%)","type":"invalid_request_error"},"type":"error"}`

/** Short segment summary returned for the chunked (map) requests; must not echo fixture markers. */
const SEGMENT_SUMMARY_TEXT = [
  '- E2E mock segment summary: the earlier part of the conversation was condensed for this fixture.',
  '- No pending decisions, files, or errors are carried over from this segment.',
  '- Next step: continue with the context that follows.',
].join('\n')

/** Structured checkpoint returned for the official compaction instruction without fixture markers. */
const CHECKPOINT_TEXT = [
  '## Primary Request and Intent',
  '- E2E fixture: verify that a compaction request which overflows by construction recovers through a chunked summary.',
  '## Key Technical Concepts',
  '- Mock Anthropic Messages provider; DSH compaction transaction; provider error classification.',
  '## Files and Code',
  '- (none)',
  '## Errors and Fixes',
  '- The full-history compaction request exceeded the mock window and was replaced by a chunked summary.',
  '## Pending Jobs',
  '- (none)',
  '## Current Work',
  '- The checkpoint was synthesized by the mock provider for the E2E fixture.',
  '## Next Step',
  '- Reply OK.',
  '## Critical Context',
  '- All text in this checkpoint is fixture output, not a real model summary.',
].join('\n')

/** Text returned for ordinary (non-compaction) requests once the first overflow is consumed. */
const NORMAL_TEXT = 'OK'

/**
 * Strip one layer of YAML-like quoting is not needed here: only CLI flags are parsed.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{ port: number, alwaysOverflow: boolean, logFile: string | undefined, help: boolean }} parsed options.
 */
function parseArgs(argv) {
  const options = { port: 0, alwaysOverflow: false, logFile: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--always-overflow') {
      options.alwaysOverflow = true
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++index] : arg.slice('--port='.length)
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`invalid --port value: ${value}`)
      }
      options.port = port
    } else if (arg === '--log-file' || arg.startsWith('--log-file=')) {
      const value = arg === '--log-file' ? argv[++index] : arg.slice('--log-file='.length)
      if (typeof value !== 'string' || value === '') throw new Error('--log-file needs a path')
      options.logFile = value
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

/** Print the usage text. */
function printUsage() {
  process.stdout.write(
    [
      'mock-anthropic-server.mjs - mock Anthropic Messages provider for the compaction E2E',
      '',
      'Usage: node mock-anthropic-server.mjs [options]',
      '',
      '  --port <n>            listen port; 0 (default) picks an ephemeral port and prints PORT=<n>',
      '  --always-overflow     every ordinary request returns 400 (circuit-breaker / retry-cap tests)',
      '  --log-file=<path>     append one JSON log line per request to this file as well as stdout',
      '  --help                print this text',
      '',
      'Endpoints: POST /v1/messages (query ignored), GET /healthz, GET /__mock/stats',
    ].join('\n') + '\n',
  )
}

/**
 * Recursively collect the model-visible text of one content value.
 * @param {unknown} value - string, content block, or array of blocks.
 * @param {string[]} out - accumulator.
 * @returns {void}
 */
function collectContentText(value, out) {
  if (typeof value === 'string') {
    out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectContentText(item, out)
    return
  }
  if (value === null || typeof value !== 'object') return
  const block = /** @type {Record<string, unknown>} */ (value)
  if (typeof block.text === 'string') out.push(block.text)
  // Tool results carry their payload in `content` (string or nested blocks).
  if (block.content !== undefined && block.content !== value) collectContentText(block.content, out)
  // Tool calls carry their arguments as an object; stringify so a marker inside them is still found.
  if (block.input !== undefined && typeof block.input === 'object' && block.input !== null) {
    try {
      out.push(JSON.stringify(block.input))
    } catch {
      // circular arguments are impossible from JSON.parse; ignore defensively
    }
  }
}

/**
 * Concatenate every prompt-bearing string of a Messages request body.
 *
 * `messages` is the primary source (the task contract says "all messages"); the
 * `system` field is included too because DSH projects derived system messages
 * into it and a replay marker can legitimately live there.
 *
 * @param {unknown} body - parsed JSON request body.
 * @returns {string} the joined prompt text.
 */
export function collectPromptText(body) {
  const parts = []
  if (body !== null && typeof body === 'object') {
    const payload = /** @type {Record<string, unknown>} */ (body)
    if (Array.isArray(payload.messages)) {
      for (const message of payload.messages) {
        if (message !== null && typeof message === 'object') {
          const entry = /** @type {Record<string, unknown>} */ (message)
          const label = typeof entry.role === 'string' ? entry.role : 'unknown'
          const texts = []
          collectContentText(entry.content, texts)
          if (texts.length > 0) parts.push(`[${label}]\n${texts.join('\n')}`)
        }
      }
    }
    if (payload.system !== undefined) collectContentText(payload.system, parts)
  }
  return parts.join('\n\n')
}

/**
 * Classify one request. The order is the contract, not a heuristic: it decides
 * which hop of the compaction flow the mock is answering.
 *
 * @param {string} promptText - joined prompt text.
 * @returns {'compaction_full_replay'|'segment_summary'|'compaction_checkpoint'|'force_overflow'|'normal'} classification.
 */
export function classify(promptText) {
  const has = (marker) => promptText.includes(marker)
  if (has(OFFICIAL_COMPACTION_MARKER) && has(FULL_REPLAY_MARKER)) return 'compaction_full_replay'
  if (has(SEGMENT_MARKER)) return 'segment_summary'
  if (has(OFFICIAL_COMPACTION_MARKER)) return 'compaction_checkpoint'
  if (has(FORCE_OVERFLOW_MARKER)) return 'force_overflow'
  return 'normal'
}

/** Approximate output tokens for the reported usage (never used for routing). */
function outputTokensOf(text) {
  return Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Build the Anthropic SSE event list for a plain text completion.
 * @param {{ id: string, model: string, text: string, inputTokens: number }} spec - response spec.
 * @returns {Array<[string, unknown]>} ordered `[eventName, payload]` pairs.
 */
function textSseEvents(spec) {
  const outputTokens = outputTokensOf(spec.text)
  return [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: spec.id,
          type: 'message',
          role: 'assistant',
          model: spec.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: spec.inputTokens, output_tokens: 1 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: spec.text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]
}

/**
 * Write an SSE response.
 * @param {http.ServerResponse} res - response.
 * @param {Array<[string, unknown]>} events - `[eventName, payload]` pairs.
 * @returns {void}
 */
function sendSse(res, events) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  for (const [name, payload] of events) {
    res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
  }
  res.end()
}

/**
 * Write a non-streaming Messages JSON response.
 * @param {http.ServerResponse} res - response.
 * @param {{ id: string, model: string, text: string, inputTokens: number }} spec - response spec.
 * @returns {void}
 */
function sendMessageJson(res, spec) {
  const body = JSON.stringify({
    id: spec.id,
    type: 'message',
    role: 'assistant',
    model: spec.model,
    content: [{ type: 'text', text: spec.text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: spec.inputTokens, output_tokens: outputTokensOf(spec.text) },
  })
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Write a JSON response with an explicit status code.
 * @param {http.ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {string} rawBody - exact body text (already JSON-encoded).
 * @returns {void}
 */
function sendRawJson(res, status, rawBody) {
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawBody) })
  res.end(rawBody)
}

/**
 * Start the mock server.
 * @param {{ port?: number, alwaysOverflow?: boolean, logFile?: string }} [options] - server options.
 * @returns {Promise<{ server: http.Server, port: number, close: () => Promise<void> }>} the listening server and its port.
 */
export function startMockServer(options = {}) {
  const alwaysOverflow = options.alwaysOverflow === true
  const logFile = options.logFile === undefined ? undefined : path.resolve(options.logFile)
  if (logFile !== undefined) fs.writeFileSync(logFile, '', 'utf8')

  /** Request ordinal across the server's lifetime. */
  let requestCount = 0
  /** Ordinary (non-compaction) request ordinal; the first one overflows. */
  let normalCount = 0
  /** Overflow body ordinal, injected into `request_id` (`gw-e2e-<n>`). */
  let overflowCount = 0
  /** One entry per request, also mirrored to the log file. */
  const logEntries = []

  /**
   * Append one request log line to stdout and (optionally) the log file.
   * @param {{n: number, classification: string, promptChars: number, decision: string}} entry - log record.
   * @returns {void}
   */
  function recordRequest(entry) {
    logEntries.push(entry)
    const line = JSON.stringify(entry)
    process.stdout.write(`${line}\n`)
    if (logFile !== undefined) {
      try {
        fs.appendFileSync(logFile, `${line}\n`, 'utf8')
      } catch {
        // A log-file failure must never change what the provider answers.
      }
    }
  }

  /** Next 400 overflow body, with the incremented request id. */
  function nextOverflowBody() {
    overflowCount += 1
    return OVERFLOW_BODY_TEMPLATE.replace('%ID%', String(overflowCount))
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendRawJson(res, 200, JSON.stringify({ ok: true, requests: requestCount }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/__mock/stats') {
      const classifications = {}
      for (const entry of logEntries) {
        classifications[entry.classification] = (classifications[entry.classification] ?? 0) + 1
      }
      sendRawJson(res, 200, JSON.stringify({ requests: requestCount, classifications, entries: logEntries }))
      return
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      sendRawJson(res, 404, JSON.stringify({
        error: { message: `mock-anthropic-server: unsupported ${req.method} ${url.pathname}`, type: 'not_found_error' },
        type: 'error',
      }))
      return
    }

    const chunks = []
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      // 64 MiB is far above any legitimate compaction payload in this workspace;
      // refusing runaway bodies keeps a broken client from pinning the process.
      if (bytes > 64 * 1024 * 1024) {
        req.destroy(new Error('request body too large for the E2E mock'))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => {
      // Client aborted mid-upload (an aborted agent turn): nothing to answer.
    })
    req.on('end', () => {
      requestCount += 1
      const n = requestCount
      let body
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        recordRequest({ n, classification: 'invalid_json', promptChars: 0, decision: '400 invalid json' })
        sendRawJson(res, 400, JSON.stringify({
          error: { message: 'mock-anthropic-server: request body is not valid JSON', type: 'invalid_request_error' },
          type: 'error',
        }))
        return
      }

      const promptText = collectPromptText(body)
      const classification = classify(promptText)
      const model = typeof body?.model === 'string' && body.model !== '' ? body.model : 'deepseek-flash'
      const wantsStream = body?.stream !== false && body?.stream !== undefined
      const messageId = `msg_e2e_${n}`
      const inputTokens = Math.max(1, Math.ceil(promptText.length / 4))

      /**
       * Answer with text on the requested shape (SSE or JSON).
       * @param {string} text - assistant text.
       * @param {string} decision - decision label for the log.
       * @returns {void}
       */
      const answerText = (text, decision) => {
        recordRequest({ n, classification, promptChars: promptText.length, decision })
        const spec = { id: messageId, model, text, inputTokens }
        if (wantsStream) sendSse(res, textSseEvents(spec))
        else sendMessageJson(res, spec)
      }

      /** Answer with a 400 overflow body. @param {string} decision - decision label. */
      const answerOverflow = (decision) => {
        recordRequest({ n, classification, promptChars: promptText.length, decision })
        sendRawJson(res, 400, nextOverflowBody())
      }

      switch (classification) {
        case 'compaction_full_replay':
          answerOverflow('400 overflow (full replay)')
          return
        case 'segment_summary':
          answerText(SEGMENT_SUMMARY_TEXT, '200 segment summary')
          return
        case 'compaction_checkpoint':
          answerText(CHECKPOINT_TEXT, '200 checkpoint')
          return
        case 'force_overflow':
          answerOverflow('400 overflow (forced)')
          return
        default: {
          normalCount += 1
          if (alwaysOverflow || normalCount === 1) {
            answerOverflow(alwaysOverflow ? '400 overflow (always)' : '400 overflow (first normal)')
            return
          }
          answerText(NORMAL_TEXT, '200 ok')
        }
      }
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        server,
        port,
        close: () => new Promise((done) => {
          server.closeAllConnections?.()
          server.close(() => done())
        }),
      })
    })
  })
}

/**
 * CLI entry point.
 * @returns {Promise<void>}
 */
async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`mock-anthropic-server: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    printUsage()
    return
  }

  const { server, port, close } = await startMockServer(options)
  process.stdout.write(`PORT=${port}\n`)

  let stopping = false
  /**
   * Stop accepting connections and exit cleanly; log lines are flushed by
   * `appendFileSync`, so there is nothing else to drain.
   * @param {string} signal - the signal name, for the stderr note.
   * @returns {void}
   */
  const shutdown = (signal) => {
    if (stopping) return
    stopping = true
    process.stderr.write(`mock-anthropic-server: ${signal}, closing on port ${port}\n`)
    close().then(() => {
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // The listening server keeps the event loop alive; nothing else is needed.
  void server
}

// Only auto-start when executed directly (`node mock-anthropic-server.mjs`),
// not when the selftest imports `startMockServer`.
const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === new URL(import.meta.url).href
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`mock-anthropic-server: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
