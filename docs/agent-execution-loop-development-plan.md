# Agent 执行闭环与任务状态管理：四阶段开发文档

## 1. 文档目标

本文档定义 AI Coding Agent 后续建设方案，目标是实现：

> Agent 执行闭环与任务状态管理，覆盖需求分析、工具调用、代码修改、验证和结果交付，支持长任务执行控制与取消，并依据验证结果推进修复或完成。

本文档只规划上述范围内的功能，不扩展为通用协作平台、发布系统或云端任务调度系统。

## 2. 范围边界

### 2.1 本次包含

- 需求分析和任务目标结构化
- 验收标准和验证条件
- 执行计划和步骤状态
- 现有工具调用与代码修改的任务级编排
- 类型检查、测试和自定义命令验证
- 验证结果持久化
- 验证失败后的修复循环
- 长任务跨 Turn 继续执行
- 任务暂停、恢复、取消和安全中断
- 基于验证结果的完成、失败和阻塞判定
- 基础结果摘要

### 2.2 明确不包含

- Pull Request 创建和审查流程
- Git 分支协作和 Worktree 并行
- 子 Agent 或团队协作
- 云端后台任务和分布式调度
- 定时任务和外部通知
- 自动推送、发布和部署
- 复杂工作流 DSL
- 多任务并行调度

## 3. 现有能力复用原则

当前项目已经具备以下基础能力，四个阶段均应直接复用，不重复设计：

- `ReActRuntime`：Responses API、多步工具调用、流式响应和 Turn 生命周期。
- `SessionStore`：Session、Turn、Item、检查点和恢复。
- 工具系统：`read_file`、`search_files`、`write_file`、`edit_file`、`run_command`。
- `ToolRegistry`：工具注册、参数 Schema 校验和结果适配。
- 权限和沙箱：`allow / ask / deny`、工作区边界、命令权限和 Windows 沙箱。
- 工作区追踪：文件变更、Git 基线、diff、检查点和回滚。
- 上下文管理：Replay、失败恢复和上下文压缩。

目标架构是在现有模型上增加任务层：

```text
Session → Task → TaskStep → Turn → Item
```

不重做 Session、Runtime、工具权限和沙箱体系。

## 4. 任务状态模型

任务状态必须和现有 Turn 状态区分。Turn 表示一次模型执行回合，Task 表示一个完整开发目标。

```ts
type TaskStatus =
  | "created"
  | "analyzing"
  | "planned"
  | "executing"
  | "verifying"
  | "repairing"
  | "paused"
  | "cancelled"
  | "blocked"
  | "completed"
  | "failed";
```

目标状态流转：

```text
created
  ↓
analyzing
  ↓
planned
  ↓
executing
  ↓
verifying
  ├── 通过 → completed
  └── 失败 → repairing → executing
```

异常路径：

```text
executing → paused
executing → cancelled
executing → blocked
verifying → failed
```

任务只有在必需步骤和必需验证全部通过后才能进入 `completed`。

---

# 阶段一：任务定义与执行计划模块

## 1. 阶段目标

把用户输入从普通 Turn 提升为具有明确目标、约束、验收标准和执行步骤的 Task。

阶段一完成后，系统可以：

- 创建任务
- 分析需求
- 记录任务范围和非目标
- 生成验收标准
- 生成执行步骤
- 持久化并恢复任务计划

本阶段不要求自动修改代码和自动修复验证失败。

## 2. 数据模型

```ts
type Task = {
  id: string;
  sessionId: string;
  workspace: string;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  status: TaskStatus;
  currentStepId: string | null;
  createdAt: string;
  updatedAt: string;
};

type TaskStep = {
  id: string;
  taskId: string;
  title: string;
  description: string;
  order: number;
  status: "pending" | "in_progress" | "completed" | "failed";
};
```

只保留当前阶段真正需要的字段，不引入任务依赖图、嵌套子任务或并行调度。

## 3. 核心流程

```text
用户输入
  ↓
创建 Task
  ↓
分析目标、范围、限制和验收条件
  ↓
生成 TaskStep
  ↓
保存 Task 与步骤
  ↓
状态进入 planned
```

