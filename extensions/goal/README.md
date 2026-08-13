# Goal

`goal` 提供会话级持久目标、自动续跑和独立完成审查。

## 安装

```bash
pi install /absolute/path/to/ModerPiPlugins/extensions/goal
```

只安装这个目录不会加载 `infinite-retry` 或 `pi-team`。

## 命令

- `/goal <内容>`：设置并激活目标。
- `/goal`：查看当前目标状态。
- `/goal pause`：暂停目标和自动续跑，但保留目标。
- `/goal resume`：恢复目标。
- `/goal clear`：清空目标。
- `/goal set <内容>`：显式设置目标，适用于内容以控制关键字开头的情况。

目标随当前 Session 保存和恢复，并在普通用户回合前追加到 system prompt。激活后还提供两个 LLM 工具：

- `goal_review`：拉起独立只读 reviewer 子进程，检查真实仓库状态；只有返回 `approved: true` 才结束目标。
- `goal_wait_for_user`：需要用户补充信息、选择或批准时暂停自动续跑，直到用户输入或手动恢复。

reviewer 默认运行隔离的 `pi --mode json --no-session`，工具限制为 `read,grep,find,ls,bash`，并通过结构化 JSON 返回判定。

## 配置

- `PI_GOAL_REVIEW_MODEL`：reviewer 模型，如 `openai/gpt-5`。
- `PI_GOAL_REVIEW_EXTENSION_PATHS`：reviewer 额外加载的 provider 扩展路径，按平台路径分隔符分隔。
- `PI_GOAL_REVIEW_TIMEOUT_MS`：reviewer 超时，默认 `300000`。
