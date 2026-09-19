# DeepSeek Harness 启动器

[English](README.md) | 中文

桌面快捷方式 `dsh.lnk` 现在指向 `DshLauncher.exe`。双击后出现一个带 logo 和进度条的
启动画面，**不会再弹出终端窗口**；服务就绪后自动打开浏览器，启动画面关闭。

## 为什么不再有终端窗口

原来的快捷方式指向 `npx.cmd --verbose @deepseek-ai/dsh web`。`.cmd` 必须由 `cmd.exe`
执行，于是一定会分配一个控制台窗口。

现在的 `DshLauncher.exe` 用 `/target:winexe` 编译（PE subsystem = 2，GUI 子系统），
进程本身**不存在控制台**；它再用 `CreateNoWindow` 把 `dsh web` 作为隐藏子进程拉起。
两层都没有窗口。

## 文件

| 文件 | 说明 |
|---|---|
| `DshLauncher.exe` | 启动器本体（自助包含，logo 已内嵌，无需外部图片） |
| `DshLauncher.cs` | 源代码（故意用 C# 5 语法，见下） |
| `app.manifest` | DPI 感知 + Windows 10/11 声明（圆角、清晰渲染） |
| `build.ps1` | 重新编译 |
| `dsh.ico` | logo 原图 |
| `run-dsh-web.cmd` | 每次启动自动生成的实际启动命令 |
| `launcher.log` | 启动器自己的日志 |
| `dsh-web-<时间戳>.log` | 最近一次 `dsh web` 的输出；每次启动一个文件，只保留最新 5 个 |
| `dsh.lnk.original-backup` | 原来的桌面快捷方式备份 |

## 命令行参数

```text
DshLauncher.exe                 正常启动
DshLauncher.exe --preview       只显示界面，不启动服务（调外观用）
DshLauncher.exe --port 8080     换端口，会一并传给 dsh web
```

## 行为

- **服务没在跑** → 启动画面上进度条前进，隐藏启动 `dsh web`，端口响应后关闭、
  浏览器自动打开（由 `dsh web` 自己用带 `?token=` 的地址打开，保证一次就通过认证）。
- **服务已经在跑** → 不再重复启动，直接打开浏览器后关闭（约 1.4 秒）。
  这种情况没有进程能提供 `?token=`，所以打开的是裸地址；认证靠浏览器里那张
  由持久密钥签名、有效期 30 天的 cookie（见 `dsh-client-connection`
  的 `cookieMaxAgeDays` 默认值 30）。

## 配置

所有与机器相关的东西都在 exe 旁边的 `launcher.ini` 里。`dsh-launcher` 插件每次宿主启动时会按**它实际所在的那个宿主**重新生成这个文件：

```ini
nodeExe=D:\node manager\node.exe
workspaceRoot=D:\dsh
port=3080
```

文件不存在也不会坏：`nodeExe` 回退到 `PATH` 上的 `node`，`workspaceRoot` 回退到用户主目录，`port` 回退到 3080。命令行的 `--port N` 对当次运行仍然优先于文件。最终生效的值会记进 `launcher.log`：

```text
config: port=3080; node=D:\node manager\node.exe; cwd=D:\dsh
```

源码里只剩 `Cfg` 顶部这些「默认值」，它们只是默认值：

```csharp
internal const int DefaultPort = 3080;
internal const int TimeoutSeconds = 150;              // 启动超时
```

改这些、或改源码里任何其它东西，都必须重新编译：

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

## 为什么锁死 C# 5

系统自带的 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 只支持到
`/langversion:5`（Roslyn 随 Visual Studio 提供）。所以源码里不要用字符串插值
`$"..."`、`?.`、表达式体成员等 C# 6+ 语法，否则编译失败。

## 排错

启动失败时启动画面会变红并给出「查看日志」，点一下用记事本打开**那一次启动**的日志。
也可以直接看 `launcher.log`（记录了**解析后的配置**，以及探测、启动、就绪的每一步）。

为什么每次启动单独一个日志、而不是固定的 `dsh-web.log`：`dsh` 会把自己 stdout 的重定向
句柄持有到进程结束，于是下一次启动的 `>` 打不开这个文件，`cmd` 会放弃该重定向，
**上一次的服务明明还活着，这次启动却会失败**。带时间戳的文件名不会撞车。

## 许可证

MIT——这个启动器是 [dsh-launcher](https://github.com/ww12366/dsh-launcher) 插件的一部分。
