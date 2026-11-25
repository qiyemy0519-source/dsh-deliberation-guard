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
     * Control chrome, copied rule-for-rule from the host composer's own chips so
     * this control is indistinguishable from them: the model-selection trigger
     * (`ui-model-selection/src/client/ModelSelect.module.css` `.trigger`) supplies
     * the chip chrome, hover and focus ring, and the composer's `.select`
     * (`ui-conversation/src/client/skeleton/InputBar.module.css`) supplies the
     * native-select reset and its drawn chevron. The selected state follows the
     * host `Pill.active` treatment. The host's global reset already gives form
     * controls the app font (`client/web/src/base.css`), so no family is set here.
     */
    const CONTROL_CSS = `
.dg-guard{display:inline-flex;align-items:center;gap:12px;min-width:0}
.dg-toggle{display:inline-flex;align-items:center;gap:4px;min-width:0;height:28px;padding:0 8px;border:none;border-radius:var(--dsw-radius-sm);outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:400;white-space:nowrap;cursor:pointer}
.dg-toggle[aria-pressed="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-ghost-active-fill);box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}
.dg-toggle:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dg-toggle[aria-pressed="true"]:focus-visible{box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border),0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dg-toggle:disabled{opacity:0.5;cursor:default}
.dg-select{max-width:220px;height:28px;padding:0 20px 0 8px;border:none;border-radius:var(--dsw-radius-sm);outline:none;background-color:transparent;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 4px center;background-size:12px 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:400;white-space:nowrap;cursor:pointer;appearance:none}
.dg-select:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dg-select:disabled{opacity:0.5;cursor:default}
@media (hover:hover){.dg-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dg-select:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover)}}
@container (max-width:560px){.dg-guard{gap:8px}}
`

    /**
     * The composer control: the long-thinking toggle and the patience-budget
     * picker, rendered as two host chips in a plain flex row — the same chrome,
     * height, radius, type step and gap the composer's own controls use. The
     * picker stays visible but disabled while long thinking is on, keeping both
     * facts legible together.
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
          className: 'dg-toggle',
          onClick: toggleLong,
          'aria-pressed': long,
          title: long ? t('long.on.hint') : t('long.off.hint'),
        }, t('long.label')),
        h('select', {
          key: 'budget',
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
