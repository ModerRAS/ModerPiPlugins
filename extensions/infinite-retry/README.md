# Infinite Retry

`infinite-retry` 为 Pi provider stream 增加失败重试。它默认包装当前已注册的 API provider，并对任何以错误结束的请求执行指数退避；上下文溢出由 Pi 原生 compaction 接管，不进行无意义重试。

## 安装

```bash
pi install /absolute/path/to/ModerPiPlugins/extensions/infinite-retry
```

只安装这个目录不会加载 `goal` 或 `pi-team`。

## 行为

- 默认无限重试，退避为 `2s -> 4s -> 8s -> ...`，最大 `1h`。
- 用户中断不重试。
- 为支持流式输出中途失败后的完整重试，每次 provider 输出先在扩展内缓冲；成功后一次性回放，失败尝试整体丢弃。
- API key、quota、模型名等永久错误也可能一直重试，建议在排障时设置最大尝试次数。

## 配置

- `PI_INFINITE_RETRY_BASE_DELAY_MS`：首次等待，默认 `2000`。
- `PI_INFINITE_RETRY_MAX_DELAY_MS`：退避上限，默认 `3600000`。
- `PI_INFINITE_RETRY_MAX_ATTEMPTS`：最大尝试次数；未设置表示无限。
- `PI_INFINITE_RETRY_APIS`：逗号分隔的 API allowlist。
- `PI_INFINITE_RETRY_PROVIDERS`：逗号分隔的 provider allowlist。
- `PI_INFINITE_RETRY_DEBUG=1`：输出重试调试日志。

示例：

```bash
PI_INFINITE_RETRY_PROVIDERS=openai,anthropic PI_INFINITE_RETRY_MAX_DELAY_MS=10000 pi -e ./extensions/infinite-retry/index.ts
```
