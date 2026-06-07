# ModerPiPlugins

个人自用的 pi 插件合集。

当前已包含：

- `extensions/infinite-retry.ts`：给当前已注册的 provider stream 包一层“无限重试”逻辑。

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
- 默认无限重试，退避时间为 `2s -> 4s -> 8s -> ...`，最大封顶 `30s`。
- 不重试以下情况：
  - 用户中断

这也意味着像 `stream_read_error` 这种只在 pi 侧弹出的通用错误，只要它最终表现为一次 `stopReason === "error"` 的失败，这个扩展就会继续重试。

为了支持“流式输出一半失败后也重试”，当前实现会先在扩展内部缓冲整次 provider 输出；如果这次最终失败，就整次丢弃并重试；如果最终成功，才把这一整次尝试的事件回放给 pi。

## 环境变量

可以用下面这些环境变量调整行为：

- `PI_INFINITE_RETRY_BASE_DELAY_MS`
  - 首次重试等待时间，默认 `2000`
- `PI_INFINITE_RETRY_MAX_DELAY_MS`
  - 退避上限，默认 `30000`
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

## 限制说明

- 这个扩展的核心做法是覆盖当前 API 的 `streamSimple`，外面套一层 retry wrapper。
- 它会在 `session_start`、`model_select`、`before_agent_start` 时尝试重新包裹当前 API。
- 如果别的扩展在更晚的时候再次覆盖同一个 API，这个扩展需要等下一次模型切换或下一次请求前，才会重新接管。
- 因为现在是“任何错误都重试”，所以像错误 API key、quota、上下文溢出、模型名错误这类永久性失败，也可能一直重试到你手动中断，或者直到命中 `PI_INFINITE_RETRY_MAX_ATTEMPTS`。
- 因为要支持“半路失败后整次重试”，当前实现不再把 token 实时转发给 pi；你看到的内容会在某次尝试成功后一次性出现，或者在最终失败时一次性回放最后一次失败尝试。
