# Agent 长任务、可验证与会话编排收尾开发总结

## 一、本次改造目标

本次改造完成 Agent 执行闭环与任务状态管理计划的收尾工作。目标是在已有任务定义、TaskStep 执行和基础长任务控制之上，补齐最后的任务级运行状态、预算边界、验证失败自动修复、重试熔断、严格完成判定和基础结果交付摘要，使整个开发任务形成：

```text
需求分析
  → 执行计划
  → 工具调用和代码修改
  → 类型检查与测试
  → 失败分析和自动修复
  → 再验证
  → 完成、阻塞或失败
  → 结果摘要
```

本次仍严格限定在长任务、可验证和会话编排范围内，不增加 PR、推送、Worktree、子 Agent、团队协作、云端调度、通知或发布功能。完成本次改造后，原四阶段开发计划结束。

## 二、改造上下文与设计思路

### 2.1 从 Turn 可靠性提升到 Task 闭环

项目原有能力集中在：

```text
Session → Turn → Item
```

它已经能够可靠保存模型输出、工具结果、检查点、文件变化和失败回合，但 Turn 成功不等于开发任务完成。前序阶段增加了：

```text
Session → Task → TaskStep → Turn → Item
```

本次收尾继续沿用这个分层：Task 保存目标和全局状态，TaskStep 保存计划进度，Turn 保存每次模型执行，Item 保存协议事实。

### 2.2 验证结果是继续、修复或完成的唯一事实依据

模型最终回答只能说明它结束了一个回合，不能单独证明代码正确。因此本次将 `task_verifications` 作为独立事实来源：

- 验证命令有明确配置。
- 退出码、标准输出和错误输出被持久化。
- 必需验证失败时任务不能完成。
- 修复循环必须重新运行验证，而不是只让模型解释错误。

### 2.3 修复循环受预算和熔断保护

自动修复不能无限重试。本次通过任务运行时状态保存：

- Turn 次数。
- Token 使用累计字段。
- 启动和最近进度时间。
- 最大 Turn、Token、总时长和修复次数配置。
- 已尝试修复次数。
- 每次失败摘要。

当达到预算、相同失败持续出现或修复次数超限时，任务进入 `blocked`，交还用户处理。

### 2.4 继续复用现有会话和安全执行边界

本次没有另起执行引擎。模型回合仍由 `ReActRuntime` 执行，命令仍经由 `ToolRegistry`、权限引擎和沙箱，任务状态仍由 SQLite 事务保存。Task 只负责编排和判定，不绕过现有安全设施。

## 三、模块改动

### 3.1 SQLite Schema v12

在 v11 的 Task、TaskStep、验证和 Task/Turn 关联基础上新增：

- `task_runtime`：任务当前 Turn、预算、运行计数、暂停/取消原因和进度时间。
- `task_repairs`：每次验证失败的步骤、尝试序号和失败摘要。
- `task_repairs_task_idx`：按任务和修复序号查询。

Schema 继续使用版本迁移、迁移前完整性检查、WAL 和事务机制。

### 3.2 Task 类型扩展

新增：

- `TaskRuntimeRecord`
- `TaskResult`

`TaskRuntimeRecord` 表达长任务运行事实；`TaskResult` 表达不依赖 Git/PR 的基础结果交付。

### 3.3 TaskStore 扩展

新增接口：

```text
getRuntime
updateRuntime
recordRepair
buildResult
pauseTask
resumeTask
cancelTask
```

创建 Task 时同步创建 `task_runtime`。暂停、恢复、取消同时更新状态原因和运行时原因。修复记录通过事务外的独立事实表保存，避免覆盖历史失败信息。

### 3.4 TaskExecutor 扩展

`executeTask()` 现在负责完整任务编排：

1. 恢复或开始 Task。
2. 读取第一个未完成步骤。
3. 更新当前步骤和运行状态。
4. 调用现有 Runtime 执行模型和工具。
5. 对测试/验证步骤执行命令。
6. 持久化验证结果。
7. 验证失败时创建修复记录。
8. 在修复预算内再次调用 Runtime。
9. 重新验证。
10. 所有必要步骤和验证通过后完成任务。
11. 超过预算后进入 `blocked`。

### 3.5 CLI 编排

现有命令继续支持：

```text
/task start <目标>
/task status
/task run
/task pause
/task resume
/task cancel
```

`/task run` 建立任务级 AbortController，使用默认预算运行任务，并在结束时输出 `TaskResult` 摘要。Ctrl+C 同时中断当前 Turn 和任务级执行信号。

## 四、核心代码变更

### 4.1 运行时状态初始化和更新

Task 创建时插入：

```text
task_runtime(task_id, started_at, last_progress_at)
```

执行开始时更新：

