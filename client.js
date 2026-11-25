/**
 * Deliberation-guard browser half: two host-style menu chips in the composer
 * tool row — the per-conversation long-thinking mode and the patience budget.
 *
 * Plain ESM, no build step: the module loader calls this factory lazily and React
 * plus react-dom come from the browser module table. Every write submits the host
 * `/guard` command, so the session log stays the single source of truth; the
 * projection push is the only confirmation this component renders, and the menu
 * holds no value of its own.
 *
 * The chrome is built only from host theme tokens and host scales, and it is
 * installed as a scoped stylesheet rather than inline styles, because the design
 * needs `:hover`, `:focus-visible`, `:disabled` and anchored positioning that
 * inline styles cannot express.
 *
 * The slot registration's `inject` factory NEVER throws: DSH retires a slot
 * entry whose factory throws for every later session too, so a session without a
 * projection binding falls back to an inert observable and the host default.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deliberation-guard',
  factory(require) {
    const React = require('react')
    const reactDom = require('react-dom')
    const h = React.createElement
    const useEffect = React.useEffect
    const useId = React.useId
    const useRef = React.useRef
    const useState = React.useState

    /** Locale namespace for this control's copy. */
    const NS = 'deliberation.guard'
    /** Projection key the host half folds `/guard` records into. */
    const CONTROL_KEY = 'deliberationGuard'
    /** Budget presets the picker offers, in milliseconds; the value is the row id. */
    const BUDGET_PRESETS = [15000, 45000, 90000, 120000]
    /** Row id meaning "no override", so the host's configured default applies. */
    const BUDGET_DEFAULT = 'default'
    /** Mode row ids; the label of each lives in the locale dictionaries. */
    const MODE_LONG = 'long'
    const MODE_AUTO = 'auto'
    /** Observable source used when no session projection is available. */
    const NO_PROJECTION = Object.freeze({
      subscribe: () => () => {},
      getSnapshot: () => undefined,
    })

    const zh = {
      'long.label': '长思考',
      'long.control': '思考模式',
      'long.menu.label': '思考模式：{name}',
      'mode.auto': '自动打断',
      'long.on.hint': '长思考已开启：本会话不会被自动打断',
      'long.off.hint': '长思考已关闭：恢复自动打断',
      'budget.label': '耐心预算',
      'budget.menu.label': '耐心预算：{name}',
      'budget.default': '默认',
      'budget.inert.hint': '长思考开启时，耐心预算不生效',
      'control.title': '按会话的思考守卫控制',
    }
    const en = {
      'long.label': 'Long thinking',
      'long.control': 'Thinking mode',
      'long.menu.label': 'Thinking mode: {name}',
      'mode.auto': 'Auto-interrupt',
      'long.on.hint': 'Long thinking on: this conversation is never interrupted',
      'long.off.hint': 'Long thinking off: automatic interruption restored',
      'budget.label': 'Patience budget',
      'budget.menu.label': 'Patience budget: {name}',
      'budget.default': 'Default',
      'budget.inert.hint': 'The patience budget is inert while long thinking is on',
      'control.title': 'Per-conversation deliberation guard',
    }

    /**
     * Control chrome, copied rule-for-rule from the host composer's own chips and
     * menu primitive so this control is indistinguishable from them:
     * `ui-permission-presets/src/client/PermissionSelect.module.css` supplies the
     * chip chrome (`.trigger`, `.triggerLabel`, `.chevron`, `.chevronOpen`); its
     * sibling `ui-model-selection/src/client/ModelSelect.module.css` `.trigger`
     * supplies the anchor-name seat and the 400 weight the composer row uses;
     * `ui-primitives/src/Menu.module.css` supplies the portaled list card
     * (`.list`, `.portal`, `.portal[data-anchor-side='top']`, `.scrollable`,
     * `.viewport`, `.item`, `.itemLabel`, `.check`); and
     * `ui-primitives/src/MenuSurface.module.css` supplies the translucent surface
     * material with its macOS backing. The referenced `@position-try` rules keep
     * their `--dsh-menu-*` names in the host's compiled stylesheet, so the
     * fallback list below resolves against the host's own registrations. The
     * host's global reset already gives form controls the app font
     * (`client/web/src/base.css`), so no family is set here.
     */
    const CONTROL_CSS = `
.dg-guard{display:inline-flex;align-items:center;gap:12px;min-width:0}
.dg-chip{position:relative;display:inline-flex;min-width:0}
.dg-trigger{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;padding:0 4px 0 8px;border:none;border-radius:var(--dsw-radius-sm);outline:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;font-weight:400;cursor:pointer}
@media (hover:hover){.dg-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.dg-trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dg-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.dg-trigger-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dg-chevron{display:inline-flex;flex:0 0 auto;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}
.dg-chevron-open{transform:rotate(180deg)}
.dg-menu{box-sizing:border-box;position:fixed;position-area:none;--dsh-menu-window-top:max(12px,var(--dsh-frame-overlay-top,12px));top:var(--dsh-menu-window-top);bottom:max(12px,calc(anchor(top) + 4px));left:max(12px,anchor(left));right:12px;align-self:end;justify-self:start;margin:0;z-index:1100;display:flex;flex-direction:column;gap:0;width:max-content;height:fit-content;min-width:min(144px,calc(100vw - 24px));max-width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 12px - max(12px,var(--dsh-frame-overlay-top,12px)));padding:4px;border:0;border-radius:var(--dsw-radius-lg);isolation:isolate;anchor-name:var(--dsh-menu-anchor);position-try-fallbacks:--dsh-menu-wide-above,--dsh-menu-below,--dsh-menu-wide-below,--dsh-menu-window,--dsh-menu-wide-window;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dg-material{position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-menu-surface-fill);backdrop-filter:var(--dsw-menu-backdrop-filter);pointer-events:none}
.dg-viewport{display:flex;flex-direction:column;min-height:0;overflow-y:auto}
.dg-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}
@media (hover:hover){.dg-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.dg-item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}
.dg-item:disabled{opacity:0.4;cursor:not-allowed}
.dg-item-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dg-check{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-primary)}
.dg-backing{display:none;border-radius:var(--dsw-radius-lg)}
html[data-platform='darwin'] .dg-backing{display:block;position:fixed;position-anchor:var(--dsh-menu-anchor);top:anchor(top);left:anchor(left);width:anchor-size(width,0px);height:anchor-size(height,0px);z-index:-1;background:var(--dsw-alias-bg-base);pointer-events:none}
@container (max-width:560px){.dg-guard{gap:8px}}
`

    /**
     * The host's chevron glyph, `IconChevronDownOutlineRegular` artwork: the
     * theme sprite owns the symbol, and this control cannot extend it, so the
     * path is inlined with the same viewBox, size and regular stroke.
     * @returns the trailing chevron svg.
     */
    function chevronGlyph() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', strokeWidth: 1, 'aria-hidden': true,
      }, h('path', {
        d: 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6',
        stroke: 'currentColor',
      }))
    }

    /**
     * The host's selection glyph, `IconCheckOutlineRegular` artwork, rendered
     * with the menu row's `.check` treatment.
     * @returns the trailing check svg.
     */
    function checkGlyph() {
      return h('svg', {
        className: 'dg-check', viewBox: '0 0 16 16', width: 14, height: 14, fill: 'none', strokeWidth: 1, 'aria-hidden': true,
      }, h('path', {
        d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
        stroke: 'currentColor',
      }))
    }

    /**
     * Render one open menu through `document.body`: the host `Menu` list card and
     * the `MenuSurface` material, one `role="menuitemradio"` row per option with
     * the host's trailing check on the current value, and the macOS backing the
     * surface material needs. The card stops its own click propagation because
     * React portals bubble synthetic events through the React tree, where this
     * list is a sibling of the chip trigger that opened it.
     * @param options - the chip's anchor name, list ref, accessible name, rows,
     * current row id, and row-selection callback.
     * @returns the portaled list and backing nodes.
     */
    function menuCard(options) {
      const anchor = options.anchor
      const surfaceAnchor = `${anchor}-surface`
      const surface = h('div', {
        ref: options.listRef,
        className: 'dg-menu',
        role: 'menu',
        'aria-label': options.label,
        style: { positionAnchor: anchor, '--dsh-menu-anchor': surfaceAnchor },
        onClick: (event) => { event.stopPropagation() },
      }, [
        h('div', { key: 'material', className: 'dg-material', 'aria-hidden': true }),
        h('div', { key: 'viewport', className: 'dg-viewport', role: 'presentation' },
          options.items.map((item) => h('button', {
            key: item.id,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': item.id === options.selectedId,
            className: 'dg-item',
            onClick: () => { options.onSelect(item.id) },
          }, [
            h('span', { key: 'label', className: 'dg-item-label' }, item.label),
            item.id === options.selectedId ? checkGlyph() : null,
          ]))),
      ])
      const backing = h('div', {
        className: 'dg-backing',
        'aria-hidden': true,
        style: { '--dsh-menu-anchor': surfaceAnchor },
      })
      return [reactDom.createPortal(surface, document.body), reactDom.createPortal(backing, document.body)]
    }

    /**
     * The composer control: two host chips, each opening its own menu above the
     * composer. The label of the first is the current mode and the label of the
     * second is the current budget, so the state is the label plus the check
     * inside the menu — the same way the permission and model chips show theirs.
     * The budget chip stays visible but disabled while long thinking is on,
     * because the budget is inert then.
     * @param props - renderer-derived props: `t`, `useGuard`, and `submit`.
     * @returns the control element, or `null` when no write path resolves.
     */
    function GuardControl(props) {
      const t = props.t
      const state = props.useGuard(snapshot => snapshot)
      const submit = props.submit
      const [open, setOpen] = useState(null)
      const longTrigger = useRef(null)
      const longList = useRef(null)
      const budgetTrigger = useRef(null)
      const budgetList = useRef(null)
      const longId = useId()
      const budgetId = useId()
      const longAnchor = `--dg-guard-long-${longId.replaceAll(':', '')}`
      const budgetAnchor = `--dg-guard-budget-${budgetId.replaceAll(':', '')}`

      // One dismissal listener set for whichever chip is open. The portaled list
      // is outside the trigger's subtree, so both are checked by containment.
      useEffect(() => {
        if (open === null) return undefined
        const trigger = (open === 'long' ? longTrigger : budgetTrigger).current
        const list = (open === 'long' ? longList : budgetList).current
        const onPointerDown = (event) => {
          if (trigger !== null && trigger.contains(event.target)) return
          if (list !== null && list.contains(event.target)) return
          setOpen(null)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setOpen(null)
            if (trigger !== null) trigger.focus()
            return
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
          if (list === null) return
          const rows = Array.from(list.querySelectorAll('button:not(:disabled)'))
          if (rows.length === 0) return
          const current = rows.indexOf(document.activeElement)
          const step = event.key === 'ArrowDown' ? 1 : -1
          const next = event.key === 'Home' ? 0
            : event.key === 'End' ? rows.length - 1
              : current < 0 ? (step === 1 ? 0 : rows.length - 1)
                : (current + step + rows.length) % rows.length
          event.preventDefault()
          rows[next].focus()
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      if (typeof submit !== 'function') return null

      const long = state?.long === true
      const budgetMs = typeof state?.budgetMs === 'number' ? state.budgetMs : null
      const budgetLabel = budgetMs === null ? t('budget.default') : `${Math.round(budgetMs / 1000)}s`

      const chip = (options) => {
        const isOpen = open === options.id
        return h('span', { key: options.id, className: 'dg-chip' }, [
          h('button', {
            key: 'trigger',
            type: 'button',
            ref: options.triggerRef,
            className: 'dg-trigger',
            style: { anchorName: options.anchor },
            'aria-haspopup': 'menu',
            'aria-expanded': isOpen,
            'aria-label': t(options.controlLabel, { name: options.label }),
            title: options.title,
            disabled: options.disabled,
            onClick: () => { setOpen(isOpen ? null : options.id) },
          }, [
            h('span', { key: 'label', className: 'dg-trigger-label' }, options.label),
            h('span', {
              key: 'chevron',
              className: isOpen ? 'dg-chevron dg-chevron-open' : 'dg-chevron',
              'aria-hidden': true,
            }, chevronGlyph()),
          ]),
          isOpen ? menuCard({
            anchor: options.anchor,
            listRef: options.listRef,
            label: t(options.controlLabel, { name: options.label }),
            items: options.items,
            selectedId: options.selectedId,
            onSelect: (value) => { setOpen(null); submit(options.line(value)) },
          }) : null,
        ])
      }

      return h('span', { className: 'dg-guard', title: t('control.title') }, [
        chip({
          id: 'long',
          anchor: longAnchor,
          triggerRef: longTrigger,
          listRef: longList,
          label: long ? t('long.label') : t('mode.auto'),
          controlLabel: 'long.menu.label',
          title: long ? t('long.on.hint') : t('long.off.hint'),
          disabled: false,
          items: [
            { id: MODE_LONG, label: t('long.label') },
            { id: MODE_AUTO, label: t('mode.auto') },
          ],
          selectedId: long ? MODE_LONG : MODE_AUTO,
          // Explicit on/off, never a toggle: the row names the mode it selects,
          // so a replay of the same choice keeps the same value.
          line: (value) => (value === MODE_LONG ? '/guard long on' : '/guard long off'),
        }),
        chip({
          id: 'budget',
          anchor: budgetAnchor,
          triggerRef: budgetTrigger,
          listRef: budgetList,
          label: budgetLabel,
          controlLabel: 'budget.menu.label',
          title: long ? t('budget.inert.hint') : t('budget.label'),
          disabled: long,
          items: [
            { id: BUDGET_DEFAULT, label: t('budget.default') },
            ...BUDGET_PRESETS.map(ms => ({ id: String(ms), label: `${Math.round(ms / 1000)}s` })),
          ],
          selectedId: budgetMs === null ? BUDGET_DEFAULT : String(budgetMs),
          // The Default row must CLEAR the override, never pin the current host
          // default: this component cannot know `Config.budgetMs`.
          line: (value) => (value === BUDGET_DEFAULT ? '/guard budget default' : `/guard budget ${value}`),
        }),
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
