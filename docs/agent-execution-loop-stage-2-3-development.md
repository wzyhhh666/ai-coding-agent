# Agent 执行闭环阶段二、三代码变更总结

## 一、本次改造目标

本次在已完成的阶段一“任务定义与执行计划”基础上，完整实现阶段二“任务执行与验证”和阶段三“长任务控制与任务恢复”。目标是让已生成的 `Task` 和 `TaskStep` 真正驱动现有 Coding Agent Runtime，完成工具调用、代码修改、测试验证，并支持任务跨多个 Turn 持续运行、暂停、恢复和取消。

改造前，阶段一只能得到：

```text
用户目标 → Task → TaskStep → planned
```

本次改造将其扩展为：

```text
planned
  ↓
executing → ReActRuntime → 文件/命令工具
  ↓
verifying → run_command → VerificationResult
  ├── 通过 → 下一个 TaskStep
  └── 失败 → 当前任务 failed，保留证据
```

并补充任务级控制：

```text
执行中 → paused → resume → executing
执行中 → cancel → cancelled
Ctrl+C → 取消当前 Turn，并保留安全上下文
```

本次没有实现阶段四的“验证失败自动修复循环”和最终交付完成判定；验证失败会被准确记录并停止当前任务，不会伪装成完成。

## 二、设计思路

### 2.1 复用现有 Runtime，而不是重新实现工具执行

现有 `ReActRuntime` 已经负责 Responses API、多步工具调用、文件追踪、权限审批、沙箱、Turn 持久化和取消。本次新增的是任务编排层：

```text
TaskExecutor
    ↓
ReActRuntime.runTurn(taskId)
    ↓
ToolRegistry
    ↓
read/write/edit/run_command、权限和沙箱
```

这样可以保留既有工具安全边界，并让 TaskStep 成为执行顺序和状态的上层控制对象。

### 2.2 TaskStep 是最小执行单元

执行器按 `sequence` 顺序读取步骤，跳过已经完成的步骤，从第一个非完成步骤继续。启动步骤时同时：

- 将步骤置为 `in_progress`。
- 将 Task 的 `current_step_id` 指向该步骤。
- 将 Task 置为 `executing`。

步骤完成后保存 `completed`；发生验证失败时保存 `failed`。因此进程重启或任务恢复时不需要猜测已经执行到哪里。

### 2.3 验证是独立持久化对象

普通 `run_command` 是模型可以调用的工具，而任务验证是由任务编排器触发的确定性检查，两者职责不同。本次新增 `task_verifications` 表和 `VerificationResult`：

- 验证命令、步骤、超时和是否必需单独保存。
- 验证执行的退出码、stdout、stderr、开始和结束时间单独保存。
- 验证通过与否不依赖模型最后一句话。

当前执行器对 `testing` 步骤运行 `npm test`，对 `verification` 步骤运行 `npm run typecheck` 和 `npm test`。命令仍通过已有 `ToolRegistry.execute("run_command")` 进入权限和沙箱体系。

### 2.4 验证失败暂不自动修复

阶段四才负责“失败 → 分析 → 修复 → 再验证”。阶段二、三只负责可靠执行和证据保存。因此任何必需验证失败都会：

1. 保存失败的 `VerificationResult`。
2. 将当前步骤置为 `failed`。
3. 将 Task 标记为 `failed`，状态原因设为“验证未通过”。
4. 停止后续步骤，避免在已知失败状态下继续修改工作区。

这保证阶段边界清晰，也为阶段四提供完整失败上下文。

### 2.5 长任务控制使用现有 AbortSignal 和安全边界

任务执行器接收 `AbortSignal`。Ctrl+C 仍由现有 `CliTurnController` 处理：第一次中断当前 Turn，任务编排器收到中止后将 Task 标记为可恢复的 `paused`，而不是删除历史或标记完成。

已经完成的工具结果仍由现有 Runtime/SessionRecorder 先落库；未完成的模型上下文继续遵守现有回滚规则。暂停和恢复只控制 Task 级推进，不改变权限、沙箱和工作区边界。

## 三、模块改动

### 3.1 `task/types.ts`

新增：

- `VerificationDefinition`
- `VerificationResult`

它们分别表示验证配置和验证事实。已有 Task、TaskStep、TaskStatus 类型继续作为任务状态中心。

### 3.2 `task/store.ts`

新增任务执行所需的存储操作：

```text
startStep(taskId, stepId)
completeStep(taskId, stepId, status)
addVerification(taskId, definition)
listVerifications(taskId, stepId?)
saveVerificationResult(taskId, verificationId, result)
pauseTask(taskId)
resumeTask(taskId)
cancelTask(taskId)
```

这些操作继续复用工作区隔离和事务机制。

`startStep` 同时更新步骤状态、Task 当前步骤和 Task 执行状态；`completeStep` 更新步骤状态并触发 Session 更新时间；暂停、恢复和取消通过既有状态迁移白名单执行。

