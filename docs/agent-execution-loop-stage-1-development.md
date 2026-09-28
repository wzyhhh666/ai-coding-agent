# Agent 执行闭环阶段一代码变更总结

## 一、本次改造目标

本次改造完成“Agent 执行闭环与任务状态管理”规划中的第一阶段：任务定义与执行计划。

改造前，项目的核心持久化结构是 `Session → Turn → Item`。系统可以恢复会话、运行模型回合、调用工具并记录执行结果，但一次开发请求仍然只是 Turn 的用户输入，缺少独立的任务目标、范围、验收标准和执行计划。

本次在现有 Session 和 Runtime 之上增加任务层：

```text
Session → Task → TaskStep
             ↓
        后续阶段关联 Turn → Item
```

第一阶段只负责把用户目标转换为可恢复、可校验的任务规格和执行计划：

```text
创建任务 → 分析需求 → 生成规格和验收标准 → 生成步骤 → 事务保存
```

信息不足时任务进入 `blocked` 并保存澄清问题；模型输出或计划不合法时任务进入 `failed` 并保存失败原因。本阶段不会执行计划、修改代码或运行验证，这些能力属于后续阶段。

## 二、设计思路

### 2.1 增加 Task 层，不重做 Runtime

现有 `ReActRuntime`、`SessionStore`、Turn 生命周期、工具注册、权限、沙箱和检查点已经形成稳定基础。本次没有把任务概念塞进 Turn，也没有修改 Responses Item 协议，而是建立独立任务领域层：

- Session 负责对话上下文和模型兼容性。
- Task 负责一个完整开发目标及其计划。
- Turn 负责后续阶段中的单次模型执行。
- Item 继续保存模型输出和工具结果。

Task 通过 `session_id` 关联 Session，并继承当前工作区边界，后续多个 Turn 可以共同推进同一个 Task。

### 2.2 一次模型调用完成分析和计划

`/task start <目标>` 使用一次非流式 Responses API 调用生成任务规格和步骤计划，没有拆成多次模型回合，以降低状态同步、成本和失败点。

模型只允许返回两类结果：

- `planned`：包含目标、范围、非目标、约束、验收标准和步骤。
- `needs_clarification`：包含整理后的目标和至少一个澄清问题。

应用层先解析并验证 JSON，再写入数据库；模型输出不直接作为可信数据。

### 2.3 计划必须覆盖四类步骤

计划必须包含：

1. `analysis`：确认代码位置、现状和约束。
2. `implementation`：完成目标代码修改。
3. `testing`：新增或更新测试。
4. `verification`：运行与改动匹配的验证。

步骤数量不固定，但每一步必须有非空标题和完成说明。这样既保证闭环不缺环节，又允许不同任务使用不同细化程度。

### 2.4 Task 状态和 Turn 状态分离

Task 状态集合为：

```ts
type TaskStatus =
  | "created" | "analyzing" | "planned" | "executing" | "verifying"
  | "repairing" | "paused" | "cancelled" | "blocked" | "completed" | "failed";
```

第一阶段实际路径：

```text
created → analyzing → planned
created → analyzing → blocked
created → analyzing → failed
```

完整状态集合为后续四阶段提供统一语言，但第一阶段不会提前实现后续状态行为，也不会把模型最终文本当作任务完成。

### 2.5 任务计划原子保存

`TaskStore.savePlan` 在一个事务内更新规格、插入全部步骤、更新时间并将状态设为 `planned`。任一步骤写入失败时全部回滚，避免出现“Task 已计划但步骤不完整”。

### 2.6 CLI 只准备 Session，不提前执行工具

`/task start` 和 `/task status` 会准备或恢复当前兼容 Session，但任务分析不需要文件工具、MCP 或沙箱，因此使用 `requireActiveSessionId()` 而不是 `requireAgent()`。这样查看任务状态不会触发工具装配或 MCP 连接；真正执行普通 Turn 时仍使用原有 Runtime 装配链路。

## 三、模块改动

### 3.1 新增 `coding-agent/task/`

