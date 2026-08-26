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
- SQLite 基础层：包含 Schema 迁移、外键、WAL 和会话数据表结构。

> SQLite Session 持久化目前仍处于基础设施阶段，尚未接入 CLI 会话恢复流程。

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
├── file_change_tracker.ts    # 文件变更和 diff
├── config/                   # Prompt、工具和本地配置
├── tools/                    # 工具、权限、注册表与沙箱
└── tests/                    # 单元测试和可选集成测试
```

## 开发状态

当前版本已完成 Responses API ReAct 工具链、权限模型、文件安全和 Windows 沙箱框架。后续将逐步接入 SessionStore、Runtime Item 持久化、CLI 会话恢复和上下文管理。

## 更新记录

- 2026-08-26 | refactor | 将模型通信完整迁移到 Responses API，支持 typed Items、无状态推理重放和函数调用结果关联。