需求不完整时：

```text
created → analyzing → blocked
```

并返回需要用户补充的信息，不得擅自扩大任务范围。

## 4. 建议模块

- `task/types.ts`：Task、TaskStep、TaskStatus 类型。
- `task/store.ts`：任务和步骤的事务持久化。
- `task/analyzer.ts`：将用户目标整理为结构化任务定义。
- `task/planner.ts`：生成步骤计划。
- `task/bootstrap.ts`：从 Session 装配或恢复 Task。

## 5. 最小接口

```ts
createTask(input): Task;
getTask(taskId): Task;
updateTaskStatus(taskId, status): void;
createTaskSteps(taskId, steps): TaskStep[];
listTaskSteps(taskId): TaskStep[];
```

CLI 最小命令：

```text
/task start <目标>
/task status
```

## 6. 验收标准

使用以下任务验证：

```text
为配置模块增加 streaming 配置，并补充配置测试。
```

必须满足：

1. 创建一个与当前 Session 和工作区绑定的 Task。
2. 保存目标、约束和验收标准。
3. 生成至少包含分析、修改、测试和验证的步骤。
4. Task 状态进入 `planned`。
5. 数据库重启后能恢复 Task 和步骤。
6. 需求不清晰时不会直接进入执行状态。

## 7. 阶段完成定义

阶段一完成后，可以通过一次任务循环完成“目标分析和计划生成”，但不会修改业务代码。

---

# 阶段二：任务执行与验证模块

## 1. 阶段目标

让 Task 按步骤驱动现有 Runtime，完成工具调用、代码修改和结构化验证。

阶段二完成后，系统可以：

- 执行当前 TaskStep
- 调用现有文件和命令工具
- 记录文件修改
- 执行验证命令
- 保存验证结果
- 根据验证结果更新步骤状态

本阶段不自动修复验证失败，失败结果由阶段四处理。

## 2. 数据模型

```ts
type VerificationDefinition = {
  id: string;
  taskId: string;
  stepId: string;
  name: string;
  command: string[];
  cwd?: string;
  timeoutMs: number;
  required: boolean;
};

type VerificationResult = {
  id: string;
  taskId: string;
  stepId: string;
  definitionId: string;
  status: "passed" | "failed" | "timed_out" | "skipped";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
};
```

## 3. 核心流程

```text
planned
  ↓
Task 进入 executing
  ↓
执行当前 TaskStep
  ↓
ReActRuntime 调用工具
  ↓
文件修改和命令执行
  ↓
Task 进入 verifying
  ↓
运行该步骤的验证命令
  ├── 全部通过 → Step completed
  └── 有失败 → 保存失败结果
```

## 4. VerificationRunner 职责

新增统一验证器，复用现有 `run_command` 和沙箱执行计划：

- 执行 `typecheck`、`test`、`build`、`lint` 或自定义命令。
- 处理超时和退出码。
- 保存 stdout、stderr 和执行时间。
- 关联 Task、TaskStep 和验证定义。
- 将结果标记为 `passed`、`failed`、`timed_out` 或 `skipped`。

验证器不负责修改代码，也不替代 `run_command` 工具。

## 5. 完成规则

允许：

```text
验证通过 → Step completed
```

不允许：

```text
模型输出最终回答 → Step completed
```

Task 在阶段二结束时可以处于 `verifying`、`failed` 或部分完成状态，只有阶段四负责最终完成判定。

## 6. 与现有模块的关系

- 复用 `ReActRuntime`。
- 复用 `ToolRegistry`、权限审批和沙箱。
- 复用 `FileChangeTracker`、Git 基线和检查点。
- 复用 `SessionStore` 的事务和工作区隔离。
- 不修改工具的既有权限语义。

## 7. 验收标准

使用以下任务验证：

```text
为某函数增加参数校验，并确保类型检查和测试通过。
```

必须满足：

1. Task 进入 `executing`。
2. Agent 读取并修改目标代码。
3. 工作区变更被追踪。
4. 执行 `npm run typecheck` 和 `npm test`。
5. 两项验证结果均被持久化。
6. 验证通过后对应步骤变为 `completed`。
7. 任一验证失败时，Task 不得进入 `completed`。

