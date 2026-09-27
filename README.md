# Pi Local Extensions

一组轻量的 Pi 交互与显示增强扩展。

## 包含的扩展

| 扩展 | 功能 |
| --- | --- |
| `branch` | 通过 `/branch` 查看并切换当前仓库的本地 Git 分支 |
| `code` | 通过 `/code` 在 Pi 终端只读浏览代码、选区引用与 LSP 跳转 |
| `diff` | 通过 `/diff` 审阅工作区未提交改动并向 AI 反馈逐行评论 |
| `copy-rich` | 通过 `/copy-rich` 或 `/copy-rich-history` 将助手 Markdown 回复复制为飞书可识别的富文本 |
| `openai-codex-fast` | 通过 `/fast on` 和 `/fast off` 控制 OpenAI Codex priority 服务层级 |
| `otty-task-title` | 注册 `set_otty_task_title` 工具，用简短任务摘要更新 Otty 标签标题 |
| `quiet-tool-output` | 默认隐藏成功工具卡片和推理占位，保留执行状态、错误、编辑结果及图片 |
| `user-message-focus` | 为用户消息增加高对比度身份前缀 |
| `working-orb` | 增加月相工作动画、输入提醒和紧凑 footer |

Otty 自动生成的 `otty-integration.ts` 不在本仓库中，因为它包含安装机器上的应用路径和 IPC Socket 路径。

## 安装

```bash
pi install https://github.com/18896101294/pi-local-extensions
```

安装后完全退出并重启 Pi。

## 使用

### Git 分支切换

在 Git 仓库目录启动 Pi 后输入 `/branch`，可查看本地分支及当前分支标记。输入文字筛选，使用 `↑` / `↓` 选择、`Enter` 切换、`Esc` 取消。不会自动拉取远端分支、暂存改动或强制切换；Git 拒绝切换时会显示错误。

### 只读代码面板

在项目目录启动 Pi 后输入 `/code`，搜索文件名并按 `Enter` 打开。从主目录（`~`）启动 Pi 时不会扫描整个主目录，会提示你进入项目目录重新启动；其他目录遇到无权访问的子目录时会显示可读取文件，并提示列表不完整。代码视图按文件语言使用 Pi 当前主题的语法高亮，选区用背景色标记而不覆盖代码颜色；即使没有 LSP，支持的语言仍可高亮。代码视图使用方向键移动光标，`v` 标记选区起点、移动到终点后按 `y` 将选中行连同文件路径和行号放入对话输入框；不会自动发送，也不会改写文件。`f` 返回文件列表，`q` 退出。

对于已安装语言服务器的文件，将光标移到符号名称上，按 `g` 跳转定义、`r` 查看引用、`h` 查看悬停信息、`d` 查看诊断；引用列表默认选中非当前位置的引用，按 `Enter` 跳转、`Esc` 返回。当前识别本机 `csharp-ls`（C#，需 `.sln` 或 `.csproj` 项目）、`clangd`（C/C++）及 `sourcekit-lsp`（Swift），其他语言仍能只读浏览，不会自动下载语言服务器。C# 全局工具若不在 `PATH` 中，也会从 `~/.dotnet/tools/csharp-ls` 查找；本机已验证 `csharp-ls 0.16.0` 配合 .NET 8，可识别 `.sln` 和 `.csproj` 的完成通知；若旧项目存在 MSBuild 加载失败，面板会提示引用结果可能不完整，不会擅自更改项目的目标框架或依赖。文件搜索使用本机 `rg`；已忽略的文件不在列表中。面板只打开当前目录内不超过 1 MB 的文本文件，不跟随指向目录外的符号链接。

### 改动审阅

在已有提交的 Git 仓库目录输入 `/diff`，可浏览 **HEAD 与当前工作区**之间的差异：包含已暂存、未暂存以及未跟踪文件，也可能包含你自己手动修改的内容，并非只归属于 AI。文件列表以带语义颜色的 `A/M/D/R` 区分新增、修改、删除、重命名，选中后标记颜色仍保留。输入文件名筛选，按 `Enter` 打开；左侧是 `HEAD` 旧版，右侧是当前工作区，增删行分别着色，修改的旧/新行并排。未跟踪的新文件左侧为空、右侧显示文件内容（最多载入 8 MB）；`↑` / `↓` 和 `PageUp` / `PageDown` 导航。在差异行按 `c` 评论当前版，按大写 `C` 评论旧版，`Enter` 保存，可对多个位置批注；按大写 `S` 将全部评论及文件行号放入现有对话输入框，不自动发送或覆盖原有草稿。`Esc` 返回文件列表，`q` 放弃未发送评论并退出。PNG/JPEG/GIF/WebP/BMP 图片可在终端内预览旧／新缩略图（GIF 取首帧），需要本机 `ffmpeg` 和真彩色终端；不依赖 Kitty/iTerm 图片协议，仍可添加文件级评论。其他二进制文件、符号链接及超过 8 MB 的文件只展示文件级说明，不展开内容。

### 富文本复制

```text
/copy-rich
/copy-rich-history
```

`/copy-rich` 复制最后一条助手回复；`/copy-rich-history` 从当前会话分支中选择一条历史助手回复再复制。历史选择器每页显示 10 条，默认定位到最新回复，使用 `←` / `→` 翻页、`↑` / `↓` 选择、`Enter` 复制、`Esc` 退出。

两个命令都会在 macOS 上同时写入剪贴板的 HTML 与纯文本格式。粘贴到飞书时优先保留标题、粗体、列表、链接、代码块和表格等格式；目标编辑器不支持 HTML 时会回退为 Markdown 纯文本。

### Fast 模式

```text
/fast on
/fast off
```

只对 `openai-codex` provider 生效。开启后，请求会携带 `service_tier: "priority"`。

### 安静输出模式

```text
/quiet on
/quiet off
```

该模式默认开启。关闭后恢复 Pi 官方工具与推理渲染。

### 用户消息前缀

默认前缀为 `You: `。可在启动 Pi 前通过环境变量自定义：

```bash
PI_USER_MESSAGE_LABEL='我：' pi
```

### Otty 任务标题

扩展注册 `set_otty_task_title` 工具。模型调用该工具后，会通过终端标题同步当前 Otty 标签名称。该功能依赖 Otty 的标题支持。

## 安全边界

- 不包含 API Key、Token、密码或本机 IPC 配置。
- `branch` 只在用户主动选择后运行 `git switch`；不使用强制切换或自动暂存。
- `code` 不写文件、不自动发送消息；仅在打开支持的文件时运行本机语言服务器。
- `diff` 只读 Git 与工作区文件；评论仅在明确按 `S` 后写入输入框，不自动发送或修改文件。
- `copy-rich` 只在用户主动执行命令时读取最后一条助手回复并覆盖系统剪贴板。
- `openai-codex-fast` 只在用户主动开启时修改 OpenAI Codex 请求的服务层级。
- 显示类扩展只修改当前 Pi 进程中的 TUI 渲染，关闭会话时恢复官方行为。

## 开发验证

```bash
node -e 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8"))'
npm test
pi --no-extensions -e "$PWD" --list-models >/dev/null
```
