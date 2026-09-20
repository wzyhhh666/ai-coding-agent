# AI Coding Agent

一个使用 TypeScript 和 Node.js 构建的本地命令行 Coding Agent。项目通过 Responses API 驱动 ReAct 循环，支持受控的文件操作、代码搜索、命令执行、权限审批和 Windows 沙箱。

## 当前能力

- 多步 ReAct：模型可以连续调用工具，并根据 Observation 决定下一步。
- Responses Items：完整保留消息、推理项和函数调用上下文，函数结果通过 `call_id` 关联。
- 流式输出：实时显示 Responses API 文本增量，并从终态事件还原完整 Items 后再进入会话历史。
- 本地上下文：显式使用 `store: false`，由客户端重放完整 Items，不依赖远端会话持久化。
- Provider 配置：支持配置实现 Responses API 的模型服务。
- 工具注册：从 JSON 配置加载工具声明、本地 Handler 和参数 Schema。
- 参数校验：使用 AJV 在工具执行前严格校验模型参数。
- 权限审批：支持 `allow / ask / deny` 与单次、会话级授权。
- 文件安全：限制工作区边界，防止路径和符号链接逃逸。
- 精确编辑：支持原子写入、唯一文本替换和 unified diff。
- 命令执行：使用结构化 argv、`shell: false`、超时和输出截断。
- Windows 沙箱：优先使用 WSL2 + bubblewrap，支持 strict 和显式 soft fallback。
- SQLite 会话层：包含 Schema 迁移、外键、WAL、Session/Turn/Item 事务写入、Turn 终态原因记录和完整 Turn 恢复。
- CLI 会话恢复：按工作区自动恢复模型和系统 Prompt 均兼容的最近会话，配置变化时隔离创建新会话。
- CLI 多轮交互：同一进程内复用 Runtime 和 Session，支持连续处理任务，单轮失败不会阻断后续输入。
- 显式会话管理：支持列出、新建和切换当前工作区会话，切换时校验模型与系统 Prompt 兼容性。
- 上下文压缩：根据 Responses API 返回的输入 token 用量自动摘要较早 Turn，同时保留近期完整工具上下文。
- 任务终止：Runtime 支持注入 `AbortSignal` 安全取消当前任务，并严格区分用户或进程中断与网络、服务商、协议、模型及持久化失败；失败或中断后，普通后续 Turn 会保留安全上下文。
- 安全重放基础：会话恢复和普通后续输入通过纯函数 Replay Builder 投影 canonical Items；完整工具调用与结果可以继续使用，孤立 Item 会被过滤并返回结构化警告；显式 `continue / retry` 保留指定来源语义。
- 持久化检查点：完整模型 Response 以原子 Item 批次写入并创建检查点，工具结果与 `function_call` 配对校验后在同一事务中保存，支持按最后安全边界恢复。
- 工作区一致性：文件工具会针对本轮实际涉及文件生成轻量 SHA-256 指纹，并随工具结果检查点保存；指纹只用于发现可能的磁盘差异，不自动覆盖工作区。
- CLI 取消控制：独立交互状态机区分空闲、运行中、取消中和关闭状态；运行中第一次 Ctrl+C 只取消当前 Turn，空闲时 Ctrl+C 才关闭 CLI，排版状态与业务状态保持隔离。

> CLI 支持自动接续和显式切换；会话重命名与删除命令尚未实现。

## 环境要求

- Node.js 22.18 或更高版本
- npm
- 一个支持 Responses API 的模型服务和 API Key
- 可选：WSL2 与 bubblewrap，用于 Windows 强隔离命令执行

## 快速开始

```powershell
cd coding-agent
npm install
Copy-Item config/settings.example.toml config/settings.toml
```

编辑本地 `config/settings.toml`，填写所使用模型服务的 API Key、地址和模型名称，然后启动：

```powershell
npm start -- <工作区路径>
```

未提供工作区路径时，默认使用当前目录。

## 配置

在 `config/settings.toml` 中选择当前 Provider：

