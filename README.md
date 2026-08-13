# ModerPiPlugins

个人自用的 Pi 插件源码仓库。每个插件都是独立 Pi package，安装其中一个不会加载另外两个。

## 插件

| 插件 | 安装目录 | 用途 |
| --- | --- | --- |
| `goal` | `extensions/goal` | 会话级持久目标、自动续跑和独立完成审查 |
| `infinite-retry` | `extensions/infinite-retry` | provider stream 失败后的指数退避重试 |
| `pi-team` | `extensions/pi-team` | 一个 TUI 中运行多个独立 Boss、Lead 和 Worker RPC Session |

## 安装

只安装需要的插件：

```bash
pi install /absolute/path/to/ModerPiPlugins/extensions/goal
pi install /absolute/path/to/ModerPiPlugins/extensions/infinite-retry
pi install /absolute/path/to/ModerPiPlugins/extensions/pi-team
```

也可以临时加载单个入口：

```bash
pi -e ./extensions/goal/index.ts
pi -e ./extensions/infinite-retry/index.ts
pi -e ./extensions/pi-team/index.ts
```

不要安装仓库根目录；根 `package.json` 只是 private workspace 清单，不声明任何 Pi extension。

详细用法与限制见各插件目录中的 `README.md`。
