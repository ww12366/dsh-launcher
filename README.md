# dsh-launcher

English | [中文](README.zh.md)

Packages the console-free desktop launcher as a DSH plugin that **installs and self-heals** it.

## One limitation, stated up front

**The plugin cannot itself be the launcher.** A DSH plugin is loaded *inside* an
already-booted host process, while the console window you want gone belongs to the
process that *started* `dsh` — it exists before any plugin code runs.

So what this plugin does is **own and maintain that external launcher**: lay the files
down, keep them current, and keep the desktop shortcut pointing at the right target.
The thing that actually removes the console window is still `DshLauncher.exe`, a
GUI-subsystem binary (`/target:winexe`).

## Requirements

* **Windows.** On any other platform the plugin logs one line and does nothing. It is
  deliberately *not* declared `os: ["win32"]`, so a profile you share between machines
  still installs and boots elsewhere instead of failing on an unfetchable dependency.
* Node 20 or newer (any DSH install).

## Install

From GitHub:

```sh
dsh plugin --profile web add github:ww12366/dsh-launcher
```

Or from a local checkout — this links instead of copying, so read the caveats first:

```sh
dsh plugin --profile web add C:\path\to\dsh-launcher
```

Then restart `dsh web`. A bundle-stack change needs a restart — `patchReload: live`
only watches `cordis.patch.yml`, not the bundle list.

## What it does on every boot

Idempotent and self-healing:

1. Syncs the launcher files from `assets/` into `%USERPROFILE%\.dsh\launcher\`
   (compared by file size, so only missing or changed files are written)
2. Regenerates `launcher.ini` there — see the next section
3. Makes sure the desktop shortcut points at `DshLauncher.exe` — creates it when
   absent, repairs it when it points elsewhere

A failure in any step only logs a warning and **never** affects host startup: a plugin
that throws takes the whole Harness down with it, and losing the Harness because a
desktop shortcut could not be written would be absurd.

## Nothing here is tied to one machine

The package ships no absolute paths. On every boot the plugin writes `launcher.ini`
next to the executable, and that is the only place the launcher learns what to use:

```ini
nodeExe=D:\node manager\node.exe     # process.execPath of the running host
workspaceRoot=D:\dsh                 # the host's own working directory
port=3080
```

`DshLauncher.exe` reads it as plain `key=value` (no JSON dependency) and falls back
cleanly when it is absent: `node` from `PATH`, the user profile as the working
directory, port 3080. Deleting the file can therefore only make the launcher *more*
generic, never broken. Each boot also records the resolved values in `launcher.log`:

```text
config: port=3080; node=D:\node manager\node.exe; cwd=D:\dsh
```

## Configuration

Optional, in the profile's `cordis.patch.yml`. It **must sit under `config:`**, because
the loader passes only that sub-object to the plugin:

```yaml
- id: dsh-launcher
  name: 'dsh-launcher'
  config:
    install: true                                  # sync the launcher files; default true
    shortcut: true                                 # manage the desktop shortcut; default true
    shortcutPath: 'C:\Users\me\Desktop\dsh.lnk'    # default: the shell's Desktop folder
    workspaceRoot: 'D:\work'                       # default: the host's working directory
    port: 3080                                     # default: 3080
    exitOnBrowserClose: true                       # default: false — see below
    exitGraceSeconds: 25                           # default: 25
    exitOnlyWhenIdle: true                         # default: true
```

`workspaceRoot` is what the shortcut records as "Start in", and dsh treats it as the
workspace root. It defaults to the host's working directory, which by DSH's own
definition *is* the workspace root.

## Closing the page can shut the host down

Off by default: exiting a host is a big hammer, and a package that reached for it
unasked would be a nasty surprise. Turn it on with `exitOnBrowserClose: true`.

With it on, the launcher and the host close the loop: the shortcut starts the service,
and once the last browser page goes away the service ends by itself. Without it, the
host is a detached background process that outlives the tab, so the shortcut's next
launch just reconnects to a stale tree — plugins you installed since are not in it, and
nothing looks wrong.

**How the page is detected.** DSH exposes no browser count, and the WebServer service
keeps its socket table private, so the page is asked rather than guessed at: the plugin
contributes one `<script>` row to the served `index.html`, which opens an `EventSource`
to an SSE route the plugin owns. One live connection per open page, so "no connections"
means "no page".

**Why it is deliberately cautious.** A wrong "nobody is watching" kills your session, so:

* it **never exits unless a page connected at least once** — a blocked or failed
  injected script can only make the feature inert, never fatal;
* it waits out `exitGraceSeconds`, so a **reload is not a close**;
* it **refuses to exit while any agent is `running`**, so it cannot cut off work in
  flight, and re-checks after another grace period;
* the shutdown goes through `ctx.appExit`, the launcher's bounded dispose-then-exit
  path, not `process.exit`.

Sessions are persisted, so nothing is lost by the host going away — but a turn that is
still running is a different matter, which is what `exitOnlyWhenIdle` is for. Set it to
`false` only if you really do want the page to own the host's lifetime.

## Caveats

**A local-path install is a `link:`, so the source directory must stay put.**
`dsh plugin add C:\path\to\dsh-launcher` installs a junction rather than a copy. Delete
or rename that directory and the bundle can no longer be found — and **DSH fails
startup loudly on a missing bundle** (see `dsh-app-boot`: "A missing bundle or one
without a patch declaration fails startup loudly"). Installing from GitHub avoids this.
A local link is convenient while iterating and a liability once things settle.

**The plugin "owns" `~/.dsh\launcher`.**
Each boot it compares by **file size** and overwrites same-named files. To customise
the installed launcher, edit the plugin's `assets/` and rebuild; edits made directly in
the installed copy are synced over on the next boot. `launcher.log`, `dsh-web-*.log`,
`run-dsh-web.cmd`, `launcher.ini` and `dsh.lnk.original-backup` are not in the sync
list and are left alone.

**About 0.3 s of boot cost.**
`apply()` is synchronous, and roughly 290 ms of it is the single PowerShell call
(asking the shell where the Desktop is and what the shortcut currently points at).
Negligible against DSH's own multi-second boot.

**Editing `lib/index.js` needs a host restart.**
Plugin code is `import`ed and cached when the host boots. Only `cordis.patch.yml`
changes go through live reload.

## Layout

| Path | Purpose |
|---|---|
| `lib/index.js` | Host entry: `apply(ctx, config)`, node builtins only, zero dependencies |
| `cordis.patch.yml` | Bundle patch that inserts the plugin into the layer stack |
| `assets/` | Launcher files installed into `~/.dsh/launcher`, including the `.cs` source and build script so it stays rebuildable after install |
| `test/` | `node --test` suite for the browser-close lifecycle, driven through a fake host context |
| `LICENSE` | MIT |

See `assets/README.md` for the launcher's own usage, its C# 5 build constraint, and
troubleshooting.

## License

MIT — see [LICENSE](LICENSE).