```toml
active_provider = "openai"

[agent]
prompt = "react"
max_steps = 10
streaming = true
compaction_trigger_ratio = 0.8
compaction_keep_recent_turns = 2

[providers.openai]
AGENT_API_KEY = ""
base_url = "https://api.openai.com/v1"
model = "gpt-5"
context_window = 400000
```

`config/settings.toml` 是本地敏感配置，不应提交到版本库。仓库仅提供不含密钥的 `settings.example.toml`。

配置的 Provider、`base_url` 和模型必须支持 `/responses`。项目不会静默回退到旧协议，接口不兼容时会返回明确错误。

`streaming` 默认为 `true`，普通模型调用通过 SSE 实时输出文本。若兼容的第三方 Provider 已实现 `/responses` 但不支持流式事件，可将其设为 `false`，运行时会使用非流式响应；上下文压缩固定使用非流式请求。无论采用哪种模式，只有终态 Response 中的完整 Items 会写入会话，文本增量不会单独持久化。

Runtime 的 `runTurn` 支持通过可选 `AbortSignal` 取消当前任务。取消发生在请求前时不会创建 Turn；发生在模型请求、流式事件接收或工具步骤之间时，会保留当前 Turn 中可安全重放的上下文，并将已创建的 Turn 记录为 `interrupted / user_cancelled`。网络、服务商、协议、模型和持久化等客观故障记录为带结构化原因的 `failed`。工具已经执行完成时，Runtime 会先持久化完整 `function_call_output` 再响应取消，避免工作区副作用与审计历史失配；没有结果的工具调用不会进入下一次模型请求。当前能力仍是本地前台 Turn 控制；服务端 background 任务、远端轮询与取消将在独立阶段实现。

会话状态默认保存在用户目录的 `.coding-agent/state.sqlite`。数据库包含原始提问、模型输出、工具结果和检查点；CLI 在首次实际任务前显示隐私提示。状态数据库使用版本迁移、外键、WAL 和事务机制；已有旧版本数据库迁移前会先进行完整性检查并创建版本化备份。启动同一工作区时，仅当模型和系统 Prompt 的 SHA-256 指纹均一致才会恢复最近会话，否则会创建隔离的新 Session。输入 `exit` 或 `quit` 可退出交互循环。

交互过程中可使用以下会话命令：

| 命令 | 作用 |
| --- | --- |
| `/sessions` | 按最近更新时间列出当前工作区最多 20 个会话 |
| `/new [标题]` | 创建新会话并立即切换，标题可省略 |
| `/resume [session-id]` | 恢复当前工作区最近的兼容会话，或恢复指定会话 |
| `/switch <session-id>` | 恢复并切换到指定会话 |
| `/continue <turn-id>` | 使用失败或中断 Turn 的安全上下文，并输入新的继续指令 |
| `/retry <turn-id>` | 使用失败或中断 Turn 的原始用户目标创建新的重试 Turn |
| `/help` | 显示可用命令 |
| `/exit` | 退出程序 |

显式切换仍遵守工作区、模型和系统 Prompt 指纹隔离规则。不属于当前工作区或与当前配置不兼容的 Session 会被拒绝，原活动会话不会受到影响。

上下文压缩在请求的 `usage.input_tokens` 达到 `context_window × compaction_trigger_ratio` 后触发。较早的完整 Turn 会合并为持久化摘要，最近 `compaction_keep_recent_turns` 个 Turn 保留原始 Responses Items。压缩请求不启用工具并继续使用 `store: false`；压缩失败时保留完整历史，不会把已经成功的用户 Turn 改为失败。

## 内置工具

| 工具 | 用途 | 默认权限 |
| --- | --- | --- |
| `read_file` | 读取工作区内 UTF-8 文本文件的指定行 | `allow` |
| `search_files` | 递归搜索工作区文本文件 | `allow` |
| `write_file` | 创建或完整覆盖 UTF-8 文件 | `ask` |
| `edit_file` | 唯一原文精确替换 | `ask` |
| `run_command` | 执行结构化非 Shell 命令 | `ask` |

