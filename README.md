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

## What it does on every boot

Idempotent and self-healing, in two steps:

1. Syncs the launcher files from `assets/` into `%USERPROFILE%\.dsh\launcher\`
   (compared by file size, so only missing or changed files are written)
2. Makes sure the desktop shortcut points at `DshLauncher.exe` — creates it when
   absent, repairs it when it points elsewhere

A failure in either step only logs a warning and **never** affects host startup: a
plugin that throws takes the whole Harness down with it, and losing the Harness
because a desktop shortcut could not be written would be absurd.

## Install

```sh
dsh plugin --profile web add D:\dsh\dsh-launcher
```

Then restart `dsh web` for it to take effect. A bundle-stack change needs a restart —
`patchReload: live` only watches `cordis.patch.yml`, not the bundle list.

## Configuration

Optional, written into the profile's `cordis.patch.yml`. Note it **must sit under
`config:`**, because the loader passes only that sub-object to the plugin:

```yaml
- id: dsh-launcher
  name: 'dsh-launcher'
  config:
    install: true            # copy/repair the launcher files; default true
    shortcut: true           # manage the desktop shortcut; default true
    shortcutPath: 'C:\Users\me\Desktop\dsh.lnk'   # default: resolve the shell Desktop
    workspaceRoot: 'D:\dsh'  # the "Start in" directory recorded in the shortcut
```

## Other platforms

Non-Windows platforms are skipped with an explanatory line — the launcher is
Windows-only.

## Caveats

**1. It is a `link:` dependency, so the source directory must stay put.**
`dsh plugin add D:\dsh\dsh-launcher` installs a link (`node_modules\dsh-launcher` is a
junction to `D:\dsh\dsh-launcher`). Convenient for development, but if you delete or
rename that directory the bundle can no longer be found — and **DSH fails startup
loudly on a missing bundle** (see `dsh-app-boot`: "A missing bundle or one without a
patch declaration fails startup loudly").

For a self-contained install decoupled from the source tree:

```sh
cd D:\dsh\dsh-launcher
pnpm pack                                     # produces dsh-launcher-1.0.0.tgz
dsh plugin --profile web add .\dsh-launcher-1.0.0.tgz
```

The files are then copied into the profile's `node_modules`, and source edits require
re-packing and reinstalling. Pick per situation: link while iterating, tarball once it
has settled.

**2. The plugin "owns" `~/.dsh\launcher`.**
Each boot it compares by **file size** and overwrites same-named files. To customise
the installed launcher, edit the plugin's `assets/` and rebuild; edits made directly in
the installed copy are synced over on the next boot. `launcher.log`, `dsh-web.log`,
`run-dsh-web.cmd` and `dsh.lnk.original-backup` are not in the sync list and are left
alone.

**3. About 0.3 s of boot cost.**
`apply()` is synchronous, and roughly 290 ms of it is the single PowerShell call
(asking the shell where the Desktop is and what the shortcut currently points at).
Negligible against DSH's own ~6 s boot.

**4. Editing `lib/index.js` needs a host restart.**
Plugin code is `import`ed and cached when the host boots; restart `dsh web` to reload
it. Only `cordis.patch.yml` changes go through live reload.

## Layout

| Path | Purpose |
|---|---|
| `lib/index.js` | Host entry: `apply(ctx, config)`, node builtins only, zero dependencies |
| `cordis.patch.yml` | Bundle patch that inserts the plugin into the layer stack |
| `assets/` | Launcher files installed into `~/.dsh/launcher` (including the `.cs` source and build script, so it stays rebuildable after install) |

See `assets/README.md` for the launcher's own usage, its C# 5 build constraint, and
troubleshooting.
