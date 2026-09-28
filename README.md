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
- Windows 沙箱：统一治理文件、命令和网络能力；支持 WSL2+bubblewrap、Job Object、AppContainer 能力探测、Restricted Token 兼容后备、临时 Windows Firewall/WFP 规则和异常租约清理。
- SQLite 会话层：包含 Schema 迁移、外键、WAL、Session/Turn/Item 事务写入、Turn 终态原因记录和完整 Turn 恢复。
- CLI 会话恢复：按工作区自动恢复模型和系统 Prompt 均兼容的最近会话，配置变化时隔离创建新会话。
- CLI 多轮交互：同一进程内复用 Runtime 和 Session，支持连续处理任务，单轮失败不会阻断后续输入。
- 显式会话管理：支持列出、新建和切换当前工作区会话，切换时校验模型与系统 Prompt 兼容性。
- 上下文压缩：根据 Responses API 返回的输入 token 用量自动摘要较早 Turn，同时保留近期完整工具上下文。
- 任务终止：Runtime 支持注入 `AbortSignal` 安全取消当前任务，并严格区分用户或进程中断与网络、服务商、协议、模型及持久化失败；失败或中断后，普通后续 Turn 会保留安全上下文。
- 安全重放基础：会话恢复和普通后续输入通过纯函数 Replay Builder 投影 canonical Items；完整工具调用与结果可以继续使用，孤立 Item 会被过滤并返回结构化警告；显式 `continue / retry` 保留指定来源语义。
- 持久化检查点：完整模型 Response 以原子 Item 批次写入并创建检查点，工具结果与 `function_call` 配对校验后在同一事务中保存，支持按最后安全边界恢复。
- 工作区一致性：文件工具会针对本轮实际涉及文件生成轻量 SHA-256 指纹，并随工具结果检查点保存；指纹只用于发现可能的磁盘差异，不自动覆盖工作区。
- 文件变更追踪：文件工具在前后快照之间生成 `create / modify / delete` 事件、真实内容哈希和 unified diff hunk 行范围，并与工具结果检查点在同一事务中落库；当前不记录修改者归属。
- Git 工作区基线：Git 仓库在 Turn 开始和结束时通过独立临时 Index 保存 HEAD、真实 Index Tree 和工作区 Tree；可按 Turn 比较新增、修改、删除和重命名文件。`run_command` 在授权后按命令边界追踪 Git 工作区文件副作用，并随工具结果检查点落库；恢复前可按编号展开行级 diff，不修改真实暂存区，非 Git 工作区继续使用快照后端。
- 检查点回滚：Git 检查点保存工作区 Tree OID，支持通过 `/rollback <turn-id>` 选择检查点、预览差异并在二次确认后恢复工作区文件；不修改真实 Index、HEAD 或提交历史，缺少 Tree 的历史检查点和非 Git 工作区不允许回滚。
- Skill 接入：支持从本地目录、本地压缩包或用户明确指定的 Git 仓库导入 Skill，安装前展示来源和文件清单，校验通过并确认后安装到用户级或仓库级 `.agents/skills`；安装阶段不执行 Skill 脚本、不自动覆盖同名 Skill。
- Skill 元数据：使用标准 YAML 安全解析器读取 `SKILL.md` frontmatter，支持多行字符串、列表、布尔值、数字和嵌套对象，并校验名称、目录一致性及描述长度。
- Skill 渐进式披露：初始请求只注入预算内的 Skill 名称、描述和 ID，模型通过只读 `load_skill` 与 `read_skill_reference` 按需加载正文和引用资料；正文受大小限制并按内容哈希缓存。
- Skill 调用策略：支持 `$skill-name` 与 `/skill-name` 显式调用、`/skills` 列表、description/`when_to_use` 候选排序和匹配理由；兼容 `agents/openai.yaml` 的隐式调用策略及 `disable-model-invocation`、`user-invocable`、`paths` 等调用控制字段。
- Skill 审计与脚本：记录 Skill 正文/引用加载和脚本请求事件，脚本通过现有 `run_command`、PermissionEngine、Windows Sandbox 和文件变更追踪执行，当前仅允许 `.ps1`、`.cmd`、`.bat`。
- Skill 经验沉淀：用户可从已完成且验证通过的 Turn 生成脱敏草稿，审阅后批准或拒绝；批准保存复用现有 Installer，同名 Skill 不会自动覆盖，草稿不会被 Discovery 当作正式 Skill。
- CLI 取消控制：独立交互状态机区分空闲、运行中、取消中和关闭状态；运行中第一次 Ctrl+C 只取消当前 Turn，空闲时 Ctrl+C 才关闭 CLI，排版状态与业务状态保持隔离。
- MCP 工具治理（阶段一）：支持用户级 MCP 配置、本地 stdio 和远程 Streamable HTTP Server 的连接、工具发现、白名单、审批、Schema 校验、调用结果限制和 ToolRegistry 适配；远程连接默认校验 HTTPS、允许 Origin 和禁止私网地址。
- MCP 远程身份（阶段二）：支持用户级 credential profile、API Key/Bearer 凭据、AES-256-GCM 加密凭据文件，以及 OAuth 2.1 Authorization Code + PKCE 的元数据发现、Token 交换、刷新和 state 校验。
- MCP 受控网络（阶段三）：后端支持 Origin/DNS/IP 校验、同源重定向限制、请求超时、响应大小、并发控制、GET/HEAD 有限指数退避和 OAuth loopback 回调；不增加复杂 CLI。
- Windows 沙箱已完成：命令、Skill 脚本和本地 MCP stdio 共用执行计划；Job Object 控制进程树、CPU、内存、进程数和超时；AppContainer 在执行前探测，Restricted Token 仅作为明确标记的兼容后备；目标 IPv4 CIDR allowlist 通过临时 Windows Firewall/WFP 规则强制并绑定宿主 PID 租约。

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

