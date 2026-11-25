/**
 * Standalone behavior tests for the deliberation-budget guard.
 *
 * Run with plain `node test/guard.test.mjs`. No DSH install, no test framework,
 * no build step: the plugin's only import is `node:crypto`, and its optional
 * `@deepseek-ai/schemastery` import is wrapped so its absence is a supported
 * configuration rather than a failure.
 */

import { readFile } from 'node:fs/promises'
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

// ---------------------------------------------------------------------------
// (k) per-conversation control: projection, command, and the projection-aware
//     fire check. The optional layers are mocked through `ctx.inject`.
// ---------------------------------------------------------------------------

/** One committed `command/run` record for the guard command. */
const guardRun = (args, name = 'guard') => ({
  type: 'command/run', seq: 1, time: 1,
  data: { commandId: 'c1', name, args, source: { kind: 'user' } },
})

/**
 * A context that also composes the optional command and projection layers.
 * `value` is the control state the fake handle reads, or a function returning it.
 */
function createControlHarness({ value = { long: false, budgetMs: null }, registerFails = false, commandRegisterFails = false } = {}) {
  const harness = createContext()
  const captured = { deps: undefined, projection: undefined, command: undefined, scopes: 0 }
  let current = value
  const handle = { stateOf: () => (typeof current === 'function' ? current() : current) }
  const scope = {
    logger: harness.ctx.logger,
    commands: {
      register: (definition) => {
        if (commandRegisterFails) throw new Error('command name already registered')
        captured.command = definition
        return () => {}
      },
    },
    sessionProjections: {
      register: (definition) => {
        captured.projection = definition
        return registerFails ? Promise.reject(new Error('registry refused')) : Promise.resolve(handle)
      },
    },
  }
  harness.ctx.inject = (deps, callback) => { captured.deps = deps; captured.scopes += 1; callback(scope) }
  harness.captured = captured
  harness.setValue = (next) => { current = next }
  return harness
}

/** Flush the microtask that installs the projection handle. */
const settleControl = async () => { await Promise.resolve(); await Promise.resolve() }

/** Drive one attempt with enough reasoning to be eligible for interruption. */
function longReasoningAttempt(harness, agent, attemptId = 'a1') {
  harness.emit(agent, startFrame(attemptId, 1, 1))
  harness.emit(agent, chunkFrame(attemptId, { type: 'reasoning-delta', text: 'x'.repeat(50) }))
}

