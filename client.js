/**
 * Deliberation-guard browser half: one compact capsule in the composer tool row
 * holding the per-conversation long-thinking toggle and the patience-budget
 * picker, so the two settings read as one feature.
 *
 * Plain ESM, no build step: the module loader calls this factory lazily and React
 * comes from the browser module table. Every write submits the host `/guard`
 * command, so the session log stays the single source of truth; the projection
 * push is the only confirmation this component renders. Nothing here reaches
 * `ctx.remote` or another plugin's internals.
 *
 * The chrome is built only from host theme tokens and host scales, and it is
 * installed as a scoped stylesheet rather than inline styles, because the design
 * needs `:hover`, `:disabled` and `prefers-reduced-motion` states that inline
 * styles cannot express.
 *
 * The slot registration's `inject` factory NEVER throws: DSH retires a slot
 * entry whose factory throws for every later session too, so a session without a
 * projection binding falls back to an inert observable and the host default.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deliberation-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace for this control's copy. */
    const NS = 'deliberation.guard'
    /** Projection key the host half folds `/guard` records into. */
    const CONTROL_KEY = 'deliberationGuard'
    /** Budget presets the picker offers; each value is milliseconds. */
    const BUDGET_PRESETS = [['fast', 15000], ['normal', 45000], ['slow', 90000], ['patient', 120000]]
    /** Observable source used when no session projection is available. */
    const NO_PROJECTION = Object.freeze({
      subscribe: () => () => {},
      getSnapshot: () => undefined,
    })

    const zh = {
      'long.label': '长思考',
      'long.on.hint': '长思考已开启：本会话不会被自动打断',
      'long.off.hint': '长思考已关闭：恢复自动打断',
      'budget.label': '耐心预算',
      'budget.default': '默认',
      'budget.inert.hint': '长思考开启时，耐心预算不生效',
      'control.title': '按会话的思考守卫控制',
    }
    const en = {
      'long.label': 'Long thinking',
      'long.on.hint': 'Long thinking on: this conversation is never interrupted',
      'long.off.hint': 'Long thinking off: automatic interruption restored',
      'budget.label': 'Patience budget',
      'budget.default': 'Default',
      'budget.inert.hint': 'The patience budget is inert while long thinking is on',
      'control.title': 'Per-conversation deliberation guard',
    }

    /**
     * Control chrome, scoped under `.dg-` and built only from host theme tokens.
     * Every value is on a host scale: radius `--dsw-radius-sm` (8px, the host's
     * compact-control radius), the 12px/18px compact type step, 4px/8px spacing,
     * and `background-color 100ms` for state changes. The resting fill is
     * `--dsw-specific-selector` rather than `--dsw-alias-bg-layer-2`, because the
     * latter resolves to the same value as the composer card in both themes and
     * would leave the control without a visible body.
     */
    const CONTROL_CSS = `
.dg-guard{display:inline-flex;align-items:stretch;height:28px;flex:none;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-specific-selector)}
.dg-guard>*+*{border-left:0.5px solid var(--dsw-alias-border-l3)}
.dg-guard button,.dg-guard select{appearance:none;-webkit-appearance:none;border:0;background:transparent;margin:0;height:100%;padding:0 8px;display:inline-flex;align-items:center;gap:4px;font-family:inherit;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background-color 100ms var(--ds-ease-in-out,cubic-bezier(0.4,0,0.2,1)),color 100ms var(--ds-ease-in-out,cubic-bezier(0.4,0,0.2,1))}
.dg-guard button:hover,.dg-guard select:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dg-guard button[aria-pressed="true"]{background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-button-ghost-active-border)}
.dg-guard button[aria-pressed="true"]:hover{background:var(--dsw-alias-button-ghost-active-fill)}
.dg-dot{width:6px;height:6px;flex:none;border:1.25px solid currentColor;border-radius:999px;box-sizing:border-box}
.dg-guard button[aria-pressed="true"] .dg-dot{background:currentColor}
.dg-budget{display:inline-flex;align-items:center}
.dg-select{padding-right:4px}
.dg-guard select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dg-guard select:disabled:hover{background:transparent;color:var(--dsw-alias-label-tertiary)}
.dg-chev{width:12px;height:12px;flex:none;margin-left:-6px;pointer-events:none}
@media (prefers-reduced-motion:reduce){.dg-guard button,.dg-guard select{transition:none}}
`

    /**
     * One compact composer control: a single capsule holding the long-thinking
     * toggle and the patience-budget picker, so the two settings read as one
     * feature instead of two unrelated widgets. The picker stays visible but
     * inert while long thinking is on, keeping both facts legible together.
     * @param props - renderer-derived props: `t`, `useGuard`, and `submit`.
     * @returns the control element, or `null` when no write path resolves.
     */
    function GuardControl(props) {
      const t = props.t
      const state = props.useGuard(snapshot => snapshot)
      const submit = props.submit
      if (typeof submit !== 'function') return null
      const long = state?.long === true
      const budgetMs = typeof state?.budgetMs === 'number' ? state.budgetMs : null

      const toggleLong = () => { submit(long ? '/guard long off' : '/guard long on') }
      const pickBudget = (event) => {
        const value = event.target.value
        // The Default row must CLEAR the override, never pin the current host
        // default: this component cannot know `Config.budgetMs`.
        submit(value === 'default' ? '/guard budget default' : `/guard budget ${value}`)
      }

      return h('span', { className: 'dg-guard', title: t('control.title') }, [
        h('button', {
          key: 'long',
          type: 'button',
          onClick: toggleLong,
          'aria-pressed': long,
          title: long ? t('long.on.hint') : t('long.off.hint'),
        }, [
          h('span', { key: 'dot', className: 'dg-dot' }),
          t('long.label'),
        ]),
        h('span', { key: 'budget', className: 'dg-budget' }, [
          h('select', {
            key: 'select',
            className: 'dg-select',
            value: budgetMs === null ? 'default' : String(budgetMs),
            onChange: pickBudget,
            disabled: long,
            'aria-label': t('budget.label'),
            title: long ? t('budget.inert.hint') : t('budget.label'),
          }, [
            h('option', { key: 'default', value: 'default' }, t('budget.default')),
            ...BUDGET_PRESETS.map(([label, ms]) => h('option', {
              key: label, value: String(ms),
            }, `${label} ${Math.round(ms / 1000)}s`)),
          ]),
          h('svg', {
            key: 'chev',
            className: 'dg-chev',
            viewBox: '0 0 12 12',
            fill: 'none',
            'aria-hidden': true,
          }, h('path', {
            d: 'M3 4.5 6 7.5 9 4.5',
            stroke: 'currentColor',
            strokeWidth: 1.25,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })),
        ]),
      ])
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      /**
       * Register the locale dictionaries and the composer control.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deliberation-guard: locale dictionaries')

        // Component-local stylesheet: installed once per plugin load and removed on
        // unload, so nothing outlives the fiber and no session duplicates it. A
        // host without a document (a non-browser embedding) skips it and keeps the
        // control functional, just unstyled.
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined
          const style = document.createElement('style')
          style.textContent = CONTROL_CSS
          document.head.append(style)
          return () => { style.remove() }
        }, 'deliberation-guard: control styles')

        const sessions = ctx.sessions
        const submit = (sessionId, line) => {
          try {
            const live = sessions.binding(sessionId)?.session
            if (live === undefined) return
            // The host command is the only write path: its own settlement is the
            // confirmation, so a rejected line must leave the control unchanged.
            const settled = live.command(line)
            if (settled !== undefined && typeof settled.catch === 'function') settled.catch(() => {})
          } catch {
            // A session that cannot accept the line keeps showing the pushed value.
          }
        }

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'deliberation-guard',
          order: 20,
          locale: NS,
          inject: (sessionId) => {
            try {
              // A subagent has no composer of its own to write from, so it gets no
              // control at all: omitting `submit` makes GuardControl render nothing
              // instead of an enabled control whose writes are silently dropped.
              if (typeof sessions.subagentAddress === 'function' && sessions.subagentAddress(sessionId) !== undefined) {
                return { hooks: { guard: NO_PROJECTION } }
              }
              const face = sessions.binding(sessionId)?.session?.projections?.faceOf(CONTROL_KEY)
              return {
                hooks: { guard: face === undefined ? NO_PROJECTION : face },
                submit: line => submit(sessionId, line),
              }
            } catch {
              return { hooks: { guard: NO_PROJECTION } }
            }
          },
        }, GuardControl))
      },
    }
  },
})