## 8. 阶段完成定义

阶段二完成后，可以通过一次任务循环完成“执行、修改、验证和证据保存”，但验证失败不会自动修复。

---

# 阶段三：长任务控制与任务恢复模块

## 1. 阶段目标

让 Task 可以跨多个 Turn 持续执行，并支持暂停、恢复、取消和进度查询。

阶段三完成后，系统可以：

- 跨 Turn 自动推进任务步骤
- 保存当前步骤和当前 Turn
- 显示任务运行状态
- 暂停任务
- 恢复任务
- 取消当前任务
- 在进程重启后恢复到最后安全状态
- 限制任务的 Turn、Token、时间和修复预算

本阶段不实现后台服务、定时器和并行任务。

## 2. 运行时数据

```ts
type TaskRuntimeState = {
  currentStepId: string | null;
  currentTurnId: string | null;
  turnCount: number;
  tokenUsed: number;
  startedAt: string | null;
  lastProgressAt: string | null;
  pauseReason: string | null;
  cancelReason: string | null;
};

type TaskBudget = {
  maxTurns?: number;
  maxTokens?: number;
  maxDurationSeconds?: number;
  maxRepairAttempts: number;
};
```

## 3. 核心控制流程

```text
executing
  ├── pause → paused
  ├── cancel → cancelled
  ├── 当前 Turn 完成 → 继续下一步骤
  ├── 预算耗尽 → blocked
  └── 进程退出 → 可恢复
```

恢复流程：

```text
paused → executing
interrupted → executing
blocked → 用户确认后 executing
```

## 4. 取消和安全边界

复用现有 `AbortSignal`、Turn 生命周期和上下文回滚：

- 不强行中断已完成的原子工具调用。
- 工具已经产生的结果必须先持久化。
- 未完成的模型上下文不得进入下一次请求。
- 取消后保留已完成步骤和验证结果。
- 当前 Task 标记为 `cancelled` 或 `paused`，而不是伪装成完成。

## 5. CLI 最小接口

```text
/task status
/task pause
/task resume
/task cancel
```

`/task status` 至少显示：

- Task 状态
- 当前步骤
- 已完成步骤数
- Turn 数
- Token 使用量
- 最近一次验证结果
- 暂停、取消或阻塞原因

## 6. 长任务循环

```text
读取 Task 状态
  ↓
执行当前步骤
  ↓
步骤完成后进入下一步骤
  ↓
当前 Turn 结束
  ↓
若 Task 未完成，则创建下一个 Turn
```

只在当前 CLI 进程和已有 SessionStore 范围内实现，不引入独立后台执行服务。

## 7. 验收标准

使用一个至少包含“修改代码、增加测试、类型检查、完整测试”的任务验证：

1. Task 能跨多个 Turn 自动推进。
2. `/task status` 显示当前步骤和任务状态。
3. `/task pause` 后不创建新的 Turn。
4. `/task resume` 从当前安全步骤继续。
5. `/task cancel` 能取消当前 Turn 并保留已持久化结果。
6. 进程重启后能恢复 Task、当前步骤和最近安全上下文。
7. 达到预算后进入 `blocked`，不无限调用模型。

## 8. 阶段完成定义

阶段三完成后，可以通过一次长任务循环验证“跨 Turn 执行、暂停、恢复、取消和重启恢复”。

---

# 阶段四：验证驱动修复与完成交付模块

## 1. 阶段目标

根据验证结果自动推进：

```text
验证通过 → 完成
验证失败 → 分析失败 → 修复 → 再验证
```

阶段四完成后，四个阶段组合成完整的 Agent 执行闭环。

## 2. 核心流程

```text
verifying
  ├── 全部验证通过
  │      ↓
  │   delivering
  │      ↓
  │   completed
  │
  └── 存在失败
         ↓
      analyzing_failure
         ↓
      repairing
         ↓
      executing
         ↓
      verifying
```

## 3. 修复循环

验证失败后，向 Runtime 提供结构化失败上下文：