### 3.3 新增 `task/executor.ts`

`executeTask()` 是阶段二、三的任务编排器，职责是：

1. 检查 Task 是否处于 `planned`、`paused` 或 `executing`。
2. 将任务置为 `executing`。
3. 按步骤顺序跳过已完成步骤。
4. 调用注入的 `runTurn(input, taskId, signal)`。
5. 对 testing/verification 步骤运行验证命令。
6. 保存验证定义和结果。
7. 在验证失败时停止并标记失败。
8. 所有步骤完成后将 Task 标记为 `completed`。

执行器通过依赖注入接收 `commandExecutor` 和 `runTurn`，因此任务领域逻辑不直接依赖 CLI、OpenAI SDK 或具体工具实现。

### 3.4 `runtime.ts` 和 `session/store.ts`

为 `SessionRecorder.startTurn` 增加可选 `taskId`，并在 `turns` 表中保存 Task 关联：

```text
Task → turns.task_id → Turn
```

`ReActRuntime.runTurn` 的 `RunTurnOptions` 增加 `taskId`，启动 Turn 时把它传给记录器。这样任务执行产生的每个 Turn 都能追溯回 Task，同时不改变普通 Turn 的调用方式；未提供 `taskId` 时仍按原逻辑运行。

### 3.5 `cli_commands.ts` 和 `cli.ts`

新增命令：

```text
/task run
/task pause
/task resume
/task cancel
```

CLI 新增 `runManagedTask()`：

- 获取当前 Session 最近 Task。
- 建立任务级 `AbortController`。
- 调用 `executeTask()`。
- 使用当前 `ToolRegistry` 执行验证命令。
- 将每个步骤的模型请求关联到 Task ID。
- 显示最终 Task 状态和步骤状态。

Ctrl+C 处理器在取消当前 Turn 的同时通知任务级 AbortController。任务控制命令复用 TaskStore 的状态迁移，不直接修改数据库字段。

### 3.6 `sqlite.ts`

Schema 从 v10 升级到 v11，新增：

```text
turns.task_id
turns_task_sequence_idx
task_verifications
task_verifications_task_idx
```

`task_verifications` 通过外键关联 Task 和 TaskStep，Session 删除时会级联清理 Task、步骤、验证记录；Turn 删除或 Task 删除不会留下孤立验证事实。

### 3.7 README 和测试

README 新增：

- 任务执行与验证能力说明。
- 长任务控制能力说明。
- `/task run`、`pause`、`resume`、`cancel` 命令说明。

新增 `tests/task_executor.test.ts`，并扩展 CLI 命令和 SQLite Schema 测试。

## 四、核心代码变更

### 4.1 Task 到 Turn 的关联

原有 Runtime 调用兼容：

```ts
runTurn(input, output, writeText, { signal });
```

任务执行时增加：

```ts
runTurn(input, output, writeText, { signal, taskId });
```

`SessionStore` 将 `taskId` 写入 `turns.task_id`，使任务统计和恢复可以按 Task 查询 Turn。普通用户输入不受影响。

### 4.2 步骤执行和状态推进

执行器的状态逻辑为：

```text
planned → executing
executing → verifying
verifying → executing（还有后续步骤）
executing → completed（全部步骤完成）
```

如果任务从 `paused` 恢复，会从第一个非 `completed` 步骤继续；已经产生的完成步骤不会重复调用模型或验证命令。

### 4.3 验证命令结果解析

验证命令通过 `ToolRegistry.execute("run_command", ...)` 执行，返回值可能是 JSON 成功结果、工具错误或权限拒绝文本。执行器将其归一化为：

```ts
{ exitCode, stdout, stderr }
```

无法解析或工具返回错误时按非零退出处理，确保验证失败不会被误判为通过。

### 4.4 验证记录生命周期

每次验证包含：

- 验证名称和命令数组。
- 所属 Task 和 TaskStep。
- 工作目录和超时时间。
- 是否为必需验证。
- `pending / passed / failed / timed_out / skipped` 状态。
- 退出码和完整截断后的输出。
- 开始和结束时间。

阶段二当前使用的默认验证策略是：

```text
testing      → npm test
verification → npm run typecheck, npm test
```

后续可以从任务规格扩展验证定义，但不需要修改现有验证结果结构。

### 4.5 暂停、恢复和取消

TaskStore 提供三类任务控制：

- `pauseTask`：`executing/verifying → paused`。
- `resumeTask`：`paused → executing`。
- `cancelTask`：从尚未完成的可取消状态进入 `cancelled`。

控制接口不绕过状态迁移，也不会删除 Turn、工具结果或验证记录。取消当前运行任务时，CLI 同时触发 AbortSignal，让 Runtime 停止后续模型步骤。

