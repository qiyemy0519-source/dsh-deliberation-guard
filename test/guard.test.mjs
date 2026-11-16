/**
 * Standalone behavior tests for the deliberation-budget guard.
 *
 * Run with plain `node test/guard.test.mjs`. No DSH install, no test framework,
 * no build step: the plugin's only import is `node:crypto`, and its optional
 * `@deepseek-ai/schemastery` import is wrapped so its absence is a supported
 * configuration rather than a failure.
 */

import { apply, name, Config } from '../index.js'

const EVENT = 'agent/assistant-stream'
const DEFAULT_NUDGE = '跳过思考，直接用已知信息作答，不要再推演。'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let passed = 0
let failed = 0
const failures = []

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
    return
  }
  failed += 1
  failures.push(label)
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** A mock cordis context exposing only what the guard uses. */
function createContext() {
  const listeners = new Map()
  const reports = []
  const disposers = []
  const ctx = {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      const dispose = () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index < 0) return false
        current.splice(index, 1)
        return true
      }
      disposers.push(dispose)
      return dispose
    },
    logger(named) {
      return {
        warn: (message) => { reports.push(`[${named}] ${String(message)}`) },
        info: () => {},
        error: () => {},
      }
    },
  }
  return {
    ctx,
    reports,
    listenerCount: () => (listeners.get(EVENT) ?? []).length,
    disposeAll: () => { for (const dispose of disposers) dispose() },
    emit(agent, frame) {
      for (const listener of [...(listeners.get(EVENT) ?? [])]) listener({ agent, frame })
    },
  }
}

/** Apply the plugin to a fresh mock context and return the harness around it. */
function createHarness(config) {
  const harness = createContext()
  apply(harness.ctx, config)
  return harness
}

/** Whether `apply` rejects this config. */
function rejectsConfig(config) {
  try {
    apply(createContext().ctx, config)
    return false
  } catch {
    return true
  }
}

/**
 * A fake Agent recording cancel/steer calls, optionally failing one of them.
 * `inbox` stands for the agent's pending work and `cancel` mirrors
 * AgentLoop.cancel: without `keepInbox` the inbox is cleared.
 */
function createAgent({ subagent = false, runtimeDepth, cancelThrows = false, steerThrows = false, inbox = [] } = {}) {
  const calls = []
  return {
    calls,
    inbox,
    options: runtimeDepth === undefined ? {} : { subagentDepth: runtimeDepth },
    session: {
      header: {
        delegationDepth: subagent ? 1 : 0,
        ...(subagent ? { origin: 'subagent' } : {}),
      },
    },
    cancel(cause, options) {
      calls.push(['cancel', cause, options])
      if (options?.keepInbox !== true) inbox.length = 0
      if (cancelThrows) throw new Error('cancel refused')
    },
    steer(message) {
      calls.push(['steer', message])
      if (steerThrows) throw new Error('steer refused')
    },
  }
}

const startFrame = (attemptId, turn, step) => ({ type: 'start', attemptId, revision: 1, turn, step })
const chunkFrame = (attemptId, chunk, index = 0) => ({
  type: 'chunk', attemptId, revision: 1, index, time: Date.now(), chunk,
})
const endFrame = (attemptId) => ({
  type: 'end', attemptId, revision: 1, index: 0, outcome: { kind: 'abandoned' },
})
const reasoningDelta = (text) => ({ type: 'reasoning-delta', index: 0, text })
const countOf = (agent, kind) => agent.calls.filter((call) => call[0] === kind).length
const steeredMessage = (agent) => agent.calls.find((call) => call[0] === 'steer')?.[1]

console.log(`dsh-deliberation-guard — plugin name: ${name}`)
console.log(`schemastery Config present: ${Config !== undefined}`)

