# dsh-launcher

[English](README.md) | 中文

把「无终端窗口的桌面启动器」做成一个 DSH 插件，用来**安装并自我修复**那个启动器。

## 先讲清楚一个限制

**插件本身不可能是启动器。** DSH 插件是在**已经启动完成的宿主进程内部**被加载的；而你想消掉的那个终端窗口，属于**启动 dsh 的那个进程**，它在任何插件代码运行之前就已经存在了。

所以插件能做、也正在做的是：**拥有并维护那个外部启动器**——把文件装好、保持版本最新、确保桌面快捷方式指向正确。真正消除终端窗口的，仍然是那个 GUI 子系统（`/target:winexe`）的 `DshLauncher.exe`。

## 它每次开机做什么

幂等、自愈，两步：

1. 把 `assets/` 里的启动器文件同步到 `%USERPROFILE%\.dsh\launcher\`
   （按文件大小比对，缺什么补什么，不会每次重写）
2. 确认桌面快捷方式指向 `DshLauncher.exe`——缺失就创建，指向错就修复

任一步失败都只会打一条警告，**不会**影响宿主启动：一个插件抛异常会让整个 DSH 起不来，
因为写不了桌面快捷方式就把整个 Harness 拖死是说不过去的。

## 安装

```sh
dsh plugin --profile web add D:\dsh\dsh-launcher
```

然后重启 `dsh web` 使其生效（bundle 层栈变化需要重启，`patchReload: live` 只监听
`cordis.patch.yml`，不监听 bundle 列表）。

## 配置

可选项，写在 profile 的 `cordis.patch.yml` 里。注意**必须放在 `config:` 下面**，
加载器只把那个子对象传给插件：

```yaml
- id: dsh-launcher
  name: 'dsh-launcher'
  config:
    install: true            # 是否复制/修复启动器文件，默认 true
    shortcut: true           # 是否管理桌面快捷方式，默认 true
    shortcutPath: 'C:\Users\me\Desktop\dsh.lnk'   # 默认按 shell 的桌面路径自动定位
    workspaceRoot: 'D:\dsh'  # 写进快捷方式的「起始位置」
```

## 顺带说明

非 Windows 平台会直接跳过并打一条说明——启动器是 Windows 专用的。

## 注意事项

**1. 它是 `link:` 依赖，源目录不能删。**
`dsh plugin add D:\dsh\dsh-launcher` 装进来的是链接（`node_modules\dsh-launcher` 是一个
指向 `D:\dsh\dsh-launcher` 的 junction）。开发方便，但代价是：把这个目录删掉或改名，
bundle 就找不到了，而 **DSH 对缺失 bundle 是「启动即失败」**（见 `dsh-app-boot` 文档：
"A missing bundle or one without a patch declaration fails startup loudly"）。

想要一份自包含、与源目录脱钩的安装：

```sh
cd D:\dsh\dsh-launcher
pnpm pack                                     # 产出 dsh-launcher-1.0.0.tgz
dsh plugin --profile web add .\dsh-launcher-1.0.0.tgz
```

这样文件会被复制进 profile 的 `node_modules`，之后改源码需要重新 pack + 重装。
两种方式按需选：改代码用 link，定下来用 tarball。

**2. 插件「拥有」`~/.dsh\launcher`。**
每次启动它会按**文件大小**比对并覆盖同名文件。如果你想直接改装好的启动器，
应该改插件里的 `assets/`（然后重新编译），否则下次开机改动会被同步覆盖回去。
`launcher.log`、`dsh-web.log`、`run-dsh-web.cmd` 和 `dsh.lnk.original-backup`
不在同步列表里，不会被碰。

**3. 开机开销约 0.3 秒。**
`apply()` 是同步的，其中约 290ms 花在那一次 PowerShell 调用上（要问 shell 桌面在哪、
快捷方式当前指向哪）。相对于 DSH 本身约 6 秒的启动可以忽略。

**4. 改了 `lib/index.js` 需要重启宿主。**
插件代码在宿主启动时被 `import` 并缓存，重启 `dsh web` 才会重新加载。
（`cordis.patch.yml` 的改动才走 live 热重载。）

## 目录

| 路径 | 说明 |
|---|---|
| `lib/index.js` | 宿主入口：`apply(ctx, config)`，只用 node 内置模块，零依赖 |
| `cordis.patch.yml` | bundle patch，把插件插进层栈 |
| `assets/` | 要安装到 `~/.dsh/launcher` 的启动器文件（含 `.cs` 源码与构建脚本，装完仍可自行重编译） |

启动器本身的用法、C# 5 编译限制、排错方法见 `assets/README.zh.md`（[English](assets/README.md)）。
