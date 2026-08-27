# Pi Local Extensions

一组轻量的 Pi 交互与显示增强扩展，当前适配 Pi 0.84.x。

## 包含的扩展

| 扩展 | 功能 |
| --- | --- |
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
- `openai-codex-fast` 只在用户主动开启时修改 OpenAI Codex 请求的服务层级。
- 显示类扩展只修改当前 Pi 进程中的 TUI 渲染，关闭会话时恢复官方行为。

## 开发验证

```bash
node -e 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8"))'
pi --no-extensions -e "$PWD" --list-models >/dev/null
```