所有工具调用都会先经过 JSON Schema 校验。权限拒绝和工具错误会作为 Observation 返回模型，不会直接终止整个 ReAct 流程。

## 权限模型

- `allow`：无需确认直接执行。
- `ask`：执行前请求用户确认。
- `deny`：由系统策略直接拒绝。

文件会话授权按工具和具体路径隔离；命令会话授权只适用于有限的安全命令前缀。删除命令、`git clean`、`git reset --hard` 和无法审计的编码 PowerShell 命令会被直接拒绝。

## Windows 沙箱

Windows 下可使用指定 WSL2 发行版中的 bubblewrap：

```toml
[sandbox]
mode = "strict"
backend = "windows-wsl-bwrap"
allow_soft_fallback = false

[sandbox.windows]
wsl_distribution = "Ubuntu"
workspace_mount = "/workspace"
```

strong 模式只将当前工作区作为持久可写挂载，并隔离网络、PID、IPC 和 UTS namespace。soft 模式不具备内核级隔离，CLI 会在审批前明确提示风险。

## 开发与测试

```powershell
cd coding-agent
npm run typecheck
npm test
```

真实 Windows WSL 沙箱测试需要本机安装 WSL2 和 bubblewrap：

```powershell
$env:RUN_WINDOWS_WSL_SANDBOX_TESTS = "1"
$env:AGENT_WSL_DISTRIBUTION = "Ubuntu"
npm run test:sandbox:windows
```

## 项目结构

```text
coding-agent/
├── agent.ts                  # 程序入口
├── cli.ts                    # CLI 装配与审批交互
├── config.ts                 # TOML 配置加载和校验
├── runtime.ts                # ReAct 模型循环
├── cli_turn_controller.ts    # CLI Turn 交互状态机与 Ctrl+C 控制
├── replay.ts                 # 审计历史到 canonical Items 的安全投影
├── checkpoint.ts             # 检查点类型、元数据和领域校验
├── turn_lifecycle.ts         # Turn 状态、终止原因与契约校验
├── sqlite.ts                 # SQLite Schema 与迁移
├── session/                  # SessionStore、Turn 与 Item 持久化
├── file_change_tracker.ts    # 文件变更和 diff
├── config/                   # Prompt、工具和本地配置
├── tools/                    # 工具、权限、注册表与沙箱
└── tests/                    # 单元测试和可选集成测试
```

## 开发状态

当前版本已完成 Responses API ReAct 工具链与流式输出、Turn 取消/失败终态分流、安全重放、失败或中断后的普通后续上下文、持久化检查点与原子 Item 批次、权限模型、文件安全、Windows 沙箱框架、Runtime 会话记录接口、CLI 多轮会话管理、CLI Ctrl+C 取消状态机、`/resume` 会话恢复、`/continue`/`/retry` 显式恢复和自动上下文压缩。下一步接入检查点与工作区差异提示、Token usage 可观测性和 background 长任务能力。

## 更新记录

### 2026-09-20

- feat | 新增 `/continue <turn-id>` 和 `/retry <turn-id>` 显式恢复命令；前者使用失败或中断 Turn 的安全 Replay 前缀接收新的继续指令，后者重新提交原始用户目标。
- 新增 `SessionStore.prepareTurnRecovery` 和 `prepareTurnRecovery` 会话装配入口，统一校验工作区、模型、系统 Prompt、来源 Turn 状态、检查点边界和安全 Replay。
- 恢复操作始终创建新的 Turn，旧 Turn 保持终态不可变；`retry` 不把来源 Turn 的用户输入重复放入初始 Items，而是作为新 Turn 的输入重新提交。
- 拒绝从 `completed` 或 `running` Turn 恢复，不重放孤立工具调用、未完成参数或来源 Turn 之后的历史。
- 补充命令解析、CLI 分发、`continue/retry` Replay、来源 Turn 状态保护和旧 Turn 不变测试；完整测试 121 项中 120 项通过，1 项 Windows WSL 沙箱真实集成测试因环境条件跳过。