// (a) fires exactly once on long pure reasoning, cancel then steer.
{
  console.log('\n(a) long pure reasoning: fires exactly once, cancel then steer')
  const harness = createHarness({ budgetMs: 20, minReasoningChars: 10, cooldownMs: 5000 })
  const agent = createAgent()
  harness.emit(agent, startFrame('attempt-1', 2, 5))
  await sleep(80)
  harness.emit(agent, chunkFrame('attempt-1', reasoningDelta('推演'.repeat(20))))
  for (let index = 0; index < 5; index += 1) {
    harness.emit(agent, chunkFrame('attempt-1', reasoningDelta('继续推演，仍然不给结论')))
  }
  check('cancel called exactly once', countOf(agent, 'cancel') === 1, `got ${countOf(agent, 'cancel')}`)
  check('steer called exactly once', countOf(agent, 'steer') === 1, `got ${countOf(agent, 'steer')}`)
  check('cancel precedes steer', agent.calls.map((call) => call[0]).join(',') === 'cancel,steer',
    agent.calls.map((call) => call[0]).join(','))
  check('cancel cause is {kind:"user"}',
    JSON.stringify(agent.calls[0]?.[1]) === '{"kind":"user"}', JSON.stringify(agent.calls[0]?.[1]))
  check('cancel passes {keepInbox:true} so queued work is not discarded',
    JSON.stringify(agent.calls[0]?.[2]) === '{"keepInbox":true}', JSON.stringify(agent.calls[0]?.[2]))
  const nudge = steeredMessage(agent)
  check('nudge is a user-role message', nudge?.role === 'user', String(nudge?.role))
  check('nudge carries the default text', nudge?.content?.[0]?.text === DEFAULT_NUDGE,
    String(nudge?.content?.[0]?.text))
  check('nudge carries the producer-owned source kind', nudge?.source?.kind === 'deliberation-guard',
    String(nudge?.source?.kind))
  check('nudge source declares a notice form with a bounded summary',
    nudge?.source?.form === 'notice' && typeof nudge?.source?.summary === 'string'
      && nudge.source.summary.length <= 120, JSON.stringify(nudge?.source))
  check('nudge has a fresh string identity',
    typeof nudge?.id === 'string' && nudge.id.length > 0, String(nudge?.id))
  check('no failure was reported', harness.reports.length === 0, harness.reports.join(' | '))

  // The cooldown covers the next attempt, so the nudge's own turn is not cut short.
  harness.emit(agent, endFrame('attempt-1'))
  harness.emit(agent, startFrame('attempt-2', 2, 6))
  await sleep(30)
  harness.emit(agent, chunkFrame('attempt-2', reasoningDelta('又一轮长思考'.repeat(20))))
  check('cooldown suppresses a second interruption inside cooldownMs',
    countOf(agent, 'cancel') === 1, `got ${countOf(agent, 'cancel')}`)

  // With the cooldown disabled, each attempt is guarded on its own evidence.
  const fresh = createHarness({ budgetMs: 0, minReasoningChars: 5, cooldownMs: 0 })
  const freshAgent = createAgent()
  fresh.emit(freshAgent, startFrame('attempt-1', 1, 1))
  fresh.emit(freshAgent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  fresh.emit(freshAgent, endFrame('attempt-1'))
  fresh.emit(freshAgent, startFrame('attempt-2', 1, 2))
  fresh.emit(freshAgent, chunkFrame('attempt-2', reasoningDelta('x'.repeat(50))))
  check('with cooldownMs=0 each attempt is guarded independently',
    countOf(freshAgent, 'cancel') === 2, `got ${countOf(freshAgent, 'cancel')}`)

  // A fresh attempt resets the per-step evidence: text in one attempt does not excuse the next.
  const reset = createHarness({ budgetMs: 0, minReasoningChars: 5, cooldownMs: 0 })
  const resetAgent = createAgent()
  reset.emit(resetAgent, startFrame('attempt-1', 1, 1))
  reset.emit(resetAgent, chunkFrame('attempt-1', { type: 'text-delta', index: 0, text: 'answered' }))
  reset.emit(resetAgent, endFrame('attempt-1'))
  reset.emit(resetAgent, startFrame('attempt-2', 1, 2))
  reset.emit(resetAgent, chunkFrame('attempt-2', reasoningDelta('x'.repeat(50))))
  check('a new attempt resets the text/tool-call evidence',
    countOf(resetAgent, 'cancel') === 1, `got ${countOf(resetAgent, 'cancel')}`)
}

// (b) does not fire once a text or tool-call part appeared.
{
  console.log('\n(b) text or tool-call already emitted: never fires')
  for (const [label, parts] of [
    ['text-delta', [{ type: 'text-delta', index: 0, text: '好的' }]],
    ['block-start(text)', [{ type: 'block-start', index: 0, blockType: 'text' }]],
    ['block-end(text)', [{ type: 'block-end', index: 0, block: { type: 'text', text: '好的' } }]],
    ['tool-call-delta', [{ type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{}' }]],
    ['block-start(tool-call)', [{ type: 'block-start', index: 0, blockType: 'tool-call' }]],
    ['block-end(tool-call)', [{ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: {} } }]],
  ]) {
    const harness = createHarness({ budgetMs: 0, minReasoningChars: 5 })
    const agent = createAgent()
    harness.emit(agent, startFrame('attempt-1', 1, 1))
    for (const part of parts) harness.emit(agent, chunkFrame('attempt-1', part))
    harness.emit(agent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(500))))
    check(`${label} suppresses the guard`, agent.calls.length === 0, JSON.stringify(agent.calls))
  }
  // Reasoning-only whitespace text does not count as an answer.
  const harness = createHarness({ budgetMs: 0, minReasoningChars: 5 })
  const agent = createAgent()
  harness.emit(agent, startFrame('attempt-1', 1, 1))
  harness.emit(agent, chunkFrame('attempt-1', { type: 'text-delta', index: 0, text: '  \n ' }))
  harness.emit(agent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  check('whitespace-only text does not count as an answer', countOf(agent, 'cancel') === 1,
    `got ${countOf(agent, 'cancel')}`)
}

// (c) does not fire below budgetMs or below minReasoningChars.
{
  console.log('\n(c) under budget or under the character floor: never fires')
  const slow = createHarness({ budgetMs: 60000, minReasoningChars: 1 })
  const slowAgent = createAgent()
  slow.emit(slowAgent, startFrame('attempt-1', 1, 1))
  await sleep(50)
  slow.emit(slowAgent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(5000))))
  check('elapsed below budgetMs suppresses the guard', slowAgent.calls.length === 0,
    JSON.stringify(slowAgent.calls))

  const short = createHarness({ budgetMs: 0, minReasoningChars: 5000 })
  const shortAgent = createAgent()
  short.emit(shortAgent, startFrame('attempt-1', 1, 1))
  await sleep(40)
  short.emit(shortAgent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(100))))
  check('reasoning below minReasoningChars suppresses the guard', shortAgent.calls.length === 0,
    JSON.stringify(shortAgent.calls))
}