{
  const h = createControlHarness()
  apply(h.ctx, { budgetMs: 1, minReasoningChars: 1, cooldownMs: 0 })
  await settleControl()
  const { captured } = h
  check('(k) the optional layers are requested by name', JSON.stringify(captured.deps) === '["commands","sessionProjections"]', JSON.stringify(captured.deps))
  check('(k) the projection registers under the control key', captured.projection?.key === 'deliberationGuard', String(captured.projection?.key))
  check('(k) the projection declares stateVersion 1', captured.projection?.stateVersion === 1, String(captured.projection?.stateVersion))
  check('(k) the projection starts with no override', JSON.stringify(captured.projection.init()) === '{"long":false,"budgetMs":null}', JSON.stringify(captured.projection.init()))
  check('(k) the projection exposes a wire view', typeof captured.projection.wire?.view === 'function')
  check('(k) the command registers as guard', captured.command?.name === 'guard', String(captured.command?.name))
  check('(k) the command advertises its grammar', captured.command?.input?.hint.includes('long'), String(captured.command?.input?.hint))

  const fold = captured.projection.apply
  const start = captured.projection.init()
  const otherEvent = { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } }
  check('(k) an unrelated event keeps the same state reference', fold(start, otherEvent) === start)
  check('(k) another command keeps the same state reference', fold(start, guardRun('', 'permission')) === start)
  check('(k) a bare report keeps the same state reference', fold(start, guardRun('')) === start)
  check('(k) an unknown argument keeps the same state reference', fold(start, guardRun(' explode')) === start)
  const longOn = fold(start, guardRun(' long'))
  check('(k) /guard long toggles long-thinking on', longOn.long === true && longOn.budgetMs === null, JSON.stringify(longOn))
  check('(k) /guard long toggles back off', fold(longOn, guardRun(' long')).long === false)
  check('(k) /guard long on sets it explicitly', fold(start, guardRun(' long on')).long === true)
  check('(k) /guard long off sets it explicitly', fold(longOn, guardRun(' long off')).long === false)
  check('(k) /guard long rejects a third word', fold(start, guardRun(' long maybe')) === start)
  check('(k) /guard budget records milliseconds', fold(start, guardRun(' budget 5000')).budgetMs === 5000)
  check('(k) /guard budget accepts a preset name', fold(start, guardRun(' budget patient')).budgetMs === 120000)
  check('(k) /guard budget accepts the 90s preset name', fold(start, guardRun(' budget slow')).budgetMs === 90000)
  const clearedBudget = fold({ long: true, budgetMs: 5000 }, guardRun(' budget default'))
  check('(k) /guard budget default clears only the budget and keeps long-thinking',
    clearedBudget.long === true && clearedBudget.budgetMs === null, JSON.stringify(clearedBudget))
  check('(k) /guard budget rejects a negative value', fold(start, guardRun(' budget -1')) === start)
  check('(k) /guard budget rejects exponent notation', fold(start, guardRun(' budget 1e3')) === start)
  check('(k) /guard budget rejects hexadecimal notation', fold(start, guardRun(' budget 0x10')) === start)
  check('(k) /guard budget rejects negative zero', fold(start, guardRun(' budget -0')) === start)
  check('(k) /guard budget rejects numeric separators', fold(start, guardRun(' budget 1_000')) === start)
  check('(k) /guard budget rejects a unit suffix', fold(start, guardRun(' budget 45000ms')) === start)
  check('(k) /guard budget rejects a bare word', fold(start, guardRun(' budget soon')) === start)
  const reset = fold({ long: true, budgetMs: 5000 }, guardRun(' reset'))
  check('(k) /guard reset clears both overrides', reset.long === false && reset.budgetMs === null, JSON.stringify(reset))
  check('(k) the wire view reuses the state reference', captured.projection.wire.view(start) === start)
  check('(k) the state schema accepts the empty override', captured.projection.stateSchema.parse({ long: false, budgetMs: null }).long === false)
  let rejectedLong = false
  try { captured.projection.stateSchema.parse({ long: 'yes', budgetMs: null }) } catch { rejectedLong = true }
  check('(k) the state schema rejects a non-boolean long', rejectedLong)
  let rejectedBudget = false
  try { captured.projection.stateSchema.parse({ long: false, budgetMs: -1 }) } catch { rejectedBudget = true }
  check('(k) the state schema rejects a negative budget', rejectedBudget)
  let rejectedShape = false
  try { captured.projection.stateSchema.parse(null) } catch { rejectedShape = true }
  check('(k) the state schema rejects a non-object', rejectedShape)
}

{
  const h = createControlHarness({ value: { long: false, budgetMs: null } })
  apply(h.ctx, {})
  await settleControl()
  const agent = createAgent()
  const run = (rawInput) => h.captured.command.handler({ agent, rawInput })
  check('(k) /guard reports the folded state', run('').kind === 'success' && run('').text.includes('long-thinking off'), run('').text)

  // `command/run` is appended before the handler runs, so the projection has
  // already folded this invocation. The mock publishes that post-fold state;
  // a toggle must be reported as-is, never applied a second time.
  h.setValue({ long: true, budgetMs: null })
  check('(k) a toggle reports the post-fold state instead of flipping back', run(' long').text.includes('long-thinking on'), run(' long').text)
  check('(k) /guard long on reports the post-fold state', run(' long on').text.includes('long-thinking on'), run(' long on').text)
  h.setValue({ long: false, budgetMs: 15000 })
  check('(k) /guard budget fast reports the preset value', run(' budget fast').text.includes('15000 ms'), run(' budget fast').text)
  h.setValue({ long: false, budgetMs: null })
  check('(k) /guard reset reports the default budget', run(' reset').text.includes('default'), run(' reset').text)

  const bad = run(' explode')
  check('(k) an unknown argument is a command error', bad.kind === 'error' && bad.text.includes('explode'), JSON.stringify(bad))
}