### 2026-09-19

- feat | 新增 `/resume [session-id]` 会话恢复命令；无参数时按当前工作区、模型和系统 Prompt 指纹恢复最近兼容 Session，带参数时恢复指定 Session。
- 新增 `findLatestCompatibleSession` 查询能力，避免 `/resume` 无参数时误恢复模型或系统 Prompt 不兼容的会话。
- `/resume` 与现有 `/switch <session-id>` 共用 `restoreRuntimeSession` 装配流程，恢复失败时不替换当前活动 Runtime；`/switch` 保留为兼容入口。
- 补充命令解析、CLI 命令分发、最近兼容 Session 选择和指定不兼容 Session 拒绝测试。

### 2026-09-18

- feat | 新增独立 `CliTurnController`，以 `idle / running / cancelling / closing` 管理 CLI Turn 交互状态，避免把 Ctrl+C 逻辑耦合到终端排版状态。
- 接入 readline `SIGINT`：运行中第一次 Ctrl+C 只触发当前 Turn 的 `AbortController`，取消中的重复 Ctrl+C 不重复终止，空闲时 Ctrl+C 关闭 CLI。
- 将 CLI 当前 Turn 的 `AbortSignal` 传入 Runtime，并在取消时先关闭已打开的文本行，保证流式文本、日志和取消提示不会混排。
- 补充状态机正常完成、失败恢复、重复取消、空闲退出和 CLI 命令兼容性测试；完整测试 117 项中 116 项通过，1 项 Windows WSL 沙箱真实集成测试因环境条件跳过。

### 2026-09-15

- feat | 新增 `follow_up` 上下文投影模式，使普通后续 Turn 能保留失败或中断 Turn 中已经形成的用户输入、消息、推理项以及完整的工具调用结果。
- 加固失败收尾的一致性：Turn 终态成功落库后，Runtime 优先从 SessionStore 的真实审计 Items 和检查点重新构建 `follow_up` 上下文；无持久化 Replay 能力时才使用内存投影降级，保证运行中恢复与进程重启恢复使用同一套事实来源。
- 统一 Runtime 新增用户输入的 canonical Item 格式，始终使用 `type: "message"`、`role: "user"` 和 `content` 字段，避免内存上下文与持久化 Replay 的结构不一致。
- 调整运行时失败收尾逻辑：先通过 Replay Builder 提取安全上下文，再移除未完成或状态未知的 Item；工具只有调用没有结果时不会被下一轮模型请求重放。
- 调整进程恢复范围：遗留 `running` Turn 先记录为 `interrupted / process_exited`，随后与其他终态 Turn 一起经过统一安全投影，保证会话连续性和协议完整性使用同一套规则。
- 补充普通后续输入、未完成工具调用过滤、终态会话恢复和失败 Turn 用户输入保留测试；新增失败与中断 Turn 上下文连续性阶段开发任务文档。

### 2026-09-14

- feat | 将状态数据库 Schema 升级到 v3，新增 `turn_checkpoints` 表、外键、检查点类型约束、Item 引用约束和严格递增约束；旧版本迁移前执行完整性检查并生成版本化备份。
- 将完整模型 Response 的 output Items 改为单批次事务写入，并创建 `model_response` 检查点；工具执行结果与对应 `function_call` 在同一事务中写入并创建 `tool_result` 检查点，批次失败时整体回滚。
- 新增检查点领域类型与元数据校验，恢复对象读取检查点边界，Replay Builder 遵守最后已提交检查点，避免把未形成闭环的局部 Item 重新提交给模型。
- 文件变更跟踪器按本轮实际涉及文件生成带版本、文件清单和内容哈希的稳定 SHA-256 工作区指纹，并随工具结果检查点保存；无文件副作用或无法安全识别路径时不生成指纹。补充迁移、原子事务、检查点恢复、指纹和 Runtime 原子接口测试。

