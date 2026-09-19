# dsh-launcher

[English](README.md) | 中文

把「无终端窗口的桌面启动器」做成一个 DSH 插件，用来**安装并自我修复**那个启动器。

## 先讲清楚一个限制

**插件本身不可能是启动器。** DSH 插件是在**已经启动完成的宿主进程内部**被加载的；而你想消掉的那个终端窗口，属于**启动 dsh 的那个进程**，它在任何插件代码运行之前就已经存在了。

所以插件能做、也正在做的是：**拥有并维护那个外部启动器**——把文件装好、保持最新、确保桌面快捷方式指向正确。真正消除终端窗口的，仍然是那个 GUI 子系统（`/target:winexe`）的 `DshLauncher.exe`。

## 环境要求

* **Windows。** 其他平台只打一行日志然后什么都不做。插件**故意不声明** `os: ["win32"]`，这样你把 profile 同步到别的机器上时仍然装得上、起得来，而不是因为一个取不到的依赖直接启动失败。
* Node 20 以上（任何 DSH 安装都满足）。

## 安装

从 GitHub 安装：

```sh
dsh plugin --profile web add github:ww12366/dsh-launcher
```

或从本地目录安装——这是**链接**而不是复制，先看下面的注意事项：

```sh
dsh plugin --profile web add C:\path\to\dsh-launcher
```

然后重启 `dsh web` 使其生效（bundle 层栈变化需要重启，`patchReload: live` 只监听 `cordis.patch.yml`，不监听 bundle 列表）。

## 它每次开机做什么

幂等、自愈：

1. 把 `assets/` 里的启动器文件同步到 `%USERPROFILE%\.dsh\launcher\`（按文件大小比对，只补缺的和变了的）
2. 在那里重新生成 `launcher.ini`——见下一节
3. 确认桌面快捷方式指向 `DshLauncher.exe`——缺失就创建，指向错就修复

任何一步失败都只打一条警告，**不会**影响宿主启动：一个插件抛异常会让整个 DSH 起不来，因为写不了桌面快捷方式就把整个 Harness 拖死是说不过去的。

## 这个包里没有任何一处写死某台机器

包里不带任何绝对路径。每次开机插件会在 exe 旁边写一份 `launcher.ini`，那是启动器唯一获知该用什么的地方：

```ini
nodeExe=D:\node manager\node.exe     # 运行中宿主的 process.execPath
workspaceRoot=D:\dsh                 # 宿主自己的工作目录
port=3080
```

`DshLauncher.exe` 用最简单的 `key=value` 读它（不依赖 JSON），文件不存在时优雅回退：`node` 走 `PATH`、工作目录用用户主目录、端口 3080。所以**删掉这个文件只会让启动器更通用，不会让它坏掉**。每次开机也会把解析结果记进 `launcher.log`：

```text
config: port=3080; node=D:\node manager\node.exe; cwd=D:\dsh
```

## 配置

可选项，写在 profile 的 `cordis.patch.yml` 里。注意**必须放在 `config:` 下面**，加载器只把那个子对象传给插件：

```yaml
- id: dsh-launcher
  name: 'dsh-launcher'
  config:
    install: true                                  # 是否同步启动器文件，默认 true
    shortcut: true                                 # 是否管理桌面快捷方式，默认 true
    shortcutPath: 'C:\Users\me\Desktop\dsh.lnk'    # 默认按 shell 的桌面路径自动定位
    workspaceRoot: 'D:\work'                       # 默认取宿主的工作目录
    port: 3080                                     # 默认 3080
    exitOnBrowserClose: true                       # 默认 false，见下一节
    exitGraceSeconds: 25                           # 默认 25
    exitOnlyWhenIdle: true                         # 默认 true
