// Drives the plugin's real apply() through a fake host context, so the
// browser-close lifecycle and its settings route can be verified without ever
// killing a live host.
//
//   node --test

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point the harness home at a throwaway directory *before* the plugin resolves
// it, so these tests never read or write the real ~/.dsh.
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-launcher-test-'))
process.env.USERPROFILE = fakeHome
process.env.HOME = fakeHome

const { apply } = await import('../lib/index.js')

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

function jsonResponse() {
  const captured = { code: null, body: null }
  return {
    captured,
    writeHead(code) {
      captured.code = code
    },
    end(body) {
      captured.body = body
    },
    on() {}
  }
}

function jsonRequest(method) {
  const handlers = new Map()
  return {
    method,
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
    },
    destroy() {},
    /** Feed a body, then EOF, as node:http would. */
    push(text) {
      if (text !== undefined) {
        for (const fn of handlers.get('data') ?? []) fn(Buffer.from(text, 'utf8'))
      }
      for (const fn of handlers.get('end') ?? []) fn()
    }
  }
}

const watchRoute = (h) => h.routes.find((r) => r.path === '/dsh-launcher/watch')
const settingsRoute = (h) => h.routes.find((r) => r.path === '/dsh-launcher/settings')

/** Filesystem work stays out of these tests; only the lifecycle is under test. */
const base = { install: false, shortcut: false, exitGraceSeconds: 1 }
const immediate = { ...base, exitOnBrowserClose: true, exitGraceSeconds: 1 }
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function connectPage(h) {
  const route = watchRoute(h)
  assert.ok(route, 'watch route should be registered')
  assert.equal(route.kind, 'exact')
  const res = openPage()
  route.handler({}, res)
  return res
}

async function post(h, payload) {
  const req = jsonRequest('POST')
  const res = jsonResponse()
  const pending = settingsRoute(h).handler(req, res)
  req.push(JSON.stringify(payload))
  await pending
  return res.captured
}

async function getSettings(h) {
  const res = jsonResponse()
  await settingsRoute(h).handler({ method: 'GET' }, res)
  return JSON.parse(res.captured.body)
}

test('registers the watch route, the settings route and the page script', () => {
  const h = harness()
  apply(h.ctx, base)
  assert.equal(h.routes.length, 2)
  assert.ok(watchRoute(h), 'watch route')
  assert.ok(settingsRoute(h), 'settings route')

  const table = []
  h.injections[0](table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'script')
  assert.equal(table[0].placement, 'body')
  assert.match(table[0].text, /EventSource\("\/dsh-launcher\/watch"\)/)
})

test('defaults to never when the config does not enable it', async () => {
  const h = harness()
  apply(h.ctx, base)
  assert.equal((await getSettings(h)).shutdown, 'never')

  const page = connectPage(h)
  page.close()
  await settle(1600)
  assert.deepEqual(h.exits, [], 'a never mode must not exit')
})

test('exits once the last page goes away', async () => {
  const h = harness()
  apply(h.ctx, immediate)
  const page = connectPage(h)
  await settle(120)
  assert.deepEqual(h.exits, [], 'stays up while a page is connected')

  page.close()
  await settle(1600)
  assert.deepEqual(h.exits, [0], 'exits with 0 after the grace period')
})

test('a reload does not count as a close', async () => {
  const h = harness()
  apply(h.ctx, immediate)
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
  apply(h.ctx, immediate)
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
  apply(h.ctx, immediate)

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
  apply(h.ctx, { ...base, exitOnBrowserClose: true, exitOnlyWhenIdle: false })
  const page = connectPage(h)
  page.close()
  await settle(1600)
  assert.deepEqual(h.exits, [0])
})

test('settings route: GET reports the active mode and page count', async () => {
  const h = harness()
  apply(h.ctx, immediate)
  const before = await getSettings(h)
  assert.equal(before.ok, true)
  assert.equal(before.shutdown, 'custom')
  assert.equal(before.customSeconds, 1)
  assert.equal(before.effectiveSeconds, 1)
  assert.equal(before.pages, 0)

  const page = connectPage(h)
  const during = await getSettings(h)
  assert.equal(during.pages, 1)
  assert.equal(during.sawPage, true)
  page.close()
  await settle(1600)
})

test('settings route: never cancels a pending exit', async () => {
  const h = harness()
  apply(h.ctx, immediate)
  const page = connectPage(h)
  page.close()

  const res = await post(h, { shutdown: 'never' })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).shutdown, 'never')
  await settle(1600)
  assert.deepEqual(h.exits, [], 'switching to never must cancel the armed exit')
})

test('settings route: immediate exits about a second after the page closes', async () => {
  const h = harness()
  apply(h.ctx, base)
  assert.equal((await getSettings(h)).shutdown, 'never')

  const res = await post(h, { shutdown: 'immediate' })
  assert.equal(res.code, 200)
  assert.equal(JSON.parse(res.body).effectiveSeconds, 1)

  const page = connectPage(h)
  page.close()
  await settle(1600)
  assert.deepEqual(h.exits, [0])
})

test('settings route: a custom delay is honoured and validated', async () => {
  const h = harness()
  apply(h.ctx, base)

  const ok = await post(h, { shutdown: 'custom', customSeconds: 1 })
  assert.equal(ok.code, 200)
  const body = JSON.parse(ok.body)
  assert.equal(body.shutdown, 'custom')
  assert.equal(body.customSeconds, 1)

  assert.equal((await post(h, { shutdown: 'custom', customSeconds: 0 })).code, 400)
  assert.equal((await post(h, { shutdown: 'custom', customSeconds: 999999 })).code, 400)
  assert.equal((await post(h, { shutdown: 'custom', customSeconds: 'abc' })).code, 400)
  assert.equal((await post(h, { shutdown: 'nonsense' })).code, 400)
  assert.equal((await post(h, {})).code, 400)

  const page = connectPage(h)
  page.close()
  await settle(1600)
  assert.deepEqual(h.exits, [0])
})

test('settings route: rejects a non-GET/POST method', async () => {
  const h = harness()
  apply(h.ctx, base)
  const res = jsonResponse()
  await settingsRoute(h).handler({ method: 'DELETE' }, res)
  assert.equal(res.captured.code, 405)
})