### 2026-09-11

- feat | 新增纯函数 Replay Builder，将本地审计 Turn 投影为可发送给模型的 canonical Items；role-only message 会统一为带 `type: "message"` 的内部表示，调用参数和结果按 Responses `call_id` 顺序校验。
- 普通会话恢复只重放 `completed` Turn；显式 `continue` 才保留失败或中断 Turn 的完整工具前缀，`retry` 单独返回原始目标，并在来源 Turn 处截断后续历史，避免重复输入和时间倒流上下文。
- Replay Builder 对未知 Item、非法参数、重复调用、孤立调用、孤立结果和调用结果乱序返回结构化 warning，并在不修改审计历史的前提下采用保守截断策略。
- SessionStore 新增受工作区边界保护的显式 replay 入口，普通未压缩会话恢复也通过 Replay Builder 归一化完整 Turn；来源 Turn 之后的历史不会混入继续上下文。补充 canonical 归一化、失败/中断安全前缀、配对校验、显式来源 Turn、输入不可变和异常 Item 过滤测试。

- feat | 建立 Turn 终态语义与结构化终止原因，将生命周期固定为 `running -> completed / failed / interrupted`，并保持所有终态不可再次追加或结束。
- 将用户主动取消记录为 `interrupted / user_cancelled`，启动恢复发现的遗留运行中 Turn 记录为 `interrupted / process_exited`；取消不再复用失败分支，也不具备自动重试语义。
- 对网络超时、网络连接、服务商异常、服务商取消、协议异常、模型不完整、模型拒绝、持久化故障和步骤上限进行明确分类，Runtime 与 SessionStore 通过类型化原因传递，不依赖错误字符串决定业务状态。
- 调整工具取消顺序：工具产生完整 observation 后先持久化 `function_call_output`，再检查取消信号，保证已经发生的工作区副作用拥有对应审计结果；未完成的流式 delta 仍只用于显示。
- SQLite Schema 升级到 v2，新增 `turns.termination_reason`，对既有失败和进程中断记录做保守回填，并通过列约束、触发器和 TypeScript 校验共同拒绝非法状态/原因组合、终态回退及终态 Item 追加。
- 补充取消、工具完成后取消、网络错误分类、模型状态分类、持久化失败原因、进程恢复、迁移回填和数据库约束测试；后续将从纯函数 Replay Builder 开始实现失败或取消后的安全继续能力。

### 2026-09-10

- feat | 为 ReActRuntime 增加可选 `AbortSignal` 控制接口，保持原有 `runTurn` 调用方式兼容，并将取消信号传递到 Responses API 请求和流式事件迭代。
- 明确取消边界：请求前取消不创建持久化 Turn；请求中、流式接收中或工具步骤间取消会停止后续执行、回滚本轮内存 Items，并将已创建 Turn 按失败生命周期结束。
- 保持 Responses 协议事实一致性，流式 delta 仍只进入显示路径，取消时不持久化局部 delta；完整终态 Items 和工具输出仍遵循原有事务与回放规则。
- 新增取消错误类型和异常透传逻辑，区分主动取消与普通 API 失败，避免底层 AbortError 被误报为普通请求故障。
- 补充请求前取消、流式过程中取消、取消后上下文回滚和 Turn 生命周期测试；本阶段不引入服务端 background、轮询或数据库 Schema 变更。

### 2026-09-06

