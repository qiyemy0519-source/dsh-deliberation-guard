/**
 * Deliberation-budget guard: interrupt a step that spends its whole budget on
 * pure reasoning and nudge the model to answer with what it already knows.
 *
 * Plain ESM, no build step. The mechanism is the one a person already performs
 * by hand mid-thought: cancel the running activity and put a new instruction in
 * front of the model. The behavioral reference is the "answer now" control in
 * the third-party plugin `dsh-rhine-splash`, which cancels the running session
 * and then prompts again.
 *
 * Nothing here touches the model's reasoning effort or context window: the
 * guard only reacts to what the model already emitted.
 */

import { randomUUID } from 'node:crypto'

/** Cordis plugin name; the `cordis.patch.yml` row id matches it. */
export const name = 'deliberation-guard'

/** No required services: the guard listens to an event and logs. */
export const inject = []

/** Field defaults, declared on the schema below and re-applied in `apply` when no schema is available. */
const DEFAULTS = Object.freeze({
  enabled: true,
  budgetMs: 45000,
  minReasoningChars: 2000,
  cooldownMs: 30000,
  includeSubagents: false,
  nudge: '跳过思考，直接用已知信息作答，不要再推演。',
})

/**
 * Message-source kind stamped on every nudge. A producer-owned kind, not
 * `user`: the transcript must show that the harness interrupted the step rather
 * than a person typing, and the source vocabulary is merge-extensible, so a
 * kind this UI version does not know still renders as labelled context.
 */
const SOURCE_KIND = 'deliberation-guard'

/** Bound on the notice summary, matching dsh-llm's CONTEXT_SUMMARY_MAX_CHARS. */
const SUMMARY_MAX_CHARS = 120

let z
try {
  z = (await import('@deepseek-ai/schemastery')).default
} catch {
  // schemastery is an optional peer dependency: a profile that does not provide
  // it leaves `Config` undefined, cordis then passes the raw config straight to
  // apply(), and apply() applies the same defaults and the same fail-loud checks.
  z = undefined
}

/**
 * Validated config schema. The settings UI renders these fields with their
 * defaults and descriptions; `apply` re-validates every one of them so the
 * plugin behaves identically with and without schemastery.
 */
export const Config = z === undefined ? undefined : z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).description('是否启用自动打断'),
  budgetMs: z.number().min(0).default(DEFAULTS.budgetMs).description('单步纯思考预算（毫秒）'),
  minReasoningChars: z.number().min(0).default(DEFAULTS.minReasoningChars).description('触发所需的最少思考字符数'),
  cooldownMs: z.number().min(0).default(DEFAULTS.cooldownMs).description('两次打断之间的冷却（毫秒）'),
  includeSubagents: z.boolean().default(DEFAULTS.includeSubagents).description('是否也保护子代理'),
  nudge: z.string().default(DEFAULTS.nudge).description('打断后注入的提示词'),
})

/** One-line type name for a rejected config value. */
function describeValue(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

/** Read an optional boolean field, failing loud on any other type. */
function readBoolean(source, key, fallback) {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new Error(`${name}: config \`${key}\` must be a boolean, got ${describeValue(value)}`)
  }
  return value
}

/** Read an optional finite number field with a lower bound, failing loud otherwise. */
function readNumber(source, key, fallback, { min, integer = false }) {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name}: config \`${key}\` must be a finite number, got ${describeValue(value)}`)
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`${name}: config \`${key}\` must be an integer, got ${value}`)
  }
  if (value < min) {
    throw new Error(`${name}: config \`${key}\` must be >= ${min}, got ${value}`)
  }
  return value
}

/** Read an optional non-empty string field, failing loud otherwise. */
function readString(source, key, fallback) {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name}: config \`${key}\` must be a non-empty string, got ${describeValue(value)}`)
  }
  return value
}

/**
 * Resolve every config field against {@link DEFAULTS}.
 * @param raw - config as cordis delivered it, after schema validation when a schema exists.
 * @returns a frozen complete config.
 * @throws {Error} on a field of the wrong type or outside its bounds (misconfiguration fails at load).
 */
