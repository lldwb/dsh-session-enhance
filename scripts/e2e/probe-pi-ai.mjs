#!/usr/bin/env node
/**
 * Fixture probe: drive `mock-anthropic-server.mjs` through the **real** pi-ai
 * Anthropic adapter and the **real** overflow classifiers, instead of the
 * hand-written SSE parser in `selftest.mjs`.
 *
 * What it proves about the fixture (not about DSH, which the sandbox regression covers):
 *
 *   1. pi-ai's own `api/anthropic-messages` SSE parser accepts the mock's event
 *      sequence and produces a terminal `done` event with `stopReason: 'stop'`
 *      and the expected text.
 *   2. pi-ai renders the mock's HTTP 400 as a terminal `error` event whose
 *      `errorMessage` is `400 <json body>` — the exact shape
 *      `@deepseek-ai/dsh-llm-pi-ai/src/stream.ts` classifies.
 *   3. That error text is recognised as a context-window overflow by all three
 *      classifiers the compaction path consults:
 *        - pi-ai `utils/overflow` `isContextOverflow`
 *        - `@deepseek-ai/dsh-llm` `isContextWindowExceededError`
 *        - the plugin's `lib/compact/overflow.mjs` `isOverflowFailure`
 *   4. The per-segment prompt branch answers 200 with short, marker-free text.
 *
 * The packages are resolved from a local DSH runtime checkout (default:
 * `.scratch/rc5-runtime/cli/node_modules`). When that checkout is absent the
 * probe reports `[skip]` and exits 0, so it can live in the repo without
 * pinning a machine-specific path.
 *
 * Usage:
 *   node probe-pi-ai.mjs
 *   PI_AI_MODULES=<dir containing @earendil-works/pi-ai> node probe-pi-ai.mjs
 *
 * @module dsh-session-enhance/test/e2e/probe-pi-ai
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { startMockServer } from './mock-anthropic-server.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..', '..')

/** Default runtime checkout used by this workspace's earlier E2E work. */
const DEFAULT_MODULES = 'E:\\dsh-plugins\\.scratch\\rc5-runtime\\cli\\node_modules'

/** Resolve the modules root from the environment or the workspace default. */
const MODULES = process.env.PI_AI_MODULES ?? DEFAULT_MODULES

const results = []

/**
 * Record one assertion.
 * @param {string} name - what was checked.
 * @param {boolean} ok - whether it passed.
 * @param {string} [detail] - observed value on failure.
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
 * Import a module entry from an absolute path (bypassing the repo's own resolution).
 * @param {string} absolutePath - file path.
 * @returns {Promise<any>} the module namespace.
 */
async function importPath(absolutePath) {
  return import(pathToFileURL(absolutePath).href)
}

/**
 * Run one pi-ai request and collect its terminal event.
 * @param {any} stream - pi-ai `stream` function.
 * @param {Record<string, unknown>} model - pi-ai model descriptor.
 * @param {Array<Record<string, unknown>>} messages - pi-ai messages.
 * @returns {Promise<{ events: any[], terminal: any }>} every event and the final done/error event.
 */
async function runTurn(stream, model, messages) {
  const events = []
  const eventStream = stream(model, { messages }, { apiKey: 'e2e-fixture-key', maxRetries: 0 })
  for await (const event of eventStream) events.push(event)
  const terminal = events.find((event) => event.type === 'done' || event.type === 'error')
  return { events, terminal }
}

/**
 * Probe entry point.
 * @returns {Promise<void>}
 */