- feat | 为普通 Responses API 模型调用增加 SSE 流式输出，CLI 在事件到达时直接写出 `response.output_text.delta`，减少长回复的首字等待时间。
- Runtime 新增统一响应聚合入口，同时接受非流式 Response 和异步事件流；流式请求只将文本增量交给显示层，并以 `response.completed / failed / incomplete` 携带的终态 Response 作为协议事实。
- 完整终态 Response 继续沿用既有状态校验、拒绝识别、token 用量统计、工具调用和 Items 重放逻辑；数据库仅保存完整 canonical Items，不保存不可恢复的局部 delta。
- 保持 ReAct 工具循环语义：流式响应中的 reasoning 与 function_call 从终态 Items 统一提取，工具结果仍按 `call_id` 关联并依次追加，下一步请求可完整重放上下文。
- 新增 `agent.streaming` 布尔配置并默认开启；可显式设为 `false` 兼容支持 `/responses` 但不支持 SSE 的第三方 Provider，非流式路径保留原有行为。
- 上下文压缩固定使用 `stream: false`，避免维护性摘要出现在用户输出中，同时继续保持无工具、`store: false` 和失败降级策略。
- 流式连接异常、错误事件或缺少终态事件均按失败 Turn 处理并回滚本轮内存上下文；已收到的局部文本不会写入数据库或污染下一轮请求。
- 终端行输出与文本增量回调均经过故障隔离，显示层异常不会覆盖有效模型结果、破坏工具执行或改变持久化生命周期。
- 补充流式文本聚合、完整 Items 持久化、工具调用接续、缺少终态回滚、输出回调异常、配置默认值和显式关闭测试。

### 2026-09-05

- feat | 接通上下文容量管理闭环，根据 Responses API 返回的 `usage.input_tokens` 与模型 `context_window` 计算触发阈值，不使用字符数或本地估算替代服务端 token 统计。
- 新增 `compaction_trigger_ratio` 和 `compaction_keep_recent_turns` 配置，默认在上下文窗口使用率达到 80% 后尝试压缩，并保留最近 2 个完整 Turn；配置加载时严格校验范围。
- SessionStore 基于已完成 Turn 生成增量压缩候选，只提交上次摘要之后新进入压缩区间的 Items，同时保留近期 Turn 的完整 Responses Items。
- 使用已有 `compactions` 表事务保存摘要和截止 Turn 序号，要求截止序号对应 completed Turn 且只能单调向前推进；本次不修改 Schema，也不增加迁移版本。
- Runtime 使用独立、无工具、`store: false` 的 Responses 请求生成中文执行摘要，并明确将历史输入视为待总结数据，保留目标、决策、文件变化、工具结果、约束和未完成事项。
- 压缩成功后以内存中的“摘要 Item + 近期完整 Items”替换全量历史；进程重启或显式切换会话时使用同样结构恢复，不重复发送已经摘要的旧 Items。
- 压缩属于成功 Turn 之后的维护操作；请求、解析或持久化失败时仅输出警告并保留完整上下文，不覆盖用户回复、不回滚已完成 Turn。
- 补充压缩配置、token 阈值、无工具摘要请求、内存上下文替换、失败降级、候选划分、摘要恢复裁剪和单调写入测试。
- 验证结果：`npm run typecheck` 通过；`npm test` 共 75 项测试，74 项通过，1 项真实 WSL2 沙箱测试因环境条件跳过。

### 2026-09-04

- feat | 新增 `/sessions`、`/new [标题]`、`/switch <session-id>` 和 `/help` 命令，支持在 CLI 多轮交互中显式列出、新建和切换当前工作区会话。
- SessionStore 新增按更新时间倒序的工作区会话查询，默认最多返回 20 项并限制查询范围为 1 到 100；新增受工作区边界保护的单 Session 查询入口。
- Session 装配层拆分自动准备、强制新建和按 ID 恢复能力；显式恢复前校验模型标识及系统 Prompt SHA-256 指纹，不兼容时明确拒绝且不混入历史 Items。
- 切换或新建会话时重建 ReActRuntime 与 ToolRegistry，使模型上下文、SessionRecorder 和会话级工具授权同时切换，避免状态跨 Session 泄漏。
- 命令解析独立为无副作用模块，严格区分普通任务、退出、会话命令和非法输入；缺少参数、多余参数及未知命令均返回明确提示。
- 保留惰性状态初始化：直接退出不会打开数据库；仅执行 `/sessions` 等需要状态的命令或提交首个任务时初始化 SQLite。
- 补充命令解析、命令分发、会话列表顺序与数量边界、带标题新建、按 ID 恢复和配置不兼容拒绝测试。
- 验证结果：`npm run typecheck` 通过；`npm test` 共 71 项测试，70 项通过，1 项真实 WSL2 沙箱测试因环境条件跳过。