function resolveConfig(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new Error(`${name}: config must be an object, got ${describeValue(raw)}`)
  }
  const source = raw ?? {}
  return Object.freeze({
    enabled: readBoolean(source, 'enabled', DEFAULTS.enabled),
    budgetMs: readNumber(source, 'budgetMs', DEFAULTS.budgetMs, { min: 0 }),
    minReasoningChars: readNumber(source, 'minReasoningChars', DEFAULTS.minReasoningChars, { min: 0, integer: true }),
    cooldownMs: readNumber(source, 'cooldownMs', DEFAULTS.cooldownMs, { min: 0 }),
    includeSubagents: readBoolean(source, 'includeSubagents', DEFAULTS.includeSubagents),
    nudge: readString(source, 'nudge', DEFAULTS.nudge),
  })
}

/** Render an unknown thrown value as one readable line. */
function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Report a contained guard failure. The logger is optional infrastructure, so a
 * logger that throws falls back to the console instead of escaping into the
 * model stream the guard is observing.
 */
function report(ctx, message) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : undefined
    if (logger !== undefined && typeof logger.warn === 'function') {
      logger.warn(message)
      return
    }
  } catch {
    // Optional logger: the console fallback below is the report of record.
  }
  console.warn(`[${name}] ${message}`)
}

/**
 * Whether an agent is a subagent. Mirrors `delegationDepthOf` from
 * `@deepseek-ai/dsh-subagent/depth` without importing it: the persisted session
 * header is authoritative and monotone, and the runtime `AgentOptions.subagentDepth`
 * may only deepen the count, never lower it.
 */
function isSubagent(agent) {
  const header = agent?.session?.header
  const headerDepth = typeof header?.delegationDepth === 'number' && header.delegationDepth > 0
  const headerOrigin = header?.origin === 'subagent'
  const runtimeDepth = agent?.options?.subagentDepth
  const deepened = typeof runtimeDepth === 'number' && runtimeDepth > 0
  return headerDepth || headerOrigin || deepened
}

/** Whether a fragment carries reader-visible text, matching dsh-llm's `chunkHasVisibleText`. */
function hasNonWhitespace(text) {
  return typeof text === 'string' && /\S/.test(text)
}

/**
 * Build the steering message. Reproduces exactly what `createUserMessage` from
 * `@deepseek-ai/dsh-llm` produces — a frozen user-role message with a fresh
 * uuid identity — without importing that package, which is not resolvable from
 * a `link:`-installed plugin directory.
 * @param text - model-facing nudge text.
 * @param summary - one-line account shown in the transcript row.
 * @returns the frozen user message to steer.
 */
