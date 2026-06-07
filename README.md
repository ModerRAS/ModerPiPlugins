# ModerPiPlugins

个人自用的 pi 插件合集。

当前已包含：

- `extensions/infinite-retry.ts`：给当前已注册的 provider stream 包一层“无限重试”逻辑。
- `extensions/goal.ts`：提供类似 Codex `/goal` 的会话级持久目标。

## 用法

直接临时加载：

```bash
pi -e ./extensions/infinite-retry.ts
```

作为本地 pi package 安装：

```bash
pi install /absolute/path/to/ModerPiPlugins
```

仓库根目录的 `package.json` 已声明 `pi.extensions`，安装后会自动加载 `extensions/*.ts`。

## `infinite-retry` 行为

- 默认对“当前已注册的 API provider”生效，而不是只写死某一家 provider。
- 默认对“任何以错误结束的请求”重试，不再依赖具体的 HTTP 状态字或错误关键字。
- 默认无限重试，退避时间为 `2s -> 4s -> 8s -> ...`，最大封顶 `1h`。
- 不重试以下情况：
  - 用户中断

这也意味着像 `stream_read_error` 这种只在 pi 侧弹出的通用错误，只要它最终表现为一次 `stopReason === "error"` 的失败，这个扩展就会继续重试。

为了支持“流式输出一半失败后也重试”，当前实现会先在扩展内部缓冲整次 provider 输出；如果这次最终失败，就整次丢弃并重试；如果最终成功，才把这一整次尝试的事件回放给 pi。

## 环境变量

可以用下面这些环境变量调整行为：

- `PI_INFINITE_RETRY_BASE_DELAY_MS`
  - 首次重试等待时间，默认 `2000`
- `PI_INFINITE_RETRY_MAX_DELAY_MS`
  - 退避上限，默认 `3600000`（1 小时）
- `PI_INFINITE_RETRY_MAX_ATTEMPTS`
  - 最大尝试次数；未设置时表示无限，建议在你怀疑会碰到永久性错误时手动设置一个上限
- `PI_INFINITE_RETRY_APIS`
  - 逗号分隔，仅包裹指定 API，例如 `openai-completions,anthropic-messages`
- `PI_INFINITE_RETRY_PROVIDERS`
  - 逗号分隔，仅对指定 provider 生效，例如 `openai,anthropic`
- `PI_INFINITE_RETRY_DEBUG`
  - 设为 `1` 时，重试会输出 `console.warn` 调试日志

示例：

```bash
PI_INFINITE_RETRY_PROVIDERS=openai,anthropic PI_INFINITE_RETRY_MAX_DELAY_MS=10000 pi -e ./extensions/infinite-retry.ts
```

## `/goal`

`/goal` 用来管理当前会话的持久目标，行为尽量贴近 Codex：

- `/goal <内容>`
  - 设置并激活当前目标；在空闲时会自动开始推进
- `/goal`
  - 查看当前目标状态
- `/goal pause`
  - 暂停目标与自动续跑，但保留目标文本
- `/goal resume`
  - 恢复目标与自动续跑
- `/goal clear`
  - 清空目标
- `/goal set <内容>`
  - 显式设置目标；用于避免和 `pause` / `resume` / `clear` 等关键字冲突

实现上它是 session 级持久状态：目标会随当前 session 保存和恢复，并在普通用户回合前追加到当回合 system prompt 里。

激活后它还有两个内置的 LLM 工具：

- `goal_review`
  - 当主 agent 认为目标可能已经完成时调用
  - 扩展不会直接相信主 agent，而是会拉起一个独立的 reviewer 子进程，让 reviewer 基于当前仓库状态、最近对话摘要和实际文件检查来决定是否通过
  - 只有 reviewer 返回 `approved: true`，扩展才会真正结束这个 goal
- `goal_wait_for_user`
  - 当主 agent 需要用户补信息、做选择或给批准时调用
  - 调用后会暂停自动续跑，直到用户下一次正常输入或手动 `/goal resume`

reviewer 默认用一个隔离的 `pi --mode json --no-session` 子进程运行，并限制在 `read,grep,find,ls,bash` 这些工具上；它的最终判定通过结构化 JSON 返回给扩展，而不是靠主 agent 自己一句“我做完了”。

如果你要覆盖 reviewer 的模型或额外加载 reviewer 侧的 provider 扩展，可以用：

- `PI_GOAL_REVIEW_MODEL`
  - reviewer 子进程使用的模型，例如 `openai/gpt-5` 或你自己的 `provider/model`
- `PI_GOAL_REVIEW_EXTENSION_PATHS`
  - reviewer 子进程额外加载的扩展路径列表；按当前平台路径分隔符分隔（Windows 为 `;`，类 Unix 为 `:`）
- `PI_GOAL_REVIEW_TIMEOUT_MS`
  - reviewer 子进程超时时间，默认 `300000`

## 限制说明

- 这个扩展的核心做法是覆盖当前 API 的 `streamSimple`，外面套一层 retry wrapper。
- 它会在 `session_start`、`model_select`、`before_agent_start` 时尝试重新包裹当前 API。
- 如果别的扩展在更晚的时候再次覆盖同一个 API，这个扩展需要等下一次模型切换或下一次请求前，才会重新接管。
- 因为现在是“任何错误都重试”，所以像错误 API key、quota、上下文溢出、模型名错误这类永久性失败，也可能一直重试到你手动中断，或者直到命中 `PI_INFINITE_RETRY_MAX_ATTEMPTS`。
- 因为要支持“半路失败后整次重试”，当前实现不再把 token 实时转发给 pi；你看到的内容会在某次尝试成功后一次性出现，或者在最终失败时一次性回放最后一次失败尝试。