- 验证命令
- 退出码
- stdout 摘要
- stderr 摘要
- 失败步骤
- 相关文件
- 最近一次工作区变更
- 已经尝试过的修复

Agent 必须：

1. 判断失败原因。
2. 判断是否需要修改代码。
3. 修改相关文件。
4. 重新执行失败验证。
5. 必要时执行完整验证集。

## 4. 修复限制

```ts
type RepairPolicy = {
  maxAttempts: number;
  maxSameFailureAttempts: number;
};
```

规则：

- 超过最大修复次数 → `blocked`。
- 连续相同失败 → `blocked`。
- 没有文件变化且验证结果未变化 → `blocked`。
- 不可恢复错误 → `failed`。
- 用户取消 → `cancelled`。
- 用户可以通过 `/task resume` 继续处理。

不实现复杂错误知识库、根因图谱或自动化规则引擎。

## 5. 严格完成判定

Task 只有同时满足以下条件，才能进入 `completed`：

1. 所有必需步骤为 `completed`。
2. 所有必需验收标准通过。
3. 所有必需验证命令通过。
4. 没有未处理的验证失败。
5. 没有未完成的修复尝试。
6. 当前工作区变更已记录。

模型的最终文字不能单独触发完成。

## 6. 基础结果交付

本阶段只输出任务结果摘要，不实现 PR、推送、发布和协作流程。

```ts
type TaskResult = {
  taskId: string;
  status: "completed" | "failed" | "blocked" | "cancelled";
  objective: string;
  changedFiles: string[];
  completedSteps: string[];
  verificationResults: VerificationResult[];
  unresolvedIssues: string[];
  summary: string;
};
```

结果摘要至少包含：

- 完成状态
- 修改文件
- 完成步骤
- 验证命令和结果
- 未解决问题
- 简短说明

## 7. 验收标准

使用一个第一次验证失败、第二次验证成功的任务验证：

```text
修改代码并确保 npm test 通过。
```

必须满足：

1. Agent 完成初次代码修改。
2. 第一次测试失败后 Task 进入 `repairing`。
3. Agent 根据失败输出修复代码。
4. 再次执行验证命令。
5. 验证通过后 Task 进入 `completed`。
6. 输出基础结果摘要。

另一个失败场景：

1. 连续两次出现相同失败。
2. Task 进入 `blocked`。
3. 系统停止自动循环。
4. 用户可以看到失败原因并决定后续处理。

## 8. 阶段完成定义

阶段四完成后，系统可以在一次完整任务循环中完成：

```text
需求 → 计划 → 工具调用 → 代码修改 → 验证 → 修复 → 再验证 → 完成或阻塞 → 结果摘要
```

---

# 五、阶段依赖和交付顺序

```text
阶段一：任务定义与执行计划
        ↓
阶段二：任务执行与验证
        ↓
阶段三：长任务控制与任务恢复
        ↓
阶段四：验证驱动修复与完成交付
```

每个阶段都是一个可独立验收的大模块：

| 阶段 | 独立完成能力 |
| --- | --- |
| 阶段一 | 创建任务、分析需求、生成计划并恢复 |
| 阶段二 | 执行步骤、修改代码、运行验证并保存证据 |
| 阶段三 | 跨 Turn 执行、暂停、恢复、取消和重启恢复 |
| 阶段四 | 根据验证结果修复、完成、失败或阻塞任务 |

# 六、总体完成标准

四个阶段全部完成后，项目必须满足：

1. 每个开发请求都可以形成一个明确的 Task。
2. Task 有可恢复的目标、步骤和验收标准。
3. Agent 可以调用现有工具完成代码修改。
4. 验证命令被系统识别、执行并持久化结果。
5. 验证失败会驱动修复，而不是直接宣布完成。
6. 长任务可以跨多个 Turn 继续执行。
7. 用户可以暂停、恢复或取消任务。
8. 任务只在验证通过后标记为完成。
9. 无法继续时进入 `blocked` 或 `failed`，不会无限循环。
10. 最终输出基础结果摘要，说明修改内容、验证结果和未解决问题。

该方案只增加完成指定范围所需的任务编排能力，不扩展到交付增强、协作、发布或云端调度。
