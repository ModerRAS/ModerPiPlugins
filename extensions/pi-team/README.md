# Pi Team

`pi-team` 在一个 Pi TUI 中管理多个独立、持久的 Pi RPC Session：

```text
用户
  -> Boss（最多 3 个）
     -> Department Lead（每个 Boss 最多 4 个）
        -> Worker（每个 Lead 最多 4 个）
```

Supervisor、Boss、Lead 和 Worker 都由同一个插件入口实现。Supervisor 启动子 Pi 时注入内部实例配置；用户不需要也不应该单独安装角色扩展。

## 安装

```bash
pi install /absolute/path/to/ModerPiPlugins/extensions/pi-team
```

安装 `pi-team` 不会安装或加载同仓库的 `goal` 与 `infinite-retry`。

## 命令

- `/boss <task>`：创建并聚焦一个新 Boss；现有 Boss 继续运行。
- `/to <agent-id> <message>`：定向纠正或补充，不改变当前焦点。
- `/focus <boss-id>`：把普通输入路由到指定 Boss。
- `/cancel <agent-id>`：取消角色及其下属。
- `/agents`：查看角色状态。
- `/view [limit]`：查看最近正式群聊事件。
- `/inspect <agent-id>`：让右侧被动 Inspector 持续显示该角色的工具和 RPC 细节；`/inspect off` 返回团队活动。
- `/team`：查看 Team 摘要和内部 IPC 地址。

Boss 使用 `team_delegate` 创建 Lead，Lead 使用同一工具创建 Worker；两者还可使用 `team_send`、`team_read`、`team_list` 和 `team_cancel`。Worker 只有读取、列举和直属上下级通信能力。

## 行为

- 每个角色是独立的 `pi --mode rpc` 进程和 Session，并继承用户正常安装的资源。
- 所有角色直接共享当前工作目录；插件不加锁、不创建 worktree，也不自动合并。
- 普通角色文本写入线性正式事件日志；工具调用、stderr 和协议细节只进入 Inspector 缓冲。
- Supervisor IPC 只监听 loopback，并验证 `agentId + actorEpoch + instanceToken`。
- 意外退出会以新的 epoch/token 从 Session 副本恢复，并要求角色先检查实际工作区状态。
- `/new` 创建空 Team；`/resume` 恢复 Team；`/fork` 复制 Team 前缀；树分支切换会停止旧角色并恢复目标分支。

## 当前限制

Windows 角色进程属于 `KILL_ON_JOB_CLOSE` Job Object：Node 运行时使用 libuv 的进程级 Job，Bun 运行时通过 `bun:ffi` 显式调用 `kernel32` 创建 Job。正常取消仍调用 `taskkill /T /F` 以立即等待完整进程树退出。真实 crash smoke 已验证只强杀 Supervisor PID 后 Boss 自动终止。侧栏目前是固定状态 widget，Inspector 是右侧 overlay，而不是永久占宽的双栏布局。

完整协议、状态模型和设计取舍见 [DESIGN.md](./DESIGN.md)。