// (d) enabled=false never fires.
{
  console.log('\n(d) enabled=false: never fires')
  const harness = createHarness({ enabled: false, budgetMs: 0, minReasoningChars: 1 })
  const agent = createAgent()
  harness.emit(agent, startFrame('attempt-1', 1, 1))
  await sleep(20)
  harness.emit(agent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(500))))
  check('disabled guard registers no interruption', agent.calls.length === 0, JSON.stringify(agent.calls))
  check('disabled guard reports nothing', harness.reports.length === 0, harness.reports.join(' | '))
}

// (e) includeSubagents decides whether a child agent is guarded.
{
  console.log('\n(e) includeSubagents decides for child agents')
  const excluded = createHarness({ budgetMs: 0, minReasoningChars: 1 })
  const child = createAgent({ subagent: true })
  excluded.emit(child, startFrame('attempt-1', 1, 1))
  excluded.emit(child, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  check('default (false) leaves a subagent alone', child.calls.length === 0, JSON.stringify(child.calls))

  const parent = createAgent()
  excluded.emit(parent, startFrame('attempt-1', 1, 1))
  excluded.emit(parent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  check('default (false) still guards a top-level agent', countOf(parent, 'cancel') === 1,
    `got ${countOf(parent, 'cancel')}`)

  const runtimeChild = createAgent({ runtimeDepth: 2 })
  excluded.emit(runtimeChild, startFrame('attempt-1', 1, 1))
  excluded.emit(runtimeChild, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  check('a runtime subagentDepth alone marks a child agent', runtimeChild.calls.length === 0,
    JSON.stringify(runtimeChild.calls))

  const included = createHarness({ budgetMs: 0, minReasoningChars: 1, includeSubagents: true })
  const guardedChild = createAgent({ subagent: true })
  included.emit(guardedChild, startFrame('attempt-1', 1, 1))
  included.emit(guardedChild, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  check('includeSubagents=true guards a subagent', countOf(guardedChild, 'cancel') === 1,
    `got ${countOf(guardedChild, 'cancel')}`)

  const guardedRuntimeChild = createAgent({ runtimeDepth: 1 })
  included.emit(guardedRuntimeChild, startFrame('attempt-1', 1, 1))
  included.emit(guardedRuntimeChild, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  check('includeSubagents=true guards a runtime-marked child',
    countOf(guardedRuntimeChild, 'cancel') === 1, `got ${countOf(guardedRuntimeChild, 'cancel')}`)
}

// (f) disposal removes the listener and the guard.
{
  console.log('\n(f) disposal removes the listener')
  const harness = createHarness({ budgetMs: 0, minReasoningChars: 1 })
  const agent = createAgent()
  check('one listener registered on agent/assistant-stream', harness.listenerCount() === 1,
    `got ${harness.listenerCount()}`)
  harness.disposeAll()
  check('listener removed after disposal', harness.listenerCount() === 0, `got ${harness.listenerCount()}`)
  harness.emit(agent, startFrame('attempt-1', 1, 1))
  harness.emit(agent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(500))))
  check('disposed guard no longer interrupts', agent.calls.length === 0, JSON.stringify(agent.calls))
}

// (g) failures stay contained and are reported, never thrown into the stream.
{
  console.log('\n(g) failures are contained and reported')
  const cancelFails = createHarness({ budgetMs: 0, minReasoningChars: 1 })
  const cancelAgent = createAgent({ cancelThrows: true })
  let escaped = false
  cancelFails.emit(cancelAgent, startFrame('attempt-1', 1, 1))
  try {
    cancelFails.emit(cancelAgent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  } catch {
    escaped = true
  }
  check('a throwing cancel() does not escape the listener', escaped === false)
  check('the nudge is still steered after cancel() failed', countOf(cancelAgent, 'steer') === 1,
    `got ${countOf(cancelAgent, 'steer')}`)
  check('the cancel() failure is reported and names cancel',
    cancelFails.reports.length === 1 && cancelFails.reports[0].includes('cancel'),
    cancelFails.reports.join(' | '))

  const steerFails = createHarness({ budgetMs: 0, minReasoningChars: 1 })
  const steerAgent = createAgent({ steerThrows: true })
  escaped = false
  steerFails.emit(steerAgent, startFrame('attempt-1', 1, 1))
  try {
    steerFails.emit(steerAgent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  } catch {
    escaped = true
  }
  check('a throwing steer() does not escape the listener', escaped === false)
  check('the steer() failure is reported and names steer',
    steerFails.reports.length === 1 && steerFails.reports[0].includes('steer'),
    steerFails.reports.join(' | '))

  const malformed = createHarness({ budgetMs: 0, minReasoningChars: 1 })
  const malformedAgent = createAgent()
  escaped = false
  try {
    malformed.emit(undefined, startFrame('attempt-1', 1, 1))
    malformed.emit(malformedAgent, undefined)
    malformed.emit(malformedAgent, { type: 'chunk', attemptId: 'attempt-1', chunk: null })
    malformed.emit(malformedAgent, { type: 'chunk', attemptId: 'unknown-attempt', chunk: reasoningDelta('x'.repeat(50)) })
    malformed.emit(malformedAgent, startFrame('attempt-1', 1, 1))
    malformed.emit(malformedAgent, { type: 'chunk', attemptId: 'attempt-1', chunk: reasoningDelta('x'.repeat(50)) })
    malformed.emit(malformedAgent, endFrame('attempt-1'))
    malformed.emit(malformedAgent, { type: 'chunk', attemptId: 'attempt-1', chunk: reasoningDelta('x'.repeat(50)) })
  } catch {
    escaped = true
  }
  check('malformed and out-of-order frames never throw', escaped === false)
  check('a chunk without a matching start is ignored',
    countOf(malformedAgent, 'cancel') === 1, `got ${countOf(malformedAgent, 'cancel')}`)
  check('no malformed frame produced a failure report', malformed.reports.length === 0,
    malformed.reports.join(' | '))
}

// (h) misconfiguration fails loud at load.
{
  console.log('\n(h) misconfiguration fails loud at load')
  check('rejects a non-boolean enabled', rejectsConfig({ enabled: 'yes' }))
  check('rejects a negative budgetMs', rejectsConfig({ budgetMs: -1 }))
  check('rejects a non-numeric budgetMs', rejectsConfig({ budgetMs: 'soon' }))
  check('rejects a fractional minReasoningChars', rejectsConfig({ minReasoningChars: 1.5 }))
  check('rejects a negative cooldownMs', rejectsConfig({ cooldownMs: -5 }))
  check('rejects a non-boolean includeSubagents', rejectsConfig({ includeSubagents: 1 }))
  check('rejects an empty nudge', rejectsConfig({ nudge: '   ' }))
  check('rejects a non-object config', rejectsConfig('everything'))
  check('accepts an empty config (every field defaults)', rejectsConfig({}) === false)
  check('accepts an absent config', rejectsConfig(undefined) === false)
}

// (i) the plugin is a function plugin: named exports only, no default export.
{
  console.log('\n(i) function-plugin module shape')
  const module = await import('../index.js')
  check('exports the cordis plugin name', module.name === 'deliberation-guard', String(module.name))
  check('exports inject as a list', Array.isArray(module.inject), String(module.inject))
  check('exports Config (a schema, or undefined without schemastery)',
    module.Config === undefined || typeof module.Config === 'function', typeof module.Config)
  check('exports apply as a function', typeof module.apply === 'function', typeof module.apply)
  check('has no default export', module.default === undefined, String(module.default))
  check('export surface is exactly name/inject/Config/apply',
    Object.keys(module).filter((key) => key !== 'default').sort().join(',') === 'Config,apply,inject,name',
    Object.keys(module).join(','))
}

// (j) an autonomous interruption must not discard work a person queued.
{
  console.log('\n(j) queued inbox work survives an autonomous interruption')
  const queued = {
    id: 'human-queued', role: 'user',
    content: [{ type: 'text', text: '顺便把这个也改了' }], source: { kind: 'user' },
  }
  const harness = createHarness({ budgetMs: 0, minReasoningChars: 1 })
  const agent = createAgent({ inbox: [queued] })
  harness.emit(agent, startFrame('attempt-1', 1, 1))
  harness.emit(agent, chunkFrame('attempt-1', reasoningDelta('x'.repeat(50))))
  check('the guard still interrupts', countOf(agent, 'cancel') === 1, `got ${countOf(agent, 'cancel')}`)
  check('the message queued in next-step survives',
    agent.inbox.length === 1 && agent.inbox[0] === queued, JSON.stringify(agent.inbox))
  check('the nudge is delivered alongside the surviving message', countOf(agent, 'steer') === 1,
    `got ${countOf(agent, 'steer')}`)

  // Counter-check that the fake inbox models AgentLoop.cancel faithfully: the
  // same sequence without keepInbox drops the queued message.
  const dropping = createAgent({ inbox: [queued] })
  dropping.cancel({ kind: 'user' })
  check('the fake inbox clears without keepInbox, as AgentLoop.cancel does',
    dropping.inbox.length === 0, JSON.stringify(dropping.inbox))

  const kept = createAgent({ inbox: [queued] })
  kept.cancel({ kind: 'user' }, { keepInbox: true })
  check('the fake inbox retains with keepInbox', kept.inbox.length === 1, JSON.stringify(kept.inbox))
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('failed checks:')
  for (const label of failures) console.log(`  - ${label}`)
}
process.exitCode = failed === 0 ? 0 : 1