function createNudgeMessage(text, summary) {
  const bounded = summary.length <= SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…`
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: SOURCE_KIND, form: 'notice', summary: bounded }),
  })
}

/**
 * Fold one stream chunk into an attempt's evidence: how much pure reasoning it
 * has emitted, and whether it has started answering or acting.
 * @param attempt - the mutable per-step attempt record.
 * @param chunk - one `StreamChunk` from a chunk frame.
 */
function accumulate(attempt, chunk) {
  if (chunk === null || typeof chunk !== 'object') return
  switch (chunk.type) {
    case 'reasoning-delta':
      if (typeof chunk.text === 'string') attempt.reasoningChars += chunk.text.length
      return
    case 'text-delta':
      if (hasNonWhitespace(chunk.text)) attempt.hasText = true
      return
    case 'tool-call-delta':
      attempt.hasToolCall = true
      return
    case 'block-start':
      if (chunk.blockType === 'text') attempt.hasText = true
      else if (chunk.blockType === 'tool-call') attempt.hasToolCall = true
      return
    case 'block-end': {
      const block = chunk.block
      if (block === null || typeof block !== 'object') return
      if (block.type === 'text' && hasNonWhitespace(block.text)) attempt.hasText = true
      else if (block.type === 'tool-call') attempt.hasToolCall = true
      return
    }
    default:
      return
  }
}

/**
 * Install the guard's stream listener.
 * @param ctx - plugin context; the listener is registered through `ctx.on`, so
 *   unloading the plugin removes it and no per-agent state outlives the fiber.
 * @param config - raw config; validated here, failing loud at load.
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config)

  // Per-agent observation state. A WeakMap keeps one entry per live agent and
  // lets both the attempt record and the cooldown die with the agent.
  const agents = new WeakMap()

  /** Read or create one agent's state. */
  function stateFor(agent) {
    let state = agents.get(agent)
    if (state === undefined) {
      state = { attempt: undefined, cooldownUntil: 0 }
      agents.set(agent, state)
    }
    return state
  }

  /**
   * Cancel the running activity and steer the nudge. Both calls are contained
   * separately: a failing cancel must still leave the nudge delivered, and
   * neither failure may escape into the stream.
   */
  function interrupt(agent, attempt) {
    const where = `turn ${attempt.turn} step ${attempt.step}`
    try {
      // `keepInbox` is load-bearing: without it AgentLoop.cancel() clears the
      // inbox, so an autonomous interruption would silently discard work a
      // person queued while the model was deliberating. The active turn is
      // still aborted, and the steer below reclassifies to the next turn and
      // latches its wake, so the nudge is delivered either way.
      agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (error) {
      report(ctx, `cancel() failed for ${where}; the nudge is still delivered: ${describeError(error)}`)
    }
    try {
      agent.steer(createNudgeMessage(
        settings.nudge,
        `deliberation budget exceeded (${where}, ${attempt.reasoningChars} reasoning chars)`,
      ))
    } catch (error) {
      report(ctx, `steer() failed for ${where}: ${describeError(error)}`)
    }
  }

  /** Fire at most once per attempt, and only when every configured condition holds. */
  function maybeFire(agent, state, attempt) {
    if (!settings.enabled) return
    if (attempt.fired) return
    if (attempt.hasText || attempt.hasToolCall) return
    if (attempt.reasoningChars < settings.minReasoningChars) return
    const now = Date.now()
    if (now - attempt.startedAt < settings.budgetMs) return
    if (now < state.cooldownUntil) return
    if (!settings.includeSubagents && isSubagent(agent)) return
    // Claim the attempt and start the cooldown before acting, so a frame that
    // arrives while cancel/steer run cannot fire a second time.
    attempt.fired = true
    state.cooldownUntil = now + settings.cooldownMs
    interrupt(agent, attempt)
  }

  /**
   * Advance the guard for one stream frame. Chunk frames carry no turn or step,
   * so the attempt opened by the `start` frame is the only source of both.
   */
  function observe(agent, frame) {
    if (agent === null || typeof agent !== 'object') return
    if (frame === null || typeof frame !== 'object') return
    const state = stateFor(agent)
    switch (frame.type) {
      case 'start':
        state.attempt = {
          attemptId: frame.attemptId,
          turn: frame.turn,
          step: frame.step,
          startedAt: Date.now(),
          reasoningChars: 0,
          hasText: false,
          hasToolCall: false,
          fired: false,
        }
        return
      case 'end':
        if (state.attempt !== undefined && state.attempt.attemptId === frame.attemptId) state.attempt = undefined
        return
      case 'chunk':
        break
      default:
        return
    }
    const attempt = state.attempt
    if (attempt === undefined || attempt.attemptId !== frame.attemptId) return
    accumulate(attempt, frame.chunk)
    maybeFire(agent, state, attempt)
  }

  ctx.on('agent/assistant-stream', (payload) => {
    try {
      if (payload === null || typeof payload !== 'object') return
      observe(payload.agent, payload.frame)
    } catch (error) {
      // A listener must never throw into the model stream: the failure is
      // contained here and reported, never propagated into the attempt it observes.
      report(ctx, `assistant-stream observation failed: ${describeError(error)}`)
    }
  })
}