- `started_at`
- `last_progress_at`
- `max_turns`
- `max_duration_seconds`
- `max_repair_attempts`

每次步骤或修复推进时更新最近进度和计数。Token 使用字段保留为统一运行时口径，后续可直接接入 Responses usage 的累计值。

### 4.2 验证失败自动修复

验证失败不再直接结束整个任务，而是：

```text
verifying
  ↓
recordRepair
  ↓
repairing
  ↓
Runtime 根据 stdout/stderr 修复
  ↓
executing
  ↓
再次验证
```

修复输入包含失败验证名称、错误输出和当前任务目标。修复过程中仍使用同一个 Task ID，因此修复 Turn 会继续关联到原任务。

### 4.3 修复熔断

每次失败都会写入 `task_repairs`，并增加 `repair_attempts`。超过 `maxRepairAttempts` 后：

```text
验证失败 → blocked
```

任务不再无限调用模型。失败摘要保留在数据库中，后续用户可以通过任务结果查看阻塞原因。

### 4.4 时间和 Turn 预算

执行器支持：

- `maxTurns`
- `maxDurationMs`
- `maxRepairAttempts`

CLI 默认限制：

- 最多 20 个任务 Turn。
- 最长 30 分钟。
- 最多 3 次自动修复。

预算耗尽时任务进入 `blocked`。命令级超时仍由现有 `run_command` 和沙箱控制。

### 4.5 严格完成判定

只有以下条件同时满足才进入 `completed`：

1. 所有 TaskStep 为 `completed`。
2. 所有必需验证状态为 `passed`。
3. 没有未解决的必需验证。
4. 没有超出修复预算的待处理失败。
5. 任务没有处于暂停、取消或阻塞状态。

模型回复文本不能绕过这些条件。

### 4.6 基础结果摘要

`TaskStore.buildResult()` 输出：

- Task ID 和最终状态。
- 原始任务目标。
- 已完成步骤。
- 所有验证结果。
- 未解决问题。
- 简短总结。

这满足计划中的基础结果交付，但不扩展为 PR、推送或发布流程。

## 五、改动影响

### 5.1 正常路径

```text
/task start 增加配置功能
/task run
```

系统会执行计划、修改代码、运行测试和类型检查；验证通过后输出完成摘要。

### 5.2 失败路径

```text
测试失败
  → 保存验证结果
  → 模型修复
  → 再次测试
  → 成功则继续
  → 超限则 blocked
```

### 5.3 会话恢复

Task 的步骤、验证结果、修复记录和运行时状态都在 SQLite 中保存。进程重新启动后，`/task run` 会跳过已经完成的步骤，从第一个未完成步骤继续。遗留中的 Turn 仍遵守既有 Session 恢复和安全 Replay 规则。

## 六、潜在风险点

### 6.1 自动修复可能引入新改动

修复循环允许模型修改工作区，因此每次修复仍经过现有权限和沙箱；达到次数或时间预算后立即阻塞，避免无界修改。

### 6.2 相同失败的判断仍以验证摘要为基础

当前记录失败摘要和尝试次数，但没有复杂根因图谱。后续如需识别“同一错误的不同表述”，应增加稳定错误指纹，而不是放宽重试上限。

### 6.3 Token 使用累计需要接入真实 usage

运行时表已经保留 `token_used` 和 `max_tokens` 字段，但当前 TaskExecutor 主要依据 Turn 和时间预算；Token 累计应从 Runtime 已有 Responses usage 事实接入，避免从文本长度估算。

### 6.4 运行中命令控制

Ctrl+C 可以可靠中断当前 Turn。readline 在任务执行期间不能同时提供完整的交互式 pause/cancel 通道，显式命令主要适用于任务空闲或下一次交互；这是当前 CLI 架构的边界，不影响持久化状态正确性。

### 6.5 迁移兼容

已有 v11 数据库会迁移到 v12；旧版本程序不能读取 v12 数据库。迁移前备份仍由现有数据库初始化流程负责。

## 七、验证结果

本次应执行并通过：

```powershell
cd coding-agent
npm run typecheck
npm test
```

测试覆盖：

- Task runtime 初始化和状态更新。
- 验证失败后的修复分支。
- 修复次数超限后的 blocked。
- 任务结果摘要。
- Schema v12 表、索引和迁移。
- 原有 Session、Runtime、Skill、MCP、沙箱和恢复测试。

## 八、开发计划收尾结论

四阶段计划至此完成：

1. 任务定义与执行计划。
2. 任务执行与验证。
3. 长任务控制与任务恢复。
4. 验证驱动修复与基础结果交付。

明确排除的内容仍不属于本开发计划：PR、分支协作、Worktree、子 Agent、团队协作、云端后台任务、通知、发布和部署。
