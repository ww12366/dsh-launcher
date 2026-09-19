// Loads the real client bundle in Node against a stub module loader and a stub
// React, then drives its apply() with a fake client context.
//
// This exists because the browser half cannot be exercised from a terminal any
// other way: the bundle route is fenced to an authenticated page. It catches
// everything up to the point the real client runtime takes over -- the factory
// shape, the exported face, and whether apply() actually reaches
// slots.register with a section the settings shell can project into a nav row.
//
//   node --test

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'

const BUNDLE = new URL('../client/client.js', import.meta.url)

/** Enough of React for the module to import and a single render pass to run. */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial })
}

/** Evaluate the bundle the way the client module system does, and hand back its factory. */
function loadBundle() {
  const source = readFileSync(BUNDLE, 'utf8')
  const loader = {
    record: null,
    load(record) {
      this.record = record
    }
  }
  // eslint-disable-next-line no-new-func -- the bundle is a script, not a module
  new Function('window', source)({ __ModuleLoader__: loader })
  assert.ok(loader.record !== null, 'the bundle must register through window.__ModuleLoader__.load')
  return loader.record
}

/** The module face the client runtime would consume. */
function bundleExports() {
  const record = loadBundle()
  const module = record.factory((specifier) => {
    if (specifier === 'react') return reactStub
    throw new Error(`unexpected require(${JSON.stringify(specifier)})`)
  })
  return { record, module }
}

/** Records the client half's check-ins; installed once for the whole file. */
const reports = []
globalThis.fetch = (url, init) => {
  try {
    reports.push(JSON.parse(init && init.body ? init.body : '{}'))
  } catch {
    reports.push(null)
  }
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
}

/** A client context with just the services the card asks for. */
function clientContext({ locale } = {}) {
  const registered = []
  const injected = []
  const ctx = {
    get: (name) => (name === 'locale' ? locale : undefined),
    effect: () => {},
    on: () => {},
    slots: {
      inject: (slot, cb) => {
        injected.push(slot)
        return cb()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      }
    }
  }
  return { ctx, registered, injected }
}

test('registers an id the client graph already knows, and exports the plugin face', () => {
  const { record, module } = bundleExports()
  assert.equal(record.id, 'dsh-launcher', 'the loader id must match the graph row id')
  assert.equal(module.name, 'dsh-launcher-client')
  assert.deepEqual(module.inject, ['slots', 'locale'])
  assert.equal(typeof module.apply, 'function')
})

test('apply() actually reaches slots.register with a projectable section', () => {
  const { module } = bundleExports()
  const h = clientContext()

  module.apply(h.ctx)

  assert.deepEqual(h.injected, ['settings.section'], 'must inject into the settings.section slot')
  assert.equal(h.registered.length, 1, 'exactly one section, no silent no-op')
  const { options, component } = h.registered[0]
  assert.equal(options.name, 'settings.section')
  assert.equal(options.id, 'dsh-launcher')
  assert.equal(typeof options.order, 'number')
  // The settings shell projects a nav row from exactly these three fields.
  assert.equal(typeof options.label, 'function')
  assert.equal(typeof options.label(), 'string')
  assert.ok(options.label().length > 0, 'the nav row needs a non-empty label')
  assert.equal(typeof options.inject, 'function')
  assert.equal(typeof component, 'function')
})

test('the registered component renders without throwing', () => {
  const { module } = bundleExports()
  const h = clientContext()
  module.apply(h.ctx)
  const { component, options } = h.registered[0]
  const props = { ...options.inject(), close: () => {} }
  const tree = component(props)
  assert.ok(tree !== null && tree !== undefined, 'the card must render something')
})

test('apply() survives a context with no locale service', () => {
  const { module } = bundleExports()
  const h = clientContext({ locale: undefined })
  module.apply(h.ctx)
  assert.equal(h.registered.length, 1)

  // A throwing locale registry must not cost us the row either.
  const hostile = clientContext({
    locale: {
      register() {
        throw new Error('locale registry unavailable')
      },
      bind() {
        throw new Error('locale registry unavailable')
      }
    }
  })
  module.apply(hostile.ctx)
  assert.equal(hostile.registered.length, 1)
})

test('apply() checks in with the host, so a silent failure is visible', () => {
  const { module } = bundleExports()
  const h = clientContext()
  const before = reports.length
  module.apply(h.ctx)
  const sent = reports.slice(before)
  assert.ok(
    sent.some((entry) => entry !== null && entry.loaded === true),
    'the browser half must report that it ran at all'
  )
  assert.ok(
    sent.some((entry) => entry !== null && entry.section === 'registered'),
    'a successful registration must be reported too'
  )
})

test('a failing registration is reported instead of swallowed', () => {
  const { module } = bundleExports()
  const hostile = {
    get: () => undefined,
    effect: () => {},
    on: () => {},
    slots: {
      inject: (slot, cb) => cb(),
      register: () => {
        throw new Error('slot rejected the options')
      }
    }
  }
  const before = reports.length
  module.apply(hostile)
  const sent = reports.slice(before)
  assert.ok(
    sent.some((entry) => entry !== null && typeof entry.error === 'string' && entry.error.includes('slot rejected')),
    'the rejection reason must reach the host'
  )
})