MCP 用户级配置位于用户目录的 `.coding-agent/mcp.toml`，凭据 Profile 只保存引用；凭据密文位于 `.coding-agent/credentials.enc.json`，写入前必须设置至少 16 个字符的 `CODING_AGENT_CREDENTIAL_KEY` 环境变量。不要把该环境变量或凭据文件提交到版本库。

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
| `/skill-install <来源> [user\|repository]` | 预览并安装本地目录、压缩包或 Git 仓库中的 Skill，默认安装到用户级目录 |
| `/skills` | 列出 Skill 来源、模型调用、用户调用和路径限制状态 |
| `$skill-name [任务]` 或 `/skill-name [任务]` | 显式加载并在当前 Turn 使用指定 Skill |
| `/skill-draft <turn-id>` | 从已完成且验证通过的 Turn 生成脱敏 Skill 草稿 |
| `/skill-drafts` | 列出当前工作区的 Skill 草稿 |
| `/skill-review <draft-id>` | 查看草稿、证据摘要、验证结果和脱敏数量 |
| `/skill-approve <draft-id> [user\|repository]` | 人工批准并保存正式 Skill，默认仓库级 |
| `/skill-reject <draft-id>` | 拒绝未审批草稿 |
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

Windows 原生后端还支持以下配置：

    [sandbox]
    mode = "auto"
    backend = "windows-native"
    allow_soft_fallback = true

    [sandbox.resources]
    max_processes = 64
    memory_mb = 1024
    cpu_seconds = 120

    [sandbox.network]
    mode = "deny-all"
    allowed_cidrs = []

    [sandbox.windows]
    identity = "auto"
    wsl_distribution = "Ubuntu"
    workspace_mount = "/workspace"