### 4.6 预算和边界

当前阶段提供执行器的 `maxTurns` 预算，CLI 默认最多推进 20 个步骤 Turn；达到上限后 Task 进入 `blocked`，不再无限循环。验证命令仍受现有 `run_command` 超时限制和沙箱策略控制。

Token 统计继续使用现有 Runtime 的 Responses 用量和上下文压缩机制；本次没有复制一套 Token 计费逻辑。后续若需要 Task 级 token 上限，应在 Runtime 返回用量的现有位置汇总，而不是重新解析模型文本。

## 五、改动影响

### 5.1 用户行为

典型使用流程：

```text
/task start 为配置模块增加 streaming 配置，并补充配置测试。
/task run
/task status
```

任务会逐步调用模型和工具；testing/verification 步骤会实际运行测试和类型检查。验证失败时任务停止并显示失败状态，用户可以查看数据库中的验证输出。

长任务控制：

```text
/task pause
/task resume
/task cancel
```

运行过程中按 Ctrl+C 会取消当前 Turn；已完成步骤和已落库工具结果保留，任务进入可恢复状态。

### 5.2 数据库迁移

已有 v10 数据库首次启动时执行 v10 → v11 迁移，迁移前使用现有完整性检查、WAL checkpoint 和版本化备份。旧程序无法读取 v11 数据库，回退程序版本时必须恢复匹配的数据库备份。

### 5.3 既有功能

普通文本任务、Skill、MCP、权限、Windows 沙箱、Turn 恢复和工作区追踪继续使用原有路径。只有 `/task run` 才会主动创建带 `task_id` 的 Turn 并推进任务步骤。

## 六、测试与验证

新增和更新测试覆盖：

- Task 执行器按顺序推进步骤。
- testing/verification 步骤运行验证并保存通过结果。
- 验证失败时停止任务并保留失败事实。
- Task ID 传入 Turn 记录器。
- `/task run/pause/resume/cancel` 命令解析。
- v11 Schema、Task 外键和验证索引。
- 阶段一已有的分析、事务、隔离和恢复测试继续通过。

执行阶段交付前应运行：

```powershell
cd coding-agent
npm run typecheck
npm test
```

## 七、潜在风险点

### 7.1 默认验证命令是项目约定，不是模型推断

当前执行器固定使用 `npm test` 和 `npm run typecheck`，适合当前仓库，但其他项目可能使用不同命令。后续应让 TaskSpecification 或项目配置提供验证定义，同时保留 `VerificationResult` 结构。

### 7.2 验证失败尚未自动修复

这是阶段边界而非遗漏。失败输出已持久化，阶段四可以据此构造修复输入；本次不会因为失败而重复修改工作区，也不会无限重试。

### 7.3 pause/cancel 的交互时机

CLI 正在等待模型或工具时，命令行输入循环不能同时处理新的 `/task pause` 文本；当前可靠控制入口是 Ctrl+C 和任务状态 API，显式命令适合在任务空闲或下一次交互时使用。后续若需要运行中实时命令，应增加独立控制通道，而不是复用同一个 readline 输入循环。

### 7.4 进程突然退出

已完成 Turn、工具结果和步骤状态会落库；正在执行的 Turn 仍由现有 Session 恢复机制处理。Task 可能停留在 `executing`，后续恢复逻辑需要把遗留运行态转换为可恢复状态，再从未完成步骤继续。

### 7.5 验证输出和权限错误

验证器将无法解析的工具返回按失败处理，避免权限拒绝或沙箱错误被误判为测试通过。stdout/stderr 仍受现有命令输出截断规则约束，完整日志不保证无限保存。

### 7.6 当前尚未提供任务级 token/time 字段

阶段三已实现跨步骤 Turn 上限和现有 Runtime 的用量/超时控制，但没有新增独立的任务 token/time 预算列。原因是当前 Runtime 已有上下文压缩和命令超时机制，重复维护会产生口径不一致。若后续需要产品级预算，应基于现有 Responses usage 增加明确的 Task 运行时表和原子累计接口。

## 八、阶段边界与后续接口

本次完成：

- TaskStep 驱动现有 Runtime。
- 文件和命令工具执行复用既有权限/沙箱。
- 验证定义和结果持久化。
- 验证失败停止并保留证据。
- 跨步骤/Turn 执行。
- 任务暂停、恢复、取消和预算阻塞。
- Task 与 Turn 关联。

本次没有实现：

- 验证失败后的自动修复循环。
- 独立完成评估器。
- 阶段四的最终交付协议。
- 后台服务、并行任务、子 Agent 和云端调度。

阶段四应复用：


```text
TaskStore.listVerifications
TaskStore.saveVerificationResult
TaskStore.updateTaskStatus
TaskStore.listTaskSteps
```

以验证失败记录作为修复输入，并在所有必需验证通过后实现严格完成判定。
