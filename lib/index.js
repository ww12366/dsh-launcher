/**
 * dsh-launcher — host entry.
 *
 * WHY THIS PLUGIN CANNOT ITSELF BE THE LAUNCHER
 * --------------------------------------------
 * A DSH plugin is loaded *inside* an already-booted host process. The console
 * window that appears when the user starts `dsh` belongs to the process that
 * started it, and exists before any plugin code runs. So no plugin can remove
 * that window; only an external, GUI-subsystem executable can. What a plugin
 * can do is own that executable: install it, keep it current, and keep the
 * desktop shortcut pointing at it. That is what this plugin does.
 *
 * On every boot it self-heals, idempotently:
 *   1. materialise the launcher assets into %USERPROFILE%\.dsh\launcher
 *   2. make sure the desktop shortcut points at DshLauncher.exe
 *
 * Everything is wrapped so a failure can never take the host boot down: a
 * plugin that throws fails startup loudly, and losing the whole Harness
 * because a desktop shortcut could not be written would be absurd.
 *
 * Config (optional, via the profile patch):
 *   install:       false to stop copying/repairing the launcher files
 *   shortcut:      false to stop managing the desktop shortcut
 *   shortcutPath:  explicit .lnk path, overriding shell folder discovery
 *   workspaceRoot: working directory recorded in the shortcut
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name; matches the `id` in cordis.patch.yml. */
export const name = 'dsh-launcher'

const PREFIX = 'dsh-launcher'
const EXE = 'DshLauncher.exe'
const SHORTCUT = 'dsh.lnk'
/** Generated key=value file that DshLauncher.exe reads; never shipped. */
const INI = 'launcher.ini'

/** SSE endpoint the injected page script connects to. */
const WATCH_PATH = '/dsh-launcher/watch'

/** Assets copied into the launcher directory, in this order. */
const ASSETS = [
  EXE,
  'dsh.ico',
  'DshLauncher.cs',
  'app.manifest',
  'build.ps1',
  'README.md',
  'README.zh.md'
]

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS_DIR = join(HERE, '..', 'assets')
const LAUNCHER_DIR = join(homedir(), '.dsh', 'launcher')
const MARKER = join(LAUNCHER_DIR, '.installed.json')

const DEFAULTS = {
  install: true,
  shortcut: true,
  shortcutPath: undefined,
  // Resolved from the host's own working directory when unset, so this package
  // never carries an author-machine path.
  workspaceRoot: undefined,
  port: 3080,
  // Host lifecycle. Off by default: exiting a host is a big hammer, and a
  // package that did it unasked would be a nasty surprise.
  exitOnBrowserClose: false,
  exitGraceSeconds: 25,
  exitOnlyWhenIdle: true
}

/** Plugin version, read from the package manifest next to lib/. */
function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function say(ctx, message) {
  try {
    if (ctx !== undefined && ctx !== null && ctx.logger !== undefined && typeof ctx.logger.info === 'function') {
      ctx.logger.info(message)
      return
    }
  } catch {
    /* fall through to stdout */
  }
  console.log(`${PREFIX}: ${message}`)
}

function warn(ctx, message) {
  try {
    if (ctx !== undefined && ctx !== null && ctx.logger !== undefined && typeof ctx.logger.warn === 'function') {
      ctx.logger.warn(message)
      return
    }
  } catch {
    /* fall through to stderr */
  }
  console.warn(`${PREFIX}: ${message}`)
}

/** Quote a PowerShell single-quoted literal. */
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function powershell(script, timeout = 20000) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', timeout, windowsHide: true }
  )
  if (result.error !== undefined && result.error !== null) throw result.error
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n').slice(-1)[0] ?? ''
    throw new Error(`powershell exited ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`)
  }
  return (result.stdout ?? '').trim()
}

/**
 * Ask the Windows shell where the Desktop is (it may be redirected into
 * OneDrive) and what the shortcut currently points at — in one call, so the
 * path we inspect is always the path we would write.
 * @param explicitPath - configured .lnk path, or undefined to use the shell Desktop.
 * @returns {{ desktop: string, path: string, target: string | null }}
 */