| 文件 | 作用 | 设计影响 |
| --- | --- | --- |
| `types.ts` | Task、TaskStep、规格、分析结果和状态类型 | 建立任务领域统一语言 |
| `analyzer.ts` | 生成分析 Prompt、解析 JSON、校验规格 | 将自然语言目标转换为可信结构 |
| `planner.ts` | 校验步骤类型、标题、说明和四类完整性 | 阻止不完整计划入库 |
| `store.ts` | 创建、读取、状态迁移、事务保存和工作区隔离 | 成为任务持久化事实来源 |
| `bootstrap.ts` | 编排创建、分析、计划、阻塞和失败路径 | 完成一次阶段一任务循环 |

### 3.2 数据库修改

修改 `coding-agent/sqlite.ts`：

- Schema 版本从 9 升级到 10。
- 新增 `tasks` 和 `task_steps` 表。
- 新增 Session、工作区和步骤顺序索引。
- 将任务表、字段和索引加入当前 Schema 完整性检查。
- 保留现有迁移前完整性检查、版本化备份和事务机制。

### 3.3 CLI 修改

修改 `coding-agent/cli_commands.ts`：

```ts
{ type: "start-managed-task"; objective: string }
{ type: "managed-task-status" }
```

支持：

```text
/task start <目标>
/task status
```

修改 `coding-agent/cli.ts`：

- 初始化 `TaskStore`。
- 增加只准备 Session ID 的 `requireActiveSessionId()`。
- 增加非流式 `taskAnalysisModel()`。
- 增加任务规格、验收标准、澄清问题和步骤展示。
- 接入两个 `/task` 命令并更新 `/help`。

调用链为：

```text
CLI → requireActiveSessionId → createPlannedTask → analyzeTask
    → parseTaskPlan → TaskStore.savePlan/blockForClarification → 展示
```

### 3.4 文档和测试修改

修改 `README.md`：增加任务计划能力、CLI 命令、`task/` 目录、开发状态和更新记录。

新增：

- `tests/task_analyzer.test.ts`
- `tests/task_store.test.ts`

更新：

- `tests/cli_commands.test.ts`
- `tests/sqlite.test.ts`

## 四、核心代码变更

### 4.1 领域类型和判别联合

`TaskRecord` 对应数据库事实，`TaskStepRecord` 对应有序步骤，`TaskSpecification` 表达整理后的需求，`PlannedTaskStep` 表达尚未执行的计划，`TaskAnalysis` 用判别联合强制调用方分别处理 `planned` 和 `needs_clarification`。

### 4.2 分析器和运行时校验

`analyzeTask()` 接收可注入的 `TaskAnalysisModel`：

```ts
export type TaskAnalysisModel = (prompt: string) => Promise<string>;
```

领域模块不依赖 OpenAI SDK，CLI 负责真实 Responses 调用，测试提供固定 JSON。解析器验证 JSON 对象、outcome、字符串数组、目标、范围、验收标准和澄清问题。非法 JSON 或非法结构会抛出明确错误，不进行宽松截取或猜测。

### 4.3 计划完整性

`parseTaskPlan()` 逐项校验步骤，并用 `Set` 检查四种步骤类型是否齐全。它不固定步骤数量和标题，因此可扩展而不会缺少分析、实现、测试、验证四个闭环环节。

### 4.4 TaskStore 和工作区隔离

`TaskStore` 保存规范化工作区路径和 key。创建任务前检查 Session 属于当前工作区；查询 Task 时同时按 `id` 和 `workspace_key` 限制。其他工作区即使知道 Task ID 也不能读取或更新任务，延续现有 SessionStore 安全边界。

### 4.5 状态迁移和失败语义

`STATUS_TRANSITIONS` 为每个状态声明允许的下一状态。`updateTaskStatus()` 在事务中校验当前状态后更新 Task 和 Session 时间。

`createPlannedTask()` 的异常处理只在 Task 仍为 `analyzing` 时转为 `failed`，避免计划已成功提交后因展示或读取异常再次执行非法迁移。需求不足使用 `blocked`，系统或模型错误使用 `failed`，两者不混淆。

### 4.6 Schema v10

`tasks` 保存 Session、工作区、目标、范围、非目标、约束、验收标准、澄清问题、状态、当前步骤、状态原因和时间；数组以 JSON 文本保存。

