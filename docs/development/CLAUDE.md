# Claude Code 适配与实测记录

状态：**基础调用、会话隔离、结构化结果和权限往返已实测；本机 provider 的公开网络工具未通过。** 不能以本记录宣称原著检索已可用。

核查日期：2026-09-10。实际 CLI：`2.1.261 (Claude Code)`。证据时间下表使用 UTC。所有输入均为合成短文本或公开网站地址，没有向协议测试提供用户书籍内容。

## 接口与运行范围

`server/ai/index.ts` 导出 `createClaudeAdapter(options?)`，实现 `shared/contracts/ports.ts` 的 `probe/start/cancel/answerPermission`。默认运行目录为产品数据目录下的 `runtime/claude`，不会把阅读仓库或用户文件目录当作编码工作区。

- 每轮独立 `claude -p` 进程；输入输出均为 stream-json，输入管道保持开放以回答 permission control request。
- 新讨论显式生成 UUID；接续仅使用指定的 `--resume UUID`，不使用 `--continue`、最近会话推断、任意历史分叉或全局会话扫描。
- `--safe-mode`、空 setting sources、空 MCP 配置与 `--strict-mcp-config` 隔离用户 hooks、plugins、skills、MCP。`system/init` 再次核对实际工具、插件和 MCP，越界即中止。
- `discussion/summary/daily` 不开放外部工具；`matching` 仅开放 WebSearch/WebFetch。结构化输出允许 CLI 自带的 `StructuredOutput`，它不授予文件或网络能力。
- 权限使用 `manual`、host、stdio。网络请求逐次转交界面；只允许本次或拒绝，不写永久权限，也不启用 bypass。
- 只从既有 Claude `settings.json` 的 `env` 提取认证、endpoint 和模型映射白名单；进程环境优先。不会继承该文件的权限规则、插件或 hooks，不输出凭据值。
- 默认单次运行最长 300 秒。取消先 SIGINT，5 秒未退出再 SIGKILL；正常结果也要等待进程清洁退出才可接续。取消和强停的会话均标为不可接续，由学习服务下次以显式背景新建。
- 在异步查找程序／创建目录前预留 discussion，防止并发启动竞争；尚未 spawn 的任务也可以取消。

`probe()` 分别报告安装、登录报告和本 adapter 实例是否完成过真实调用。登录报告不等于真实接通；程序重启后 `invocationVerified` 重新为 false，历史学习记录不受影响。

## 事件接入

每个事件带 `runId/bookId/discussionId/seq/createdAt`。seq 在单次运行内递增，前端不能按“当前打开节点”路由输出。

| 事件 | data |
|---|---|
| initialized | `cliSessionId`，附实际 `tools/model` |
| text_delta | `text`；UTF-8 用 StringDecoder，完整 assistant 快照不重复追加 |
| permission_required | `requestId/toolName/input/description` |
| permission_resolved | `requestId/toolName/decision`；过期或重复回答返回 409 |
| retrying | `attempt/maxRetries/delayMs`，不输出凭据或原始 provider 错误 |
| completed | `text/structuredOutput?/sessionReusable:true/toolResults` |
| cancelled | `text/sessionReusable:false/forced` |
| failed | `code/message/sessionReusable:false` |

`toolResults` 是由实际 `tool_use`／`tool_result` 关联得到的元数据数组：`{toolName,toolUseId,success,errorCode?}`。它不是模型自报的工具状态。**completed 仅说明模型运行完成；网络工具可能失败。匹配服务必须检查 toolResults，并独立取回来源正文，不能把模型凭记忆给出的 URL 或 WebFetch 的模型提取当作原文。**

stderr 不转发原始文本或分块内容，仅向可选 logger 报告已隐藏的字节数量，避免凭据跨块时漏过过滤。其他诊断经过凭据、URL、用户路径过滤并截断；界面接收固定的可操作错误文案。

## 自动化验证

```sh
npm exec vitest -- run tests/unit/claude.test.ts
npm run typecheck
```

协议／进程测试覆盖：逐字节切分中文及 emoji、无结尾换行、无效／超大 NDJSON、增量与快照去重、子 agent 文本隔离、诊断脱敏、工具白名单、明确 resume、事件归属、越界工具拒绝、permission allowOnce/deny、正常与异常退出、SIGINT/SIGKILL、启动并发竞争、spawn 前取消、静默超时、工具失败与模型完成分离。

