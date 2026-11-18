/**
 * Deliberation-guard browser half: the per-conversation long-thinking switch and
 * the patience-budget picker in the composer tool row.
 *
 * Plain ESM, no build step: the module loader calls this factory lazily and React
 * comes from the browser module table. Every write submits the host `/guard`
 * command, so the session log stays the single source of truth; the projection
 * push is the only confirmation this component renders. Nothing here reaches
 * `ctx.remote` or another plugin's internals.
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

    /** Shared chrome for both controls, drawn from the host theme aliases. */
    const BASE_CONTROL = {
      height: 28,
      padding: '0 8px',
      border: '0.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 6,
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      font: 'inherit',
      fontSize: 12,
      lineHeight: 1,
      cursor: 'pointer',
    }

    /**
     * One compact composer control: the long-thinking toggle plus the patience
     * budget picker. The picker stays visible but inert while long thinking is on,
     * so the two facts remain legible together.
     * @param props - renderer-derived props: `t`, `useGuard`, and `submit`.
     * @returns the control element, or `null` when neither capability resolves.
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

      return h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 6 },
        title: t('control.title'),
      }, [
        h('button', {
          key: 'long',
          type: 'button',
          onClick: toggleLong,
          'aria-pressed': long,
          title: long ? t('long.on.hint') : t('long.off.hint'),
          style: long
            ? {
              ...BASE_CONTROL,
              background: 'var(--dsw-alias-button-primary-fill)',
              color: 'var(--dsw-alias-label-primary-inverted)',
              borderColor: 'var(--dsw-alias-border-selected)',
            }
            : BASE_CONTROL,
        }, t('long.label')),
        h('select', {
          key: 'budget',
          value: budgetMs === null ? 'default' : String(budgetMs),
          onChange: pickBudget,
          disabled: long,
          'aria-label': t('budget.label'),
          title: long ? t('budget.inert.hint') : t('budget.label'),
          style: long ? { ...BASE_CONTROL, opacity: 0.45, cursor: 'default' } : BASE_CONTROL,
        }, [
          h('option', { key: 'default', value: 'default' }, t('budget.default')),
          ...BUDGET_PRESETS.map(([label, ms]) => h('option', {
            key: label, value: String(ms),
          }, `${label} ${Math.round(ms / 1000)}s`)),
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