`task_steps` 保存 Task 外键、从 1 开始的顺序、步骤类型、标题、完成说明、状态和时间。CHECK 约束限制状态和类型，外键负责级联删除，`(task_id, sequence)` 保证顺序唯一。

### 4.7 一次任务循环

```text
/task start 目标
  → 创建 Task
  → created → analyzing
  → 模型生成 JSON
  → 应用层校验
  → planned：事务保存规格和步骤
     或 blocked：保存澄清问题
     或 failed：保存错误原因
  → 展示结果
```

`/task status` 只读取当前 Session 最近 Task 和步骤，不调用模型。

## 五、改动影响

### 5.1 用户行为

用户可以显式创建可恢复任务计划，并看到目标、范围、非目标、约束、验收标准和步骤。需求不足时会看到明确问题；后续可以重新提供更完整目标创建新 Task。

### 5.2 数据库迁移

已有状态库打开时执行 v9 → v10 迁移。迁移前沿用现有完整性检查和版本化备份。删除 Session 会级联删除关联 Task 和 TaskStep。旧版本程序打开 v10 数据库时会按既有规则拒绝，因为旧程序不认识新 Schema。

### 5.3 既有功能

普通文本输入仍走原有 `ReActRuntime.runTurn()`。Session、Skill、MCP、工具、沙箱、Turn 恢复和检查点逻辑没有改变；只有显式 `/task` 命令进入新任务模块。

## 六、测试与验证

新增测试覆盖：

- 合法任务规格和四类步骤。
- 信息不足的澄清结果。
- 非法 JSON 和缺失步骤类型。
- Task/TaskStep 持久化和数据库重启恢复。
- `blocked` 和 `failed` 状态及原因。
- 跨工作区访问拒绝。
- 非法状态迁移拒绝。
- 计划事务回滚。
- `/task` 命令解析。
- Schema v10 对象完整性。

验证结果：

- `npm run typecheck`：通过。
- `npm test`：187 项，186 项通过，0 项失败，1 项真实 WSL2 沙箱测试因环境条件跳过。
- `git diff --check`：通过。

未执行真实 Provider 在线调用；真实模型路径沿用已有 Responses 客户端配置，领域测试使用可注入模型函数验证确定性行为。

## 七、潜在风险点

### 7.1 计划语义质量

结构校验不能保证模型计划足够具体。当前通过用户可见计划、验收标准和不自动执行来降低风险；阶段二接入执行前仍应保留计划作为检查点。

### 7.2 Provider JSON 兼容性

系统使用手动 JSON 解析以保持 Provider 兼容性。返回 Markdown 或额外文本会导致 Task `failed`，不会进行不安全的宽松截取。

### 7.3 JSON 数组查询能力

范围、约束、验收标准和澄清问题目前整体保存为 JSON，适合第一阶段读取和展示，但不支持 SQL 级逐条状态查询。后续若需要逐条验收状态，应增加有业务意义的验收记录结构，不应在本阶段提前扩展。

### 7.4 `current_step_id` 尚未启用

字段为阶段二预留。第一阶段所有步骤为 `pending`，不会设置当前步骤。数据库没有用跨表外键连接它，阶段二启用时必须在应用层校验步骤属于同一 Task。

### 7.5 blocked Task 尚无补充答案命令

第一阶段只有 `/task start` 和 `/task status`。当前通过更完整目标重新创建 Task；原 Task 保留为记录。原任务内补充澄清并恢复属于后续任务控制能力。

### 7.6 数据库回退

v10 迁移后旧程序无法直接读取数据库。迁移前备份可用于恢复，但程序版本和数据库版本必须匹配。

## 八、阶段边界与后续接口

本次没有实现：

- TaskStep 自动执行和代码修改。
- 验证命令及验证结果持久化。
- 跨 Turn 自动推进。
- Task 暂停、恢复和取消。
- 验证失败修复循环。
- 最终完成判定。

后续阶段应复用以下接口：

```text
TaskStore
├── createTask
├── getTask
├── findLatestTask
├── updateTaskStatus
├── savePlan
├── blockForClarification
└── listTaskSteps
```

阶段二应从 `planned` Task 和有序 TaskStep 开始执行，复用现有 ReActRuntime 和工具系统，不绕过本次建立的状态、工作区和事务边界。