- identity 为 appcontainer 时，执行前运行真实进程能力探测；能力不可用时 strict 拒绝，auto 仅在允许时降级，不伪报强隔离。
- identity 为 auto 或 restricted-token 时，使用移除高权限的 Restricted Token、Job Object 和临时防火墙规则。该模式用于 Win32 兼容，不等价于 AppContainer 文件隔离，因此 strict 拒绝把它视为强文件沙箱。
- network.mode 为 allowlist 时，allowed_cidrs 只接受 IPv4 CIDR；系统生成补集阻断规则并封锁 IPv6。安装临时规则需要管理员权限，缺少权限时明确失败。
- Windows 原生执行使用临时工作区盘符、ACL 和 PID 租约；正常退出立即清理，后续执行会回收宿主进程已消失的盘符和防火墙残留。

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
├── recovery_ui.ts             # 恢复检查点选择与工作区风险确认
├── replay.ts                 # 审计历史到 canonical Items 的安全投影
├── checkpoint.ts             # 检查点类型、元数据和领域校验
├── turn_lifecycle.ts         # Turn 状态、终止原因与契约校验
├── sqlite.ts                 # SQLite Schema 与迁移
├── session/                  # SessionStore、Turn 与 Item 持久化
├── mcp/                      # MCP Server 配置、Transport、发现、网络目标校验与工具适配
├── sandbox/native/           # Windows AppContainer/Restricted Token/Job Object 原生辅助组件
├── tools/sandbox_policy.ts   # 统一命令、Skill 和 MCP stdio 的沙箱执行计划
├── tools/windows_job.ts      # Windows 原生执行载荷、能力探测和辅助组件入口
├── tools/network_ranges.ts   # IPv4 CIDR 校验、合并和阻断补集生成
├── file_change_tracker.ts    # 文件变更和 diff
├── workspace_change_backend.ts # Git 工作区基线与快照降级后端
├── config/                   # Prompt、工具和本地配置
├── tools/                    # 工具、权限、注册表与沙箱
└── tests/                    # 单元测试和可选集成测试
```

## 开发状态

当前版本已完成 Responses API ReAct 工具链与流式输出、Turn 取消/失败终态分流、安全重放、失败或中断后的普通后续上下文、持久化检查点与原子 Item 批次、权限模型、文件安全、Windows 沙箱框架、Runtime 会话记录接口、CLI 多轮会话管理、CLI Ctrl+C 取消状态机、`/resume` 会话恢复、`/continue`/`/retry` 显式恢复、恢复前工作区差异确认、历史检查点选择、自动上下文压缩、工具级文件变更事件追踪、Turn 级 Git 工作区起止基线、基线差异查询、`run_command` 命令级副作用追踪、恢复前工作区变化摘要和可展开行级 diff 展示，以及 Skill 导入安装、标准 YAML 解析、渐进式披露、调用策略、显式调用、可解释候选选择、审计、受控脚本执行、验证经验提取、脱敏草稿和人工审批保存。Skill 核心闭环已完成。MCP 阶段一已完成本地/远程工具发现、基础授权、调用和结果适配，阶段二已完成用户级静态凭据和 OAuth 认证基础链路，阶段三已完成受控网络访问和稳定性后端。Windows 沙箱阶段一已完成统一策略编排和命令/MCP stdio 受控启动闭环。

Windows 沙箱后续阶段已完成：统一执行计划现已覆盖 WSL 强隔离、Windows Job Object、AppContainer 能力探测、Restricted Token 兼容后备、目标 CIDR 网络强制、资源预算、异常租约恢复和 MCP stdio 审计；任何能力缺失或降级都会明确报告，strict 不会静默放行。

## 更新记录

### 2026-09-27

- feat | 完成 MCP 阶段三后端网络治理：接入 Origin/DNS/IP 校验、同源重定向限制、请求超时、响应大小、并发控制、GET/HEAD 有限指数退避和 OAuth loopback 回调；不增加复杂 CLI。
- feat | 完成 Windows 沙箱阶段二的 Job Object 受控启动器，统一限制本地命令、Skill 脚本和 MCP stdio 的进程树与资源。
- feat | 完成 Windows 沙箱收尾：加入 AppContainer 能力探测、Restricted Token 后备、目标 CIDR 防火墙/WFP 规则、资源预算、临时 ACL/盘符、崩溃租约回收和 MCP 沙箱审计。

### 2026-09-26

- feat | 新增 MCP 阶段一治理闭环：支持用户级配置、本地 stdio 和远程 Streamable HTTP Server，完成工具发现、白名单、审批、Schema 校验、结果限制、基础发现缓存和 HTTPS/Origin/私网目标校验。
- feat | 新增 MCP 阶段二远程身份链路：支持 credential profile、API Key/Bearer 凭据、AES-256-GCM 加密存储、OAuth 2.1 PKCE 授权码交换、刷新、撤销基础能力和 state 校验。
- feat | 完成 Skill 经验沉淀闭环：仅允许用户从 completed 且存在成功测试、类型检查、构建或 lint 证据的 Turn 生成草稿；工具调用必须闭环，失败步骤和孤立调用会被拒绝。
- feat | 新增证据脱敏、结构化模型草稿、SQLite Schema v9 草稿状态机和 `/skill-draft`、`/skill-drafts`、`/skill-review`、`/skill-approve`、`/skill-reject`；人工批准后复用 Installer 保存，同名 Skill 不自动覆盖。

### 2026-09-25

- feat | 新增 Skill 生命周期审计和 SQLite Schema v8：记录正文加载、引用读取、脚本请求与执行事件，在 Turn 终态前按现有事务边界落库；审计失败不覆盖原始 Turn 结果。
- feat | 新增 `run_skill_script` 受控工具，仅允许 Skill `scripts/` 下的 `.ps1`、`.cmd`、`.bat`，通过现有 `run_command` 复用 PermissionEngine、Windows Sandbox、Git/快照文件变更追踪和检查点机制。

- feat | 新增 Skill 显式与隐式调用策略：支持 `$skill-name`、`/skill-name` 和 `/skills`，兼容 Codex `agents/openai.yaml` 的 `allow_implicit_invocation` 及 Claude Code 的 `disable-model-invocation`、`user-invocable`、`when_to_use` 和 `paths`。
- 新增确定性候选排序与匹配理由，按名称、description/`when_to_use`、适用路径和来源排序预算候选；本地分数只用于候选排序，最终隐式选择仍由模型通过 `load_skill` 完成。显式 Skill 正文仅注入当前 Turn，不进入后续 Turn。

### 2026-09-24

- feat | 接入 Skill 渐进式披露链路：新增 Skill Catalog 和上下文预算，初始请求只注入有限的名称、描述和 Skill ID，默认按上下文窗口 2% 计算预算，未知窗口时使用 8000 字符上限。
- 新增只读 Skill Loader、`load_skill` 和 `read_skill_reference` 工具；正文按需加载并限制大小，引用仅允许读取 `references/` 和 `assets/`，同一 Loader 实例内按内容缓存，不执行脚本、不授予额外权限。

- fix | 将 Skill `SKILL.md` frontmatter 从手写键值解析替换为 `yaml` 标准安全解析，支持多行描述、列表、布尔值、数字和嵌套对象；未知字段保留为只读元数据，不直接授予工具权限。
- 加强 Skill 元数据校验：要求 `name` 为 64 字符以内的小写短横线标识并与目录名一致，要求 `description` 为非空字符串且不超过 1024 字符；补充首行边界、非法 YAML 和多类型 frontmatter 测试。

- feat | 新增 Skill 接入与安装闭环：支持本地目录、本地压缩包和用户明确指定的 Git 仓库来源；安装前校验 `SKILL.md`、路径边界和压缩包条目，展示文件清单并经用户确认后以临时目录校验、原子移动方式安装到用户级或仓库级 `.agents/skills`。
- 新增同名 Skill 拒绝覆盖、安装取消清理、外部符号链接拒绝和安装后 Discovery 复核；安装阶段不读取正文用于模型上下文、不执行 `scripts`，也不改变权限或沙箱。

- feat | 在 `/continue` 和 `/retry` 进入恢复确认前展示来源 Turn 的工作区变化摘要，包含新增、修改、删除路径和 diff hunk 数量；展示逻辑只读，不自动覆盖、回滚或修改用户文件。
- feat | 统一合并已落库的工具级文件事件与 Turn 级 Git 差异，按操作、路径和前后哈希去重；恢复确认前支持按编号展开完整 unified diff hunk 行内容，继续保持只读安全边界。
- 验收 | 类型检查通过，完整测试 137 项中 136 项通过、1 项 Windows WSL 沙箱集成测试跳过，0 项失败。
- feat | 为检查点增加工作区 Tree OID 和 `/rollback <turn-id>` 命令；回滚前展示差异并二次确认，回滚只写工作区文件，不改变真实 Git Index、HEAD 或提交历史。Schema 升级至 v7，完整测试 139 项中 138 项通过、1 项 Windows WSL 集成测试跳过。

### 2026-09-23

- feat | 为 `run_command` 增加命令边界文件副作用追踪：权限通过后在命令前后采集 Git Tree，识别新增、修改、删除和重命名，并将统一变更事件与对应工具结果检查点原子保存。
- 命令返回非零退出码或超时时，只要执行器返回结果仍记录实际观察到的变化；追踪不可用时不阻止命令、不伪造变更。非 Git 工作区保持命令兼容，原有文件工具快照追踪不变。
- 非 Git 工作区或 Git 差异采集不可用时，工具结果显式包含 `change_tracking: "unavailable"`，避免把“未能追踪”误认为“没有文件变化”；恢复 UI 只展示已确认的路径、操作类型和 diff hunk 数量。

### 2026-09-22

- feat | 新增 `WorkspaceChangeBackend` 分层契约和 Git/快照双后端；生产 CLI 在 Git 工作区优先生成 Git 基线，非 Git 工作区或 Git 捕获失败时自动降级，不影响工具执行。
- Git 基线通过独立临时 Index 保存 Turn 开始和结束时的 HEAD、真实 Index Tree、工作区 Tree、仓库根目录、工作区前缀和对象格式；基线包含采集时已有的未提交和未跟踪文件，不执行 commit、stash、reset，也不修改真实 Index。
- 新增 Git 基线差异服务，比较 Turn 起止 Tree 并转换为统一文件变更事件；支持新增、修改、删除以及重命名的删除+新增映射，记录 SHA-256 和 unified diff hunk 行范围。
- SQLite Schema 升级至 v6，在 Turn 终态事务中保存结束工作区基线；补充 Git 起止基线差异、重命名路径、非 Git 后端和结束基线持久化测试。类型检查通过，完整测试 132 项中 131 项通过，1 项 Windows WSL 沙箱真实集成测试因环境条件跳过。
- feat | `run_command` 在权限批准后、命令执行前后采集 Git 工作区基线，将命令产生的新增、修改、删除和重命名转换为已有文件事件，并随对应 `function_call_output` 检查点事务保存；命令失败或超时但仍返回结果时也记录已观察到的文件副作用。
- 命令追踪复用 `FileChangeTracker`、Git Tree 比较服务和现有事件队列；非 Git 环境不生成猜测差异，已有文件工具快照继续工作。类型检查通过，完整测试结果见当前阶段修改总结文档。

### 2026-09-21

- feat | 新增工程级文件变更事件模型，围绕文件工具的前后快照记录 `create / modify / delete` 操作、相对路径、before/after SHA-256、unified diff hunk 的旧行/新行范围以及变更行内容。
- 将工具名称随事件记录，并通过 `takeFileChangeEvents` 按工具消费，避免同一 Turn 的历史变更重复写入后续检查点；不记录用户或 Agent 修改者归属，保持追踪层只描述事实变化。
- 新增 SQLite Schema v4 的 `file_change_events` 表、Turn 内递增序号、检查点外键、级联删除和查询索引；文件事件与 `function_call_output`、`tool_result` 检查点共用一个事务，失败时整体回滚。
- 增加文件事件结构校验、事件读取接口、快照哈希和 diff hunk 测试；类型检查通过，完整测试 129 项中 128 项通过，1 项 Windows WSL 沙箱真实集成测试因环境条件跳过。

### 2026-09-20

- feat | 为 `/continue` 和 `/retry` 增加恢复前工作区一致性检查；比较来源 Turn 指定检查点保存的指纹与当前实际文件状态。
- 新增 `matched / changed / missing_fingerprint / unavailable` 四类恢复检查结果；变化、缺失或无法检查时默认拒绝，只有用户明确确认后才继续，不自动覆盖或回滚文件。
- 新增历史检查点选择 UI；恢复命令列出检查点编号、类型、Response 或工具调用标识、Item 边界和指纹状态，支持选择历史检查点、默认最新检查点以及输入 `q` 取消。
- Replay Builder 支持通过 `checkpointId` 选择来源 Turn 的指定检查点；选择较早模型检查点时过滤孤立工具调用，但保留已确认的用户消息和推理项。
- 补充工作区指纹比较、恢复风险确认、历史检查点选择、指定检查点 Replay 和 SessionStore 检查点列表测试；完整测试 128 项中 127 项通过，1 项 Windows WSL 沙箱真实集成测试因环境条件跳过。
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