{
  // D2: the status line must name the resolved Config.budgetMs, not the schema default.
  const h = createControlHarness({ value: { long: false, budgetMs: null } })
  apply(h.ctx, { budgetMs: 90000 })
  await settleControl()
  const agent = createAgent()
  const run = (rawInput) => h.captured.command.handler({ agent, rawInput })
  check('(k) the status line names the configured default, not the schema default',
    run('').text.includes('default (90000 ms)'), run('').text)
  h.setValue({ long: true, budgetMs: null })
  check('(k) budget default reports the configured default and keeps long-thinking',
    run(' budget default').text.includes('long-thinking on') && run(' budget default').text.includes('default (90000 ms)'),
    run(' budget default').text)
}

{
  const h = createControlHarness({ value: { long: true, budgetMs: 0 } })
  apply(h.ctx, { budgetMs: 0, minReasoningChars: 0, cooldownMs: 0 })
  await settleControl()
  const agent = createAgent()
  longReasoningAttempt(h, agent)
  check('(k) long-thinking suppresses the interruption', countOf(agent, 'cancel') === 0, `got ${countOf(agent, 'cancel')}`)
}

{
  const h = createControlHarness({ value: { long: false, budgetMs: 60000 } })
  apply(h.ctx, { budgetMs: 0, minReasoningChars: 0, cooldownMs: 0 })
  await settleControl()
  const agent = createAgent()
  longReasoningAttempt(h, agent)
  check('(k) a larger per-conversation budget suppresses the interruption', countOf(agent, 'cancel') === 0, `got ${countOf(agent, 'cancel')}`)
}

{
  const h = createControlHarness({ value: { long: false, budgetMs: 0 } })
  apply(h.ctx, { budgetMs: 60000, minReasoningChars: 0, cooldownMs: 0 })
  await settleControl()
  const agent = createAgent()
  longReasoningAttempt(h, agent)
  check('(k) a zero per-conversation budget fires against the configured one', countOf(agent, 'cancel') === 1, `got ${countOf(agent, 'cancel')}`)
}

{
  const h = createControlHarness({ value: () => { throw new Error('unfoldable session') } })
  apply(h.ctx, { budgetMs: 0, minReasoningChars: 0, cooldownMs: 0 })
  await settleControl()
  const agent = createAgent()
  longReasoningAttempt(h, agent)
  check('(k) an unfoldable session falls back to the configured budget', countOf(agent, 'cancel') === 1, `got ${countOf(agent, 'cancel')}`)
}

{
  const h = createControlHarness({ registerFails: true })
  apply(h.ctx, { budgetMs: 0, minReasoningChars: 0, cooldownMs: 0 })
  await settleControl()
  const agent = createAgent()
  longReasoningAttempt(h, agent)
  check('(k) a refused control registration still guards on the configured budget', countOf(agent, 'cancel') === 1, `got ${countOf(agent, 'cancel')}`)
  check('(k) the refused registration is reported', h.reports.some(r => r.includes('per-conversation control unavailable')), JSON.stringify(h.reports))
}

{
  // D5: the projection registers, then the command layer fails. The handle must
  // stay uninstalled, so the guard ignores the projection the user cannot write.
  const h = createControlHarness({ value: { long: true, budgetMs: null }, commandRegisterFails: true })
  apply(h.ctx, { budgetMs: 0, minReasoningChars: 0, cooldownMs: 0 })
  await settleControl()
  const agent = createAgent()
  longReasoningAttempt(h, agent)
  check('(k) a failed command registration leaves the projection unread even when it says long', countOf(agent, 'cancel') === 1, `got ${countOf(agent, 'cancel')}`)
  check('(k) the failed command layer is reported separately',
    h.reports.some(r => r.includes('/guard command unavailable')), JSON.stringify(h.reports))
  check('(k) the projection layer is not reported as unavailable',
    !h.reports.some(r => r.includes('per-conversation control unavailable')), JSON.stringify(h.reports))
}