function inspectShortcut(explicitPath) {
  const script = [
    "$d = [Environment]::GetFolderPath('Desktop')",
    explicitPath === undefined
      ? `$p = Join-Path $d ${psLiteral(SHORTCUT)}`
      : `$p = ${psLiteral(explicitPath)}`,
    "$t = ''",
    'if (Test-Path -LiteralPath $p) {',
    '  $t = (New-Object -ComObject WScript.Shell).CreateShortcut($p).TargetPath',
    '}',
    'Write-Output $d',
    'Write-Output $p',
    'Write-Output $t'
  ].join('\n')

  const lines = powershell(script).split(/\r?\n/)
  const desktop = (lines[0] ?? '').trim()
  const path = (lines[1] ?? '').trim()
  const target = (lines[2] ?? '').trim()
  return { desktop, path, target: target === '' ? null : target }
}

function writeShortcut(lnk, exePath, workDir) {
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    `$s = $ws.CreateShortcut(${psLiteral(lnk)})`,
    `$s.TargetPath = ${psLiteral(exePath)}`,
    `$s.WorkingDirectory = ${psLiteral(workDir)}`,
    `$s.IconLocation = ${psLiteral(`${exePath},0`)}`,
    "$s.Description = 'DeepSeek Harness'",
    '$s.WindowStyle = 1',
    '$s.Save()'
  ].join('\n')

  powershell(script)
}

