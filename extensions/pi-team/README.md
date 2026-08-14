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
- 所有 Boss、Lead、Worker 的正常文本都写入线性正式事件日志并在主 transcript 上屏；右侧被动面板只显示角色状态、派工/控制/错误摘要和 Inspector 细节。
- Boss 与 Lead 是事件驱动协调者，不直接承担实质项目实现：Boss 把一个连贯工作流交给一个 Lead，Lead 把一个连贯执行任务交给一个 Worker；只有真正独立的领域或并行任务才增加角色。处理当前事件后停止，没有新外部事件时保持 idle。
- Worker 的正常文本实时进入主 transcript；Worker `agent_settled` 后 Supervisor 必定通知直属 Lead。Lead 正在运行时通知用 `steer` 合入当前 loop，Lead idle 时自动改用 `prompt` 启动新 loop；临近报告会批量合并。
- 每次角色被唤醒，Supervisor 自动注入该角色上次事件游标之后、截至本次唤醒的全部可见正式事件。Lead 因此无需主动轮询也能拿到期间所有直属 Worker 消息；游标随 Team 状态持久化。
- 运行中的 Worker 每 10 分钟触发一次 Lead 巡检并继续重复，直到 Worker settled、cancelled 或退出。即使区间内没有新 assistant 文本，也会明确报告仍在运行。
- 侧栏和 `/agents` 的 `rN` 是持久化 `runCount`，只按真实 RPC `agent_start` 递增，用于区分一轮内的多条 assistant 消息与多次 agent loop。
- 委派数量按任务动态决定；4 是安全上限而不是目标。新角色必须有具体的独立工作理由，并优先复用现有合适角色。
- Supervisor IPC 只监听 loopback，并验证 `agentId + actorEpoch + instanceToken`。
- 意外退出会以新的 epoch/token 从 Session 副本恢复，并要求角色先检查实际工作区状态。
- `/new` 创建空 Team；`/resume` 恢复 Team；`/fork` 复制 Team 前缀；树分支切换会停止旧角色并恢复目标分支。

## 当前限制

Windows 角色进程属于 `KILL_ON_JOB_CLOSE` Job Object：Node 运行时使用 libuv 的进程级 Job，Bun 运行时通过 `bun:ffi` 显式调用 `kernel32` 创建 Job。正常取消仍调用 `taskkill /T /F` 以立即等待完整进程树退出。真实 crash smoke 已验证只强杀 Supervisor PID 后 Boss 自动终止。侧栏目前是固定状态 widget，Inspector 是右侧 overlay，而不是永久占宽的双栏布局。

完整协议、状态模型和设计取舍见 [DESIGN.md](./DESIGN.md)。