### 2026-09-02

- feat | 将 CLI 改为持续多轮交互循环，同一进程内复用已恢复的 ReActRuntime、SessionRecorder 和 SQLite Session，避免每个任务重复初始化会话上下文。
- 支持 `exit` 和 `quit` 明确退出；空输入只提示并跳过，单轮模型或工具失败通过错误回调报告后继续接收下一轮任务。
- 将数据库与 Agent 改为首次有效任务时惰性初始化，用户直接退出或只输入空内容时不会创建空 Session；无论正常退出、输入关闭还是运行异常，均统一关闭数据库和终端。
- 抽取可独立测试的 `runInteractiveSession`，将输入循环、退出规则和单轮错误恢复与 CLI 资源装配解耦，为后续显式会话命令保留扩展边界。
- 补充多轮成功、空输入、单轮失败后继续、退出和 readline 关闭测试。
- 验证结果：`npm run typecheck` 通过；`npm test` 共 66 项测试，65 项通过，1 项真实 WSL2 沙箱测试因环境条件跳过。

### 2026-08-29

- feat | 新增独立 Session 装配模块，集中处理系统 Prompt 指纹、最近 Session 兼容性判断、完整 Turn 恢复和 Runtime 注入参数，避免将恢复策略耦合到 CLI 或 Runtime。
- CLI 收到非空任务后初始化用户级状态数据库，按规范化工作区查找最近 Session；首次使用时创建 Session，后续自动注入 SessionRecorder 与已恢复的 Responses Items。
- 仅当模型标识与系统 Prompt 的 SHA-256 指纹均一致时恢复会话；模型或 Prompt 变化会创建新 Session，防止不兼容的消息、推理项和工具上下文混入新请求。
- 恢复时沿用 SessionStore 的完整 Turn 边界，并通过 Replay Builder 保留终态 Turn 的安全上下文；上次进程遗留的 running Turn 会标记为 interrupted，未完成工具调用仍不会进入模型上下文。
- 空输入不会初始化数据库或创建空 Session；数据库、WAL 连接和终端均通过明确的资源生命周期关闭，启动或运行失败不会遗留打开的数据库句柄。
- CLI 显示本地状态隐私提示，并在实际恢复到历史时报告可用回合数量；状态默认保存在用户目录 `.coding-agent/state.sqlite`。
- 补充首次 Session 创建、兼容会话恢复、未完成回合排除、模型变化和 Prompt 变化隔离测试。
- 验证结果：`npm run typecheck` 通过；`npm test` 共 63 项测试，62 项通过，1 项真实 WSL2 沙箱测试因环境条件跳过。

### 2026-08-28

- feat | 为 ReActRuntime 增加可选 options 对象，在不改变现有调用方式的前提下支持注入 SessionRecorder 和已恢复的 Responses Items，Runtime 不直接依赖 SQLite 实现。
- 每个非空请求在模型执行前创建 Turn；模型返回的 reasoning、message、function_call 等完整 output Items，以及本地生成的 function_call_output，均按协议原始顺序写入记录器。
- 仅在模型返回有效最终文本且输出流程成功后完成 Turn；API 异常、响应状态异常、拒绝、空输出、工具循环达到步骤上限或持久化失败都会将 Turn 标记为 failed。
- 失败回合会回滚本轮内存 Items，避免半完成上下文进入下一轮；失败状态写入本身异常时保留原始运行错误，并尽力附加持久化诊断，不掩盖首要故障。
- 初始恢复 Items 通过防御性深拷贝进入 Runtime，模型请求使用数组快照，避免调用方后续修改恢复数据或 Runtime 继续追加上下文时改变已发出的请求。
- Session 层新增 restoredItems 辅助函数，按 completed Turn 的既有顺序展开 Items，为下一阶段 CLI 恢复装配提供单一转换入口。
- 本阶段保持 CLI 行为不变，尚未自动创建、选择或恢复 Session，避免在 Runtime 生命周期闭环验证前扩大改动范围。
- 补充成功回合、工具调用顺序、API 失败、步骤上限、Item 写入失败、失败补偿异常、恢复上下文隔离和空输入测试。
- 验证结果：`npm run typecheck` 通过；`npm test` 共 59 项测试，58 项通过，1 项真实 WSL2 沙箱测试因环境条件跳过。