function readMarker() {
  try {
    return JSON.parse(readFileSync(MARKER, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Write the launcher's generated configuration. This is the only place the
 * launcher learns which node binary and working directory apply on *this*
 * machine, which is what keeps the package free of hardcoded paths.
 * @returns {boolean} true when the file actually changed.
 */
function writeIni(values) {
  const body = [
    `# Generated by ${PREFIX} ${values.version} - do not edit; regenerated on every boot.`,
    '# Read by DshLauncher.exe sitting next to this file. Delete it and the',
    '# launcher falls back to `node` on PATH and the user profile directory.',
    `nodeExe=${values.nodeExe}`,
    `workspaceRoot=${values.workspaceRoot}`,
    `port=${values.port}`,
    ''
  ].join('\r\n')

  const path = join(LAUNCHER_DIR, INI)
  try {
    if (readFileSync(path, 'utf8') === body) return false
  } catch {
    /* missing or unreadable: fall through and write it */
  }
  writeFileSync(path, body, 'utf8')
  return true
}

/** Copy any asset that is missing or whose size differs. */
function syncAssets() {
  const copied = []
  for (const rel of ASSETS) {
    const src = join(ASSETS_DIR, rel)
    const dst = join(LAUNCHER_DIR, rel)
    if (!existsSync(src)) continue

    let stale = true
    if (existsSync(dst)) {
      try {
        stale = statSync(src).size !== statSync(dst).size
      } catch {
        stale = true
      }
    }
    if (!stale) continue

    copyFileSync(src, dst)
    copied.push(rel)
  }
  return copied
}

function run(ctx, cfg) {
  if (process.platform !== 'win32') {
    say(ctx, `skipped: the launcher is Windows-only (running on ${process.platform})`)
    return
  }
  if (!existsSync(ASSETS_DIR)) {
    warn(ctx, `assets not found at ${ASSETS_DIR}; nothing installed`)
    return
  }

  const version = pluginVersion()
  // The host's working directory *is* dsh's workspace root, so this is both the
  // correct default and a machine-independent one.
  const workspaceRoot = cfg.workspaceRoot ?? process.cwd()
  const exePath = join(LAUNCHER_DIR, EXE)
  const notes = []

  if (cfg.install === true) {
    const before = readMarker()
    mkdirSync(LAUNCHER_DIR, { recursive: true })
    const copied = syncAssets()

    if (!existsSync(exePath)) {
      warn(ctx, `${EXE} missing after install; launcher not usable`)
      return
    }

    const wroteIni = writeIni({
      version,
      nodeExe: process.execPath,
      workspaceRoot,
      port: cfg.port
    })

    if (copied.length > 0 || before === null || before.version !== version) {
      writeFileSync(
        MARKER,
        `${JSON.stringify({ version, installedAt: new Date().toISOString(), assets: ASSETS }, null, 2)}\n`,
        'utf8'
      )
      notes.push(copied.length > 0 ? `installed ${copied.join(', ')}` : `assets current (v${version})`)
    } else {
      notes.push(`assets current (v${version})`)
    }
    if (wroteIni) notes.push(`wrote ${INI}`)
  }

  if (cfg.shortcut === true) {
    const probe = inspectShortcut(cfg.shortcutPath)
    const lnk = probe.path === '' ? join(probe.desktop === '' ? homedir() : probe.desktop, SHORTCUT) : probe.path

    if (probe.target === exePath) {
      notes.push(`shortcut ok (${lnk})`)
    } else {
      writeShortcut(lnk, exePath, workspaceRoot)
      notes.push(probe.target === null ? `shortcut created (${lnk})` : `shortcut repaired (${lnk})`)
    }
  }

  // Both switches off: stay quiet rather than logging an empty line.
  if (notes.length === 0) return
  say(ctx, notes.join('; '))
}

function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Shut the host down once the last browser page has gone.
 *
 * The host is a detached background process, so closing the tab otherwise
 * leaves it running forever and the shortcut's next launch just reconnects to
 * a stale tree. The signal is a page-side `EventSource` pointed at an SSE route
 * this plugin owns: one live connection per open page, so "no connections"
 * means "no page". Nothing in the DSH host exposes a client count, and the
 * WebServer service keeps its socket table private, so the page is asked
 * directly rather than guessed at from traffic.
 *
 * Deliberately conservative, because a wrong "nobody is watching" kills the
 * user's session:
 *  - it never exits unless a page connected at least once, so a blocked or
 *    failed injected script can only make the feature inert, never fatal;
 *  - it waits out a grace period, so a reload is not mistaken for a close;
 *  - it refuses to exit while any agent is still `running`, so it cannot cut
 *    off work in flight, and re-checks after another grace period.
 *
 * @param ctx - Host context.
 * @param cfg - Merged plugin config.
 */
function watchBrowser(ctx, cfg) {
  if (cfg.exitOnBrowserClose !== true) return

  const graceSeconds = Number(cfg.exitGraceSeconds)
  const graceMs = Math.max(1, Number.isFinite(graceSeconds) ? graceSeconds : 25) * 1000

  const clients = new Set()
  let seenPage = false
  let armed = null
  let leaving = false

  const cancel = () => {
    if (armed !== null) {
      clearTimeout(armed)
      armed = null
    }
  }

  /** Any agent still working? Exiting now would abort its turn. */
  const busy = () => {
    if (cfg.exitOnlyWhenIdle === false) return false
    try {
      const agents = ctx.get('agents')
      if (agents === undefined || agents === null || typeof agents.list !== 'function') return false
      return agents.list().some((agent) => agent !== undefined && agent !== null && agent.status === 'running')
    } catch {
      return false
    }
  }

  const leave = () => {
    armed = null
    if (clients.size > 0) return
    if (busy()) {
      arm()
      return
    }
    leaving = true
    say(ctx, `no browser page for ${graceMs / 1000}s; shutting the host down`)

    // ctx.appExit is the launcher's bounded shutdown (dispose the tree, then
    // exit); process.exit is only the fallback for a host that never provided it.
    const exit = ctx.get('appExit')
    if (typeof exit === 'function') exit(0)
    else process.exit(0)
  }

  const arm = () => {
    if (leaving || !seenPage || clients.size > 0 || armed !== null) return
    armed = setTimeout(leave, graceMs)
    if (typeof armed.unref === 'function') armed.unref()
  }

  const sync = () => {
    cancel()
    arm()
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'exact',
      path: WATCH_PATH,
      handler(req, res) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        })
        res.write(': dsh-launcher watching\n\n')

        // Keep the connection from being reaped as idle while the page is open.
        const beat = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            /* socket already gone; the close handler is doing the real work */
          }
        }, 20000)
        if (typeof beat.unref === 'function') beat.unref()

        clients.add(res)
        seenPage = true
        sync()

        const drop = () => {
          clearInterval(beat)
          if (clients.delete(res)) sync()
        }
        res.on('close', drop)
        res.on('error', drop)
      }
    })

    ctx.on('webserver/index-inject', (table) => {
      table.push({
        kind: 'script',
        placement: 'body',
        text: `try{new EventSource(${JSON.stringify(WATCH_PATH)})}catch(e){}`
      })
    })

    say(ctx, `browser-close watcher armed (grace ${graceMs / 1000}s)`)
  })
}

/**
 * Register launcher maintenance and the optional host-lifecycle watcher.
 * Never throws: a plugin failure would take the whole boot down with it.
 * @param ctx - Host context (only `logger` is used, and only if present).
 * @param config - Optional profile override from the loader.
 */
export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  try {
    run(ctx, cfg)
  } catch (error) {
    warn(ctx, `could not maintain the desktop launcher: ${reasonOf(error)}`)
  }
  try {
    watchBrowser(ctx, cfg)
  } catch (error) {
    warn(ctx, `could not arm the browser-close watcher: ${reasonOf(error)}`)
  }
}
