// Drives the plugin's real apply() through a fake host context, so the
// browser-close lifecycle can be verified without ever killing a live host.
//
//   node --test

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'

/** Minimal host context: only the surface the plugin actually touches. */
function harness({ agents } = {}) {
  const routes = []
  const injections = []
  const exits = []
  const logs = []

  const ctx = {
    logger: {
      info: (message) => logs.push(`info: ${message}`),
      warn: (message) => logs.push(`warn: ${message}`)
    },
    get(name) {
      if (name === 'agents') return agents
      if (name === 'appExit') return (code) => exits.push(code)
      return undefined
    },
    on(name, fn) {
      if (name === 'webserver/index-inject') injections.push(fn)
    },
    inject(deps, cb) {
      cb(ctx)
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      }
    }
  }

  return { ctx, routes, injections, exits, logs }
}

/** Stand-in for an open browser page holding the SSE response. */
function openPage() {
  const handlers = new Map()
  const res = {
    writeHead() {},
    write() {},
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    /** Simulate the tab going away. */
    close() {
      for (const fn of handlers.get('close') ?? []) fn()
    }
  }
  return res
}

/** Filesystem work stays out of these tests; only the lifecycle is under test. */
const base = { install: false, shortcut: false, exitOnBrowserClose: true, exitGraceSeconds: 1 }
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function connectPage(harnessed) {
  const route = harnessed.routes[0]
  assert.ok(route, 'watch route should be registered')
  assert.equal(route.path, '/dsh-launcher/watch')
  assert.equal(route.kind, 'exact')
  const res = openPage()
  route.handler({}, res)
  return res
}

test('inert unless explicitly enabled', () => {
  const h = harness()
  apply(h.ctx, { install: false, shortcut: false })
  assert.equal(h.routes.length, 0, 'no watch route without exitOnBrowserClose')
  assert.equal(h.injections.length, 0, 'no index injection without exitOnBrowserClose')
})

test('registers the watch route and injects the page script when enabled', () => {
  const h = harness()
  apply(h.ctx, base)
  assert.equal(h.routes.length, 1)

  const table = []
  h.injections[0](table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'body')
  assert.match(table[0].text, /EventSource\("\/dsh-launcher\/watch"\)/)
})

test('never exits when no page has ever connected', async () => {
  const h = harness()
  apply(h.ctx, base)
  await settle(1600)
  assert.deepEqual(h.exits, [], 'a page that never connected must not arm an exit')
})

test('exits once the last page goes away', async () => {
  const h = harness()
  apply(h.ctx, base)
  const page = connectPage(h)
  await settle(120)
  assert.deepEqual(h.exits, [], 'stays up while a page is connected')

  page.close()
  await settle(1600)
  assert.deepEqual(h.exits, [0], 'exits with 0 after the grace period')
})

test('a reload does not count as a close', async () => {
  const h = harness()
  apply(h.ctx, base)
  const first = connectPage(h)
  first.close()
  await settle(200)
  const second = connectPage(h)
  await settle(1600)
  assert.deepEqual(h.exits, [], 'reconnecting inside the grace period cancels the exit')
  second.close()
})

test('two pages: closing one is not closing all', async () => {
  const h = harness()
  apply(h.ctx, base)
  const a = connectPage(h)
  const b = connectPage(h)
  a.close()
  await settle(1600)
  assert.deepEqual(h.exits, [], 'one page still open keeps the host alive')
  b.close()
  await settle(1600)
  assert.deepEqual(h.exits, [0])
})

test('refuses to exit while an agent is running, then exits when it goes idle', async () => {
  let status = 'running'
  const agents = { list: () => [{ status }] }
  const h = harness({ agents })
  apply(h.ctx, base)

  const page = connectPage(h)
  page.close()
  await settle(1600)
  assert.deepEqual(h.exits, [], 'a running agent must not be cut off')

  status = 'idle'
  await settle(1600)
  assert.deepEqual(h.exits, [0], 'once idle, the next check exits')
})

test('exitOnlyWhenIdle: false ignores agent status', async () => {
  const agents = { list: () => [{ status: 'running' }] }
  const h = harness({ agents })
  apply(h.ctx, { ...base, exitOnlyWhenIdle: false })
  const page = connectPage(h)
  page.close()
  await settle(1600)
  assert.deepEqual(h.exits, [0])
})
