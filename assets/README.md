# DeepSeek Harness Launcher

English | [中文](README.zh.md)

The desktop shortcut `dsh.lnk` now targets `DshLauncher.exe`. Double-clicking it shows a
splash with the logo and a progress bar and **never opens a terminal window**; once the
service is ready it opens the browser and the splash closes.

## Why there is no terminal window any more

The original shortcut targeted `npx.cmd --verbose @deepseek-ai/dsh web`. A `.cmd` must be
run by `cmd.exe`, which always allocates a console window.

`DshLauncher.exe` is compiled with `/target:winexe` (PE subsystem = 2, the GUI subsystem),
so the process itself **has no console**; it then starts `dsh web` as a hidden child using
`CreateNoWindow`. Neither layer has a window.

## Files

| File | Purpose |
|---|---|
| `DshLauncher.exe` | The launcher (self-contained; the logo is embedded, no external image needed) |
| `DshLauncher.cs` | Source code (deliberately C# 5 syntax, see below) |
| `app.manifest` | DPI awareness + Windows 10/11 declaration (rounded corners, crisp rendering) |
| `build.ps1` | Rebuild |
| `dsh.ico` | Original logo artwork |
| `run-dsh-web.cmd` | The actual launch command, regenerated on every start |
| `launcher.log` | The launcher's own log |
| `dsh-web.log` | Output of `dsh web` (overwritten on each start) |
| `dsh.lnk.original-backup` | Backup of the original desktop shortcut |

## Command line

```text
DshLauncher.exe                 normal start
DshLauncher.exe --preview       render the UI only, do not start the service (for tweaking the look)
DshLauncher.exe --port 8080     use another port; forwarded to dsh web
```

## Behaviour

- **Service not running** → the progress bar advances on the splash, `dsh web` is started
  hidden, and once the port answers the splash closes and the browser opens. `dsh web`
  opens it itself with a `?token=` URL, so it authenticates on the first try.
- **Service already running** → nothing is started again; the browser is opened and the
  splash closes (about 1.4 s). In that case no process can supply a `?token=`, so the
  plain origin URL is opened and authentication relies on the browser's cookie, which is
  signed with a durable secret and valid for 30 days (`cookieMaxAgeDays`, default 30, in
  `dsh-client-connection`).

## Configuration

Everything machine-specific lives in `launcher.ini`, next to this executable. The
`dsh-launcher` DSH plugin regenerates it on every host boot, from the host it is
actually running inside:

```ini
nodeExe=D:\node manager\node.exe
workspaceRoot=D:\dsh
port=3080
```

A missing file breaks nothing: `nodeExe` falls back to `node` on `PATH`, `workspaceRoot`
to your user profile, `port` to 3080. `--port N` on the command line still wins over the
file for one run. Whatever ends up in effect is recorded in `launcher.log`:

```text
config: port=3080; node=D:\node manager\node.exe; cwd=D:\dsh
```

The only compiled-in values left are defaults in `Cfg` at the top of `DshLauncher.cs`:

```csharp
internal const int DefaultPort = 3080;
internal const int TimeoutSeconds = 150;              // startup timeout
```

Changing those, or anything else in the source, requires a rebuild:

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

## Why it is locked to C# 5

The in-box `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` only supports up to
`/langversion:5` (Roslyn ships with Visual Studio). So avoid string interpolation
`$"..."`, `?.`, expression-bodied members and other C# 6+ syntax in the source, or the
build fails.

## Troubleshooting

When startup fails the splash turns red and offers "view log", which opens `dsh-web.log`
in Notepad. `launcher.log` is also worth reading — it records the resolved configuration
and every probe, launch and ready step.

## License

MIT — this launcher is part of the
[dsh-launcher](https://github.com/ww12366/dsh-launcher) DSH plugin.
