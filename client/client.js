/**
 * dsh-launcher, browser half: the launcher's settings section.
 *
 * Registers one first-level `settings.section` — the same slot the Skin Center
 * uses — so it shows up as its own row in the settings nav. The card owns one
 * choice: when the background host ends after the last page closes.
 *
 * It talks to the host over `/dsh-launcher/settings` rather than the settings
 * scope, for two reasons: the choice must take effect in the *running* host
 * immediately (the scope is a document write, not a signal), and the scope is
 * fenced to loopback on paired remotes while a plain route keeps working.
 *
 * Written as hand-authored ESM on purpose — the client module system serves
 * this file as-is, so the package needs no build step. That also means no JSX:
 * elements are built with `createElement`.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react'

/** Cordis plugin name for this half. */
export const name = 'dsh-launcher-client'

/** Required services: the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/** Locale namespace owned by this card. */
const NS = 'dshLauncher'

/** The host route this card reads and writes. */
const ENDPOINT = '/dsh-launcher/settings'

const zh = {
  nav: '加载界面',
  title: '加载界面启动器',
  intro: '设置关闭网页之后，后台的 DSH 服务（终端服务器）什么时候结束。',
  immediate: '立刻关闭',
  immediateHint: '最后一个网页关闭后马上结束（约 1 秒——留一点余量，避免刷新页面顺手把服务也关掉）',
  custom: '设定秒数后关闭',
  customHint: '最后一个网页关闭后，等待指定秒数再结束',
  never: '永不关闭',
  neverHint: '服务一直留在后台，适合你希望它随时待命的情况',
  seconds: '秒',
  save: '保存',
  saved: '已保存',
  saveFailed: '保存失败',
  loadFailed: '读取设置失败（宿主未响应）',
  loading: '读取中…',
  range: '请输入 1 到 86400 之间的整数秒',
  openPages: '当前打开的页面',
  activeNow: '当前生效'
}

const en = {
  nav: 'Launcher',
  title: 'Launcher',
  intro: 'Choose when the background DSH service ends after you close the page.',
  immediate: 'End immediately',
  immediateHint: 'Ends as soon as the last page closes (about 1s — a little slack so a refresh cannot kill it)',
  custom: 'End after a delay',
  customHint: 'Wait the given number of seconds after the last page closes',
  never: 'Never end',
  neverHint: 'Keep the service running in the background',
  seconds: 'seconds',
  save: 'Save',
  saved: 'Saved',
  saveFailed: 'Could not save',
  loadFailed: 'Could not read the settings (host not responding)',
  loading: 'Loading…',
  range: 'Enter a whole number of seconds between 1 and 86400',
  openPages: 'Open pages',
  activeNow: 'Active'
}

/** Package-local fallback so the card still reads sensibly without the locale service. */
function fallbackT(key) {
  const table = typeof navigator !== 'undefined' && String(navigator.language ?? '').startsWith('zh') ? zh : en
  return table[key] ?? key
}

function makeT(ctx) {
  try {
    const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
    if (locale !== undefined && locale !== null && typeof locale.register === 'function' && typeof locale.bind === 'function') {
      locale.register(NS, { zh, en })
      const bound = locale.bind(NS)
      return (key) => {
        try {
          const value = bound(key)
          return typeof value === 'string' && value !== '' ? value : fallbackT(key)
        } catch {
          return fallbackT(key)
        }
      }
    }
  } catch {
    /* no locale service: the fallback table is enough */
  }
  return fallbackT
}

const row = (style) => ({ display: 'flex', gap: '8px', alignItems: 'flex-start', ...style })

/**
 * The settings card itself.
 * Defensive throughout: this runs inside the settings shell, where an uncaught
 * render error would take the whole panel down rather than just this row.
 * @param props - Shell props plus the `t` injected at registration.
 */