async function main() {
  const piAiEntry = path.join(MODULES, '@earendil-works', 'pi-ai', 'dist', 'api', 'anthropic-messages.js')
  const overflowEntry = path.join(MODULES, '@earendil-works', 'pi-ai', 'dist', 'utils', 'overflow.js')
  const dshLlmEntry = path.join(MODULES, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
  if (!fs.existsSync(piAiEntry)) {
    process.stdout.write(`[skip] no pi-ai checkout at ${MODULES}; set PI_AI_MODULES to a node_modules dir\n`)
    return
  }

  const { stream } = await importPath(piAiEntry)
  const { isContextOverflow } = await importPath(overflowEntry)
  const { isContextWindowExceededError } = await importPath(dshLlmEntry)
  const { isOverflowFailure } = await importPath(path.join(PLUGIN_ROOT, 'lib', 'compact', 'overflow.mjs'))

  const mock = await startMockServer({})
  try {
    const model = {
      id: 'deepseek-flash',
      name: 'deepseek-flash',
      api: 'anthropic-messages',
      provider: 'sub2api',
      baseUrl: `http://127.0.0.1:${mock.port}`,
      reasoning: false,
      input: ['text'],
      contextWindow: 20000,
      maxTokens: 2048,
      // pi-ai's Model requires cost; DSH routes built from a config profile use
      // the same all-zero shape (replay.ts zeroes cost and nothing reports spend).
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }

    // 1. First ordinary request: the mock answers 400 -> pi-ai surfaces an `error` event.
    const overflowTurn = await runTurn(stream, model, [
      { role: 'user', content: [{ type: 'text', text: 'Reply with exactly OK.' }] },
    ])
    equal('first turn yields a terminal error event', overflowTurn.terminal?.type, 'error')
    const overflowMessage = overflowTurn.terminal?.error?.errorMessage ?? ''
    check('pi-ai errorMessage starts with the HTTP status and the JSON body ("400 {")', overflowMessage.startsWith('400 {'), overflowMessage.slice(0, 120))
    check(
      'pi-ai errorMessage keeps the gateway overflow wording',
      overflowMessage.includes("maximum context length is 1048576 tokens")
        && overflowMessage.includes('but the prompt contains 1049641 input tokens'),
      overflowMessage.slice(0, 240),
    )
    equal('pi-ai reports stopReason error', overflowTurn.terminal?.error?.stopReason, 'error')
    check('pi-ai isContextOverflow recognises the mock 400', isContextOverflow(overflowTurn.terminal.error) === true)
    check('dsh-llm isContextWindowExceededError recognises the mock 400', isContextWindowExceededError(overflowMessage) === true)
    check('the plugin overflow classifier recognises the mock 400', isOverflowFailure({ message: overflowMessage }) === true)

    // 2. Second ordinary request: 200 -> pi-ai yields done + text.
    const okTurn = await runTurn(stream, model, [
      { role: 'user', content: [{ type: 'text', text: 'Reply with exactly OK.' }] },
    ])
    equal('second turn yields a terminal done event', okTurn.terminal?.type, 'done')
    equal('done stopReason is stop', okTurn.terminal?.message?.stopReason, 'stop')
    equal(
      'done content is the mock text',
      okTurn.terminal?.message?.content?.map((block) => block.text ?? '').join(''),
      'OK',
    )
    check(
      'done usage carries input tokens from message_start',
      typeof okTurn.terminal?.message?.usage?.input === 'number' && okTurn.terminal.message.usage.input > 0,
      JSON.stringify(okTurn.terminal?.message?.usage),
    )
    check('pi-ai emitted text_start/text_delta/text_end event types',
      ['start', 'text_start', 'text_delta', 'text_end', 'done'].every((type) => okTurn.events.some((event) => event.type === type)),
      okTurn.events.map((event) => event.type).join(','))

    // 3. Per-segment request: 200 short summary.
    const segmentTurn = await runTurn(stream, model, [
      {
        role: 'user',
        content: [{
          type: 'text',
          text: 'You are condensing one segment of a longer engineering conversation.\n\n<segment index="1" of="1">\ntranscript\n</segment>',
        }],
      },
    ])
    equal('segment turn yields a terminal done event', segmentTurn.terminal?.type, 'done')
    const segmentText = segmentTurn.terminal?.message?.content?.map((block) => block.text ?? '').join('') ?? ''
    check('segment summary text is short', segmentText.length > 0 && segmentText.length < 600, `${segmentText.length} chars`)
    check('segment summary does not echo the replay marker', !segmentText.includes('E2E-FULL-REPLAY'))

    const failed = results.filter((result) => !result.ok)
    process.stdout.write(`\nprobe: ${results.length - failed.length}/${results.length} passed (pi-ai 1.5.2 from ${MODULES})\n`)
    if (failed.length > 0) {
      process.exitCode = 1
      process.stdout.write(`failed: ${failed.map((result) => result.name).join(' | ')}\n`)
    }
  } finally {
    await mock.close()
  }
}

main().catch((error) => {
  process.stderr.write(`probe crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