这些使用合成 CLI fixture，验证产品协议，不冒充真实模型测试。临时测试文件在独立系统临时目录，结束后清理。

## 真实调用结果

复现需要既有 Claude 登录或 provider 凭据，且会消耗已配置账户的模型额度。脚本默认不运行模型，必须显式加 `--live`：

```sh
npm exec tsx -- scripts/claude-probe.ts --live first
npm exec tsx -- scripts/claude-probe.ts --live resume
npm exec tsx -- scripts/claude-probe.ts --live isolation
npm exec tsx -- scripts/claude-probe.ts --live cancel
npm exec tsx -- scripts/claude-probe.ts --live summary
npm exec tsx -- scripts/claude-probe.ts --live search
npm exec tsx -- scripts/claude-probe.ts --live fetch
npm exec tsx -- scripts/claude-probe.ts --live deny
```

脚本每次创建隔离临时 cwd；只打印脱敏状态与合成输出。matching 用例只有实际工具结果成功才返回退出码 0；拒绝用例单独验证拒绝路径。取消用例在首个输出或初始化后 4 秒触发，最长 120 秒运行期限。

| 实测 | UTC 时间／运行 ID | 结果 |
|---|---|---|
| 首次中文流式 | 09:23:28–30，`f21aa2d8-e071-4f92-a2d7-07baab59c8f9` | **通过**；tools=[]，中文输出完整，清洁退出，sessionReusable=true |
| 明确会话接续 | 09:25:14–23，`5113999d-a51f-4bba-9643-7abd7d828a9a` → `91ecc910-45a2-4866-9dc9-f3856b3fdaab` | **通过**；相同 session `6cb06229-8b3c-495d-a8f5-6fee2efe5e5a`，第二轮准确返回合成 marker |
| 兄弟隔离 | 09:26:26–32，`bec4ee35-3a34-4ffd-b2cd-988e7e4580d0` → `7700b0b6-e4a2-49ce-8c33-86d00f2b01af` | **通过**；第二个新会话仅返回 UNKNOWN，没有第一会话的 marker |
| 独立结构化小结 | 09:27:05–08，`7eb607db-e79b-4608-bbbc-e464226e26be` | **通过**；新的 session、仅 StructuredOutput，返回符合 summary 对象的 structuredOutput |
| 取消后新运行 | 09:27:05–09:29:09，`17ca8aeb-efd1-4528-9aea-51f53afa3251` → `4b83af8e-6135-4451-8fbb-b88432087e2f` | **通过**；保留已输出的合成片段，SIGINT 正常退出（forced=false），不可接续；下一新会话完成 |
| WebSearch 本次允许 | 09:25:14–22，`ed24d030-7ec1-4583-b7f5-e4b50d248591` | **权限往返通过；搜索失败**。本机 provider 返回 403 Access denied。该轮早于 toolResults 元数据补充，模型报告不计作成功证据 |
| WebFetch 本次允许 | 09:26:26–36，`6767e367-b903-40a5-89f4-28c379c83004` | **权限往返通过；取回失败**。实际 tool_result：WebFetch success=false，TOOL_FAILED。未取得原文 |
| WebFetch 拒绝 | 09:27:05–08，`3d4975d6-21ba-4eb8-acd5-9a82519a9c21` | **通过**；required → resolved(deny)，tool_result 为 PERMISSION_DENIED，模型停止并返回 DENIED |

首次隔离试运行曾出现 `authReported=true` 而实际 Not logged in：原因是可用 provider 连接配置来自用户 Claude settings.env，空 setting sources 没有加载它。提取上述白名单后首次调用通过；没有更改用户配置或登录状态。

网络工具失败不阻塞普通讨论、明确接续、整理和权限拒绝的本地开发，但阻止“自动原著检索已验证可用”的放行。需要可用的 Claude 网络工具配置，或经总负责人审定的公开检索实现，再进行真实复验。未无限重试，也未自动改用其他 AI 供应商。

## 来源

- 接口行为依据 [Claude Code 程序化运行文档](https://code.claude.com/docs/en/headless) 及本机 `claude --help`，均在核查日期读取。
- 协议模式参考 [ThoughtDAG 的 Claude bridge](https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/runtime/agents/claude.cjs)，固定 commit `3d63111dba182ece5d3c4c583ab1ac120d5276be`，[MIT 许可](https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/LICENSE)。MomentRead 按自己的端口重新实现；未迁入其目录快照、全局会话查找、任意文件工具或 bypass 权限分支。