function LauncherSection(props) {
  const t = props !== undefined && props !== null && typeof props.t === 'function' ? props.t : fallbackT
  const [state, setState] = useState(null)
  const [seconds, setSeconds] = useState('25')
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    fetch(ENDPOINT, { headers: { accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!alive) return
        if (body === null || body.ok !== true) {
          setStatus({ kind: 'error', key: 'loadFailed' })
          return
        }
        setState(body)
        setSeconds(String(body.customSeconds ?? 25))
      })
      .catch(() => {
        if (alive) setStatus({ kind: 'error', key: 'loadFailed' })
      })
    return () => {
      alive = false
    }
  }, [])

  const save = useCallback((shutdown, nextSeconds) => {
    if (nextSeconds !== undefined) {
      const parsed = Number(nextSeconds)
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 86400 || Math.floor(parsed) !== parsed) {
        setStatus({ kind: 'error', key: 'range' })
        return
      }
    }
    const body = { shutdown }
    if (nextSeconds !== undefined) body.customSeconds = Number(nextSeconds)
    setBusy(true)
    setStatus(null)
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((next) => {
        if (next === null || next.ok !== true) {
          setStatus({ kind: 'error', key: 'saveFailed' })
          return
        }
        setState(next)
        setSeconds(String(next.customSeconds ?? 25))
        setStatus({ kind: 'ok', key: 'saved' })
      })
      .catch(() => setStatus({ kind: 'error', key: 'saveFailed' }))
      .then(() => setBusy(false))
  }, [])

  if (state === null) {
    return h('div', { style: { padding: '8px 0' } }, t(status !== null && status.kind === 'error' ? 'loadFailed' : 'loading'))
  }

  const current = state.shutdown
  const options = ['immediate', 'custom', 'never']

  const option = (mode) =>
    h(
      'label',
      { key: mode, style: row({ cursor: 'pointer', marginBottom: mode === 'custom' ? '2px' : '10px' }) },
      h('input', {
        type: 'radio',
        name: 'dsh-launcher-shutdown',
        value: mode,
        checked: current === mode,
        disabled: busy,
        onChange: () => {
          if (mode === 'custom') save(mode, seconds)
          else save(mode)
        },
        style: { marginTop: '3px' }
      }),
      h(
        'span',
        null,
        h('span', null, t(mode)),
        h('br'),
        h('span', { style: { opacity: 0.7, fontSize: '0.92em' } }, t(`${mode}Hint`))
      )
    )

  const children = [
    h('h3', { key: 'title', style: { margin: '0 0 6px' } }, t('title')),
    h('p', { key: 'intro', style: { margin: '0 0 14px', opacity: 0.75 } }, t('intro'))
  ]

  for (const mode of options) {
    children.push(option(mode))
    if (mode === 'custom' && current === 'custom') {
      children.push(
        h(
          'div',
          { key: 'seconds', style: row({ margin: '4px 0 12px 26px', alignItems: 'center' }) },
          h('input', {
            type: 'number',
            min: 1,
            max: 86400,
            step: 1,
            value: seconds,
            disabled: busy,
            onChange: (event) => setSeconds(event.target.value),
            style: { width: '96px' }
          }),
          h('span', null, t('seconds')),
          h(
            'button',
            {
              type: 'button',
              disabled: busy,
              onClick: () => save('custom', seconds),
              style: { marginLeft: '8px' }
            },
            t('save')
          )
        )
      )
    }
  }

  children.push(
    h(
      'p',
      { key: 'status', style: { margin: '10px 0 0', opacity: 0.7, fontSize: '0.92em' } },
      status === null
        ? `${t('activeNow')}: ${t(current)} · ${t('openPages')}: ${state.pages ?? 0}`
        : t(status.key)
    )
  )

  return h('div', { style: { padding: '4px 0' } }, children)
}

/**
 * Register the settings section.
 * @param ctx - client root context.
 */
export function apply(ctx) {
  try {
    const t = makeT(ctx)
    ctx.slots.inject('settings.section', () => {
      try {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-launcher',
            order: 130,
            label: () => t('nav'),
            inject: () => ({ t })
          },
          LauncherSection
        )
      } catch {
        return () => {}
      }
    })
  } catch {
    /* never break the settings shell because this card could not register */
  }
}