### 2026-08-27

- feat | 新增独立 SessionStore，支持创建 Session、按工作区查找最近 Session，并通过注入时钟和 ID 生成器保持逻辑可测试。
- 使用事务创建 Turn 并自动保存 user Item，支持追加完整 Responses Items，以及将 Turn 完成或失败状态原子写入数据库。
- 恢复会话时只返回 `completed` Turn；上次进程遗留的 `running` Turn 会转换为 `interrupted`，失败和中断 Turn 不进入模型上下文。
- 增加工作区隔离校验，拒绝从其他工作区恢复 Session、写入 Turn 或创建 SessionRecorder，Windows 路径通过规范化 key 处理大小写差异。
- 将初始 Schema v1 的 `messages` 表修正为 Responses 语义的 `items` 表，保存 `item_type` 和完整 `payload_json`；保留版本号、事务和未来迁移框架，不增加无业务意义的历史版本。
- 增加 SessionRecorder 适配器，为后续 Runtime 接入提供 `startTurn / appendItem / completeTurn / failTurn` 接口，本次不修改 Runtime 和 CLI 行为。
- 补充最近 Session 查询、Item 顺序、成功/失败/中断恢复、工作区隔离、结束后写入拒绝、序列化失败和唯一约束事务回滚测试。
- 验证结果：`npm run typecheck` 通过；`npm test` 共 51 项测试，50 项通过，1 项真实 WSL2 沙箱测试因环境条件跳过。

### 2026-08-26

- 将 Runtime 的模型请求端点从 Chat Completions API 替换为 Responses API，并移除运行时代码中对 `choices`、Chat Message 和 `role: "tool"` 的协议依赖。
- 将本地上下文从消息数组改为 Responses Item 数组；每次请求显式发送 `instructions`，并设置 `store: false`，由客户端维护和重放上下文。
- 完整保存并重放每次响应的 `output` Items，包括 reasoning Item、message Item 和 function call Item，避免工具循环中丢失推理上下文。
- 将工具调用改为 Responses API 的 `function_call` 格式，并使用 `function_call_output` 通过 `call_id` 关联工具执行结果。
- 支持同一响应中的多个工具调用，同时保持现有工具按返回顺序串行执行，避免权限审批、文件修改和变更跟踪产生竞态。
- 新增工具声明转换，将内部工具配置转换为 Responses API 扁平函数格式，并显式设置 `strict: false` 兼容当前 JSON Schema。
- 保留现有 AJV 参数校验、`allow / ask / deny` 权限审批、工作区路径保护、Windows 沙箱、文件变更跟踪和最大 ReAct 步骤限制。
- 增加 Responses 响应状态处理，区分 `incomplete`、`failed`、`cancelled`、非终态响应、空输出、模型拒绝和 API 请求异常，并返回明确错误。
- 增加失败 Turn 上下文回滚，防止请求异常或响应不完整时将半截 Item 历史带入后续 Turn。
- 更新示例 Provider 配置和 README 使用说明，明确 Provider、`base_url` 和模型必须支持 `/responses`，不再静默回退到旧协议。
- 补充普通回复、多工具调用、reasoning 重放、工具格式转换、状态错误、请求失败、空输出、模型拒绝、步骤上限和失败上下文回滚测试。
- 验证结果：`npm run typecheck` 通过；`npm test` 共 43 项测试，42 项通过，1 项真实 WSL2 沙箱测试因环境条件跳过。