```

`workspaceRoot` 就是快捷方式里记录的「起始位置」，dsh 会把它当作工作区根目录。默认取宿主自己的工作目录——按 DSH 自己的定义，那**就是**工作区根目录。

## 关掉网页可以让宿主自己退出

默认关闭：结束一个宿主是很重的手段，一个包如果擅自这么做会让人很难受。用 `exitOnBrowserClose: true` 打开。

打开之后，启动器和宿主就闭环了：快捷方式把服务拉起来，最后一个网页关闭后服务自己结束。不开的话，宿主是个脱离终端的后台进程，能活过标签页——于是下次点快捷方式只是**连回一棵旧树**：你后来装的插件不在里面，而且表面上看不出任何异常。

**怎么判断"网页还在不在"。** DSH 没有暴露浏览器连接数，WebServer 服务的 socket 表也是私有的，所以插件不去猜流量，而是**直接问网页**：往服务出去的 `index.html` 里插一行 `<script>`，它对本插件拥有的一个 SSE 路由开 `EventSource`。一个打开的页面一条连接，所以"没有连接"就等于"没有页面"。

**为什么设计得这么保守。** 一次错误的"没人在看"就会杀掉你的会话，所以：

* **从未有过页面连接时绝不退出**——注入脚本被拦或失败，只会让这个功能失效，绝不会致命；
* 等满 `exitGraceSeconds`，所以**刷新不会被当成关闭**；
* **只要有 agent 处于 `running` 就拒绝退出**，不会掐断正在进行的工作，并在下一个宽限期后重新检查；
* 退出走 `ctx.appExit`——启动器那条"先 dispose 再退出"的有界路径，而不是 `process.exit`。

会话是持久化的，所以宿主消失不会丢记录；但**正在跑的一轮**是另一回事，`exitOnlyWhenIdle` 就是为它准备的。只有当你确实想让页面的生命周期决定宿主的生死时，才把它设成 `false`。

## 也可以直接从界面改

包里带了一个浏览器半边，所以这是一个**设置在左侧列表里的一级分区**（和「皮肤中心」用的是同一个 `settings.section` 槽），不需要你去改 YAML：

* **立刻关闭**——最后一个网页一关就结束。下限约 1 秒：刷新页面会把页面的连接断掉再重连，真正做到 0 秒的话，**按一下刷新就会把宿主杀掉**。
* **设定秒数后关闭**——等 N 秒（1–86400）。
* **永不关闭**——服务留在后台。

选择存在 `~/.dsh/launcher/settings.json`，改动**立即作用于正在运行的宿主**，不需要重启。读写走 `GET|POST /dsh-launcher/settings`；已保存的选择优先于 profile 里的配置，所以那几项配置只决定初始值。

## 注意事项

**本地路径安装是 `link:`，源目录不能删。**
`dsh plugin add C:\path\to\dsh-launcher` 装进来的是 junction 而不是副本。把这个目录删掉或改名，bundle 就找不到了，而 **DSH 对缺失 bundle 是「启动即失败」**（见 `dsh-app-boot`：*A missing bundle or one without a patch declaration fails startup loudly*）。改从 GitHub 安装就没有这个问题。本地链接适合边改边试，定下来之后反而是隐患。

**插件「拥有」`~/.dsh\launcher`。**
每次启动它会按**文件大小**比对并覆盖同名文件。想改装好的启动器，应该改插件里的 `assets/`（然后重新编译），否则下次开机改动会被同步覆盖回去。`launcher.log`、`dsh-web-*.log`、`run-dsh-web.cmd`、`launcher.ini` 和 `dsh.lnk.original-backup` 不在同步列表里，不会被碰。

**开机开销约 0.3 秒。**
`apply()` 是同步的，其中约 290ms 花在那一次 PowerShell 调用上（要问 shell 桌面在哪、快捷方式当前指向哪）。相对于 DSH 本身数秒的启动可以忽略。

**改了 `lib/index.js` 需要重启宿主。**
插件代码在宿主启动时被 `import` 并缓存，只有 `cordis.patch.yml` 的改动才走 live 热重载。

## 目录

| 路径 | 说明 |
|---|---|
| `lib/index.js` | 宿主入口：`apply(ctx, config)`，只用 node 内置模块，零依赖 |
| `client/client.js` | 浏览器半边：那个设置分区。手写 ESM，无需构建步骤 |
| `cordis.patch.yml` | bundle patch，把插件插进层栈 |
| `assets/` | 要安装到 `~/.dsh/launcher` 的启动器文件（含 `.cs` 源码与构建脚本，装完仍可自行重编译） |
| `test/` | `node --test` 测试套件，用假宿主上下文驱动生命周期与设置路由 |
| `LICENSE` | MIT |

启动器本身的用法、C# 5 编译限制、排错方法见 `assets/README.zh.md`（[English](assets/README.md)）。

## 许可证

MIT，见 [LICENSE](LICENSE)。