{
  // The browser half is a module-loader factory, not an importable module:
  // execute it against a stubbed loader and drive its registration and control.
  const loaded = []
  globalThis.window = { __ModuleLoader__: { load: entry => loaded.push(entry) } }
  try {
    await import('../client.js?control-test')
  } finally {
    delete globalThis.window
  }
  check('(k) the client factory registers exactly one loader entry', loaded.length === 1, String(loaded.length))
  const entry = loaded[0]
  check('(k) the client factory id equals the package name', entry?.id === 'dsh-deliberation-guard', String(entry?.id))

  let slot = undefined
  const localeRegistrations = []
  const clientEffects = []
  const styleElements = []
  const previousDocument = globalThis.document
  globalThis.document = {
    head: { append: element => styleElements.push(element) },
    createElement: () => ({
      textContent: '',
      remove() { const at = styleElements.indexOf(this); if (at >= 0) styleElements.splice(at, 1) },
    }),
  }
  const fakeReact = { createElement: (type, props, children) => ({ type, props: props ?? {}, children }) }
  const clientPlugin = entry.factory(name => (name === 'react' ? fakeReact : undefined))
  const clientCtx = {
    effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') clientEffects.push(cleanup); return cleanup },
    locale: { register: (ns, dicts) => { localeRegistrations.push([ns, dicts]); return () => {} } },
    sessions: {
      binding: () => undefined,
      subagentAddress: () => undefined,
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (options, component) => { slot = { options, component }; return () => {} },
    },
  }
  clientPlugin.apply(clientCtx)
  check('(k) one plugin load installs exactly one stylesheet', styleElements.length === 1, String(styleElements.length))
  check('(k) the client registers into conversation.input.right', slot?.options?.name === 'conversation.input.right', String(slot?.options?.name))
  check('(k) the client registration declares the locale namespace', slot?.options?.locale === 'deliberation.guard', String(slot?.options?.locale))
  check('(k) the client registers its dictionaries under the slot namespace',
    localeRegistrations.length === 1 && localeRegistrations[0][0] === 'deliberation.guard'
      && localeRegistrations[0][1].zh['long.label'] === '长思考' && localeRegistrations[0][1].en['long.label'] === 'Long thinking',
    JSON.stringify(localeRegistrations.map(r => r[0])))

  const face = slot.options.inject('session-1')
  check('(k) the slot inject factory returns an observable face without throwing', typeof face?.hooks?.guard?.getSnapshot === 'function')
  check('(k) the missing binding yields an inert observable', face.hooks.guard.getSnapshot() === undefined)

  const throwingCtx = {
    ...clientCtx,
    sessions: { binding: () => { throw new Error('not materialized') } },
  }
  clientPlugin.apply(throwingCtx)
  let safe = undefined
  try { safe = slot.options.inject('session-2') } catch { safe = undefined }
  check('(k) the slot inject factory never throws on an unmaterialized session', safe !== undefined && typeof safe?.hooks?.guard?.getSnapshot === 'function')

  const element = slot.component({ t: key => key, useGuard: select => select({ long: true, budgetMs: null }), submit: () => {} })
  check('(k) the control renders a chip row with both settings', element !== null && element.props.className === 'dg-guard' && element.children.length === 2, JSON.stringify(element?.children?.length))
  check('(k) the budget picker is inert while long thinking is on', element.children[1].props.disabled === true)
  check('(k) the toggle reports its pressed state', element.children[0].props['aria-pressed'] === true)
  check('(k) both elements carry the host chip classes', element.children[0].props.className === 'dg-toggle' && element.children[1].props.className === 'dg-select')

  const relaxed = slot.component({ t: key => key, useGuard: select => select({ long: false, budgetMs: 30000 }), submit: () => {} })
  check('(k) the budget picker is enabled with long thinking off', relaxed.children[1].props.disabled === false)
  check('(k) the picker reflects the pushed budget', relaxed.children[1].props.value === '30000', String(relaxed.children[1].props.value))
  const bare = slot.component({ t: key => key, useGuard: () => undefined, submit: () => {} })
  check('(k) the control shows the host default before the projection arrives', bare.children[1].props.value === 'default', String(bare.children[1].props.value))
  const unwritable = slot.component({ t: key => key, useGuard: () => undefined, submit: undefined })
  check('(k) the control renders nothing without a write path', unwritable === null)

  // D1: the Default row must CLEAR the override; the client must not duplicate
  // the host's configured default, which it cannot know.
  const submitted = []
  const writable = slot.component({
    t: key => key, useGuard: select => select({ long: false, budgetMs: 30000 }), submit: line => submitted.push(line),
  })
  const writableSelect = writable.children[1]
  writableSelect.props.onChange({ target: { value: 'default' } })
  check('(k) the Default row clears the override instead of pinning a value', submitted[0] === '/guard budget default', String(submitted[0]))
  writableSelect.props.onChange({ target: { value: '120000' } })
  check('(k) a preset row submits its milliseconds', submitted[1] === '/guard budget 120000', String(submitted[1]))
  writableSelect.props.onChange({ target: { value: '90000' } })
  check('(k) the 90s preset row submits its milliseconds', submitted[2] === '/guard budget 90000', String(submitted[2]))
  const presetRows = writableSelect.children.map(option => option.props.value)
  check('(k) the picker offers the 90s preset', presetRows.includes('90000'), JSON.stringify(presetRows))

  // The chrome copies the host composer's own chips rule-for-rule instead of
  // inventing a shape, so the control is indistinguishable from its neighbours.
  // Each check below pins one property of that copy.
  const css = styleElements[0]?.textContent ?? ''
  check('(k) every rule is scoped under .dg-', css.includes('.dg-guard') && !/(^|})\s*(button|select)\s*\{/.test(css))
  check('(k) the chip chrome matches the composer model trigger', css.includes('height:28px') && css.includes('border-radius:var(--dsw-radius-sm)') && css.includes('background:transparent') && css.includes('font-size:13px') && css.includes('line-height:20px'))
  check('(k) no capsule border or fill was invented', !css.includes('border:0.5px solid') && !css.includes('background:var(--dsw-specific-selector)'))
  check('(k) no off-scale radius survives', !css.includes('border-radius:6px'))
  check('(k) hover uses the host interactive fill', css.includes('.dg-toggle:hover:not(:disabled)') && css.includes('.dg-select:hover:not(:disabled)') && css.includes('var(--dsw-alias-interactive-bg-hover)'))
  check('(k) focus uses the host focus ring token', css.includes('var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))'))
  check('(k) the pressed state follows the host Pill.active treatment', css.includes('--dsw-alias-button-ghost-active-fill') && css.includes('inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)'))
  check('(k) the native select chrome is reset and the host chevron is drawn', css.includes('appearance:none') && css.includes('background-image:url("data:image/svg+xml,'))
  check('(k) disabled matches the host opacity treatment', css.includes('opacity:0.5'))
  check('(k) the row gap is the host 12px, collapsing to 8px in the host container query', css.includes('gap:12px') && css.includes('@container (max-width:560px)') && css.includes('gap:8px'))
  check('(k) the stylesheet is removed when the plugin unloads', (() => { for (const cleanup of clientEffects) cleanup(); return styleElements.length === 0 })())
  if (previousDocument === undefined) delete globalThis.document
  else globalThis.document = previousDocument
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  check('(k) client.js carries no duplicated host default constant', !clientSource.includes('DEFAULT_BUDGET_MS'))
  check('(k) client.js never submits a hardcoded millisecond default', !/budget 45000/u.test(clientSource))

  // D3: a subagent session must not get an enabled control whose writes are dropped.
  const subagentCtx = {
    ...clientCtx,
    sessions: { binding: () => undefined, subagentAddress: () => 'subagent:one' },
  }
  clientPlugin.apply(subagentCtx)
  const subagentFace = slot.options.inject('session-subagent')
  check('(k) a subagent session gets no write path', subagentFace !== undefined && typeof subagentFace.submit !== 'function', typeof subagentFace?.submit)
  check('(k) the subagent control renders nothing',
    slot.component({ t: key => key, useGuard: () => undefined, submit: subagentFace.submit }) === null)

  // The catch arm must also hide the control, not offer a dead write path.
  clientPlugin.apply(throwingCtx)
  const thrownFace = slot.options.inject('session-3')
  check('(k) the caught unmaterialized session gets no write path',
    thrownFace !== undefined && typeof thrownFace.submit !== 'function', typeof thrownFace?.submit)
  check('(k) the caught session control renders nothing',
    slot.component({ t: key => key, useGuard: () => undefined, submit: thrownFace.submit }) === null)
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('failed checks:')
  for (const label of failures) console.log(`  - ${label}`)
}
process.exitCode = failed === 0 ? 0 : 1
