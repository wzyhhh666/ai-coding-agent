# AI Coding Agent

一个使用 TypeScript 和 Node.js 构建的本地命令行 Coding Agent。项目通过 Responses API 驱动 ReAct 循环，支持受控的文件操作、代码搜索、命令执行、权限审批和 Windows 沙箱。

## 当前能力

- 多步 ReAct：模型可以连续调用工具，并根据 Observation 决定下一步。
- Responses Items：完整保留消息、推理项和函数调用上下文，函数结果通过 `call_id` 关联。
- 本地上下文：显式使用 `store: false`，由客户端重放完整 Items，不依赖远端会话持久化。
- Provider 配置：支持配置实现 Responses API 的模型服务。
- 工具注册：从 JSON 配置加载工具声明、本地 Handler 和参数 Schema。
- 参数校验：使用 AJV 在工具执行前严格校验模型参数。
- 权限审批：支持 `allow / ask / deny` 与单次、会话级授权。
- 文件安全：限制工作区边界，防止路径和符号链接逃逸。
- 精确编辑：支持原子写入、唯一文本替换和 unified diff。
- 命令执行：使用结构化 argv、`shell: false`、超时和输出截断。
- Windows 沙箱：优先使用 WSL2 + bubblewrap，支持 strict 和显式 soft fallback。
- SQLite 会话层：包含 Schema 迁移、外键、WAL、Session/Turn/Item 事务写入、Runtime 生命周期记录和完整 Turn 恢复。
- CLI 会话恢复：按工作区自动恢复模型和系统 Prompt 均兼容的最近会话，配置变化时隔离创建新会话。
- CLI 多轮交互：同一进程内复用 Runtime 和 Session，支持连续处理任务，单轮失败不会阻断后续输入。
- 显式会话管理：支持列出、新建和切换当前工作区会话，切换时校验模型与系统 Prompt 兼容性。

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

[providers.openai]
AGENT_API_KEY = ""
base_url = "https://api.openai.com/v1"
model = "gpt-5"
context_window = 400000
```

`config/settings.toml` 是本地敏感配置，不应提交到版本库。仓库仅提供不含密钥的 `settings.example.toml`。

配置的 Provider、`base_url` 和模型必须支持 `/responses`。项目不会静默回退到旧协议，接口不兼容时会返回明确错误。

会话状态默认保存在用户目录的 `.coding-agent/state.sqlite`。数据库包含原始提问、模型输出和工具结果；CLI 在首次实际任务前显示隐私提示。启动同一工作区时，仅当模型和系统 Prompt 的 SHA-256 指纹均一致才会恢复最近会话，否则会创建隔离的新 Session。输入 `exit` 或 `quit` 可退出交互循环。

交互过程中可使用以下会话命令：

| 命令 | 作用 |
| --- | --- |
| `/sessions` | 按最近更新时间列出当前工作区最多 20 个会话 |
| `/new [标题]` | 创建新会话并立即切换，标题可省略 |
| `/switch <session-id>` | 恢复并切换到指定会话 |
| `/help` | 显示可用命令 |
| `/exit` | 退出程序 |

显式切换仍遵守工作区、模型和系统 Prompt 指纹隔离规则。不属于当前工作区或与当前配置不兼容的 Session 会被拒绝，原活动会话不会受到影响。

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
├── sqlite.ts                 # SQLite Schema 与迁移
├── session/                  # SessionStore、Turn 与 Item 持久化
├── file_change_tracker.ts    # 文件变更和 diff
├── config/                   # Prompt、工具和本地配置
├── tools/                    # 工具、权限、注册表与沙箱
└── tests/                    # 单元测试和可选集成测试
```

## 开发状态

当前版本已完成 Responses API ReAct 工具链、权限模型、文件安全、Windows 沙箱框架、Runtime 会话记录接口、CLI 自动恢复、多轮交互和显式会话切换。后续将完善上下文压缩与容量控制。

## 更新记录

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
- 恢复时沿用 SessionStore 的完整 Turn 边界，只重放 completed Turn；上次进程遗留的 running Turn 会标记为 interrupted，不进入模型上下文。
- 空输入不会初始化数据库或创建空 Session；数据库、WAL 连接和终端均通过明确的资源生命周期关闭，启动或运行失败不会遗留打开的数据库句柄。
- CLI 显示本地状态隐私提示，并在实际恢复到历史时报告完整回合数量；状态默认保存在用户目录 `.coding-agent/state.sqlite`。
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
