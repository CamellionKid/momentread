# Claude Code 适配与实测记录

状态：**用户处理额度后，13:39–13:42 UTC 的真实 first、明确 resume 和固定 URL WebFetch 已通过；WebSearch 只返回空结果，公开搜索验收仍未通过。** 历史额度故障保留在下文，不能用工具未报错代替返回有效搜索结果。

核查日期：2026-09-10。实际 CLI：`2.1.261 (Claude Code)`。证据时间下表使用 UTC。所有输入均为合成短文本或公开网站地址，没有向协议测试提供用户书籍内容。

## 接口与运行范围

`server/ai/index.ts` 导出 `createClaudeAdapter(options?)`，实现 `shared/contracts/ports.ts` 的 `probe/start/cancel/answerPermission`。默认运行目录为产品数据目录下的 `runtime/claude`，不会把阅读仓库或用户文件目录当作编码工作区。

- 每轮独立 `claude -p` 进程；输入输出均为 stream-json，输入管道保持开放以回答 permission control request。
- 新讨论显式生成 UUID；接续仅使用指定的 `--resume UUID`，不使用 `--continue`、最近会话推断、任意历史分叉或全局会话扫描。
- `--safe-mode`、空 setting sources、空 MCP 配置与 `--strict-mcp-config` 隔离用户 hooks、plugins、skills、MCP。`system/init` 再次核对实际工具、插件和 MCP，越界即中止。
- `discussion/summary/daily` 不开放外部工具；`matching` 仅开放 WebSearch/WebFetch。结构化输出允许 CLI 自带的 `StructuredOutput`，它不授予文件或网络能力。
- `discussion/summary/daily` 的系统提示要求自然、通顺的简体中文；仅在辨析外文引句、专名或术语时保留必要外语，并紧接中文释义。学习上下文内保留相同约束，但不把用户数据字段当作系统指令。
- 权限使用 `manual`、host、stdio。每个 matching 运行只向界面询问一次；允许或拒绝只覆盖该运行的 WebSearch／WebFetch，不写永久权限，也不启用 bypass。适配器限制每轮最多 3 次 WebSearch 和 5 次 WebFetch，超额请求自动拒绝。
- 只从既有 Claude `settings.json` 的 `env` 提取认证、endpoint 和模型映射白名单；进程环境优先。不会继承该文件的权限规则、插件或 hooks，不输出凭据值。
- CLI 启动和模型运行各有期限；默认各 300 秒。启动阶段防止进程永不初始化，首次有效 initialized 后只重置一次运行期限，重复初始化不能延长期限。取消先 SIGINT，5 秒未退出再 SIGKILL；正常结果也要等待进程清洁退出才可接续。取消和强停的会话均标为不可接续，由学习服务下次以显式背景新建。
- 在异步查找程序／创建目录前预留 discussion，防止并发启动竞争；尚未 spawn 的任务也可以取消。

`probe()` 分别报告安装、登录报告和本 adapter 实例是否完成过真实调用。登录报告不等于真实接通；程序重启后 `invocationVerified` 重新为 false，历史学习记录不受影响。

## 事件接入

每个事件带 `runId/bookId/discussionId/seq/createdAt`。seq 在单次运行内递增，前端不能按“当前打开节点”路由输出。

| 事件 | data |
|---|---|
| initialized | `cliSessionId`，附实际 `tools/model` |
| text_delta | `text`；UTF-8 用 StringDecoder，完整 assistant 快照不重复追加 |
| permission_required | `requestId/toolName/input/description` |
| permission_resolved | `requestId/toolName/decision/resolvedCount`；decision 为 allowRun 或 denyRun，过期或重复回答返回 409 |
| retrying | `attempt/maxRetries/delayMs`，附 allowlist `errorCategory` 和可选 HTTP `status`；不输出凭据或原始 provider 错误 |
| completed | `text/structuredOutput?/sessionReusable:true/toolResults` |
| cancelled | `text/sessionReusable:false/forced` |
| failed | `code/message/sessionReusable:false`；已识别的服务故障附 `errorCategory/status?` |

`toolResults` 是由实际 `tool_use`／`tool_result` 关联得到的元数据数组：`{toolName,toolUseId,success,errorCode?,resultCount?}`。success 仅表示工具未返回 is_error。WebSearch 的 resultCount 只统计已识别结果正文中明确返回的链接，排除 query 标题和 REMINDER；无法识别的格式不返回计数。它不是模型自报的工具状态。**completed 仅说明模型运行完成；网络工具可能失败或返回零结果。匹配服务须独立取回来源正文，不能把模型凭记忆给出的 URL 或 WebFetch 的模型提取当作原文。**

stderr 不转发原始文本或分块内容，仅向可选 logger 报告已隐藏的字节数量，避免凭据跨块时漏过过滤。其他诊断经过凭据、URL、用户路径过滤并截断；界面接收固定的可操作错误文案。

## 自动化验证

```sh
npm exec vitest -- run tests/unit/claude.test.ts
npm run typecheck
```

协议／进程测试覆盖：逐字节切分中文及 emoji、无结尾换行、无效／超大 NDJSON、增量与快照去重、子 agent 文本隔离、诊断脱敏、工具白名单、明确 resume、事件归属、越界工具拒绝、单次 allowRun/denyRun、并发请求合并、后续请求沿用运行决定、工具次数上限、正常与异常退出、SIGINT/SIGKILL、启动并发竞争、spawn 前取消、静默超时、工具失败与模型完成分离。

这些使用合成 CLI fixture，验证产品协议，不冒充真实模型测试。临时测试文件在独立系统临时目录，结束后清理。

## 真实调用结果

复现需要既有 Claude 登录或 provider 凭据，且会消耗已配置账户的模型额度。脚本默认不运行模型，必须显式加 `--live`：

```sh
npm exec tsx -- scripts/claude-probe.ts --live first
npm exec tsx -- scripts/claude-probe.ts --live resume
npm exec tsx -- scripts/claude-probe.ts --live isolation
npm exec tsx -- scripts/claude-probe.ts --live cancel
npm exec tsx -- scripts/claude-probe.ts --live summary
npm exec tsx -- scripts/claude-probe.ts --live language
npm exec tsx -- scripts/claude-probe.ts --live search
npm exec tsx -- scripts/claude-probe.ts --live fetch
npm exec tsx -- scripts/claude-probe.ts --live deny
```

脚本每次创建隔离临时 cwd；只打印脱敏状态与合成输出。matching 用例要求实际工具未报错，search 还必须观察到 WebSearch 明确返回至少一个结果链接，否则退出码为 1；拒绝用例单独验证拒绝路径。取消用例在首个输出或初始化后 4 秒触发，最长 120 秒运行期限。

`language` 连续创建三个独立 discussion 会话，分别检查普通段落、Markdown 标题／列表和加粗／示例。输入均为合成中文问题并明确禁止外语；任一最终回答少于 20 字或包含拉丁字母，探针退出码为 1。该断言用于发现明显的中外文粘连，不等于对内容正确性作自动评分。

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

## 后续集成故障复诊：5 小时额度已耗尽

2026-09-10 后续系统验收出现新的外部阻塞，不能沿用上午的成功结果宣称当前 AI 可用：

- 实际接续运行 `9d0e63d4-3e27-430d-880a-94183dd81342` 在 `10:29:39.286Z` 开始，经过 CLI 内部重试后于 `10:32:46.081Z` 失败。
- 仅读取这个运行对应的明确会话 `765e7174-ed21-4776-8416-47910baf4448`，其 `10:32:45.999Z` 的 CLI 系统错误带 `error=rate_limit`、`isApiErrorMessage=true`；服务返回 **HTTP 429，5-hour usage quota 已耗尽**。
- 服务提示恢复时间为 **2026-09-10 21:06:28 +0800**。这是服务当时给出的时间，不保证额度恢复后的下一次请求一定成功；恢复后仍须真实复测。
- H 独立盲测的合成 first 运行 `f1ac2b39-4d19-4e64-8104-82f85f65e174` 于 `10:34:26Z` 初始化，重试至第 9 次，在 `10:36:26Z` 到达 120 秒期限。它使用旧版事件字段，未保留服务错误类别，因此只记为重试后超时；不能把超时本身当成独立的 429 证据。复诊复用这次已有测试，没有额外发送模型请求。
- 既有配置来源仍是 Claude settings.env 的认证／endpoint／模型白名单，进程环境没有同名连接配置。先前成功探针与 H 失败探针的 initialized.model 均为 `claude-opus-4-8[1m]`，没有观察到请求模型切换。目标会话先前成功 assistant 的 provider 返回 model 为 `glm-5.3`，错误消息为 `<synthetic>`；CLI 请求别名不能证明实际底层模型身份。

处理方式：等待现有服务额度恢复，再使用相同配置复测 first、服务重启后的明确 resume 和完整阅读流程。没有修改账户、认证、provider 或模型映射，也没有充值、购买、额度重置或无限重试。

本次代码修正保留安全的服务错误分类：429、认证拒绝、访问拒绝、模型不可用、5xx、无响应等对应固定文案。达到应用超时前若已知服务错误类别，终态保留该类别。带 `assistant.error`／`isApiErrorMessage` 的 CLI 系统错误不再追加为普通 AI 正文；仅从额度错误中提取严格的数字恢复时间，原始错误文本、内部地址、凭据和请求标识不进入界面。自动化用协议 fixture 验证该修正，没有把 fixture 结果冒充额度恢复后的真实成功。

## 用户处理额度后的真实复验

用户明确额度已处理后，保持既有 provider／模型配置，执行了有界复验；没有改写全局设置、再次登录或购买额度。

| 用例 | UTC 时间／运行 ID | 实际结果 |
|---|---|---|
| first | 13:39:30–31，`b2adc39f-5fb7-4482-b453-c5530f27822b` | **通过**；中文逐字断言及流式合并断言成功，无 retry，清洁退出 |
| 明确 resume | 13:40:05–08，`4a7fe902-b1ee-416c-b518-7685ea471643` → `98b1c761-476f-4bb4-a197-b17659c954a1` | **通过**；相同 session `87234f80-2814-480e-84b6-9f87665733a1`，准确取回合成 marker |
| WebSearch | 13:40:05–12，`bfbc3dd5-2c10-4e29-ba6e-9514154a2838` | **未通过搜索结果验收**；允许本次权限后工具未报错，但真实返回仅含查询标题、空白正文及 REMINDER，零来源链接 |
| WebFetch | 13:42:35–43，`a1d16d7a-3e30-45dc-aae8-7d3e70186d45` | **固定 URL 工具调用通过**；实际 WebFetch result success=true，模型报告 Gutenberg 页标题。独立正文取回／引句核对仍由匹配模块另行验收 |

2026-09-11 09:09:04–25 UTC，加入系统级中文约束后，`language` 的三个独立真实运行 `eba7dc36-c6a8-40d9-ba6b-fe5f6f02a6f1`、`04d213f5-b0ee-4783-b433-da8b4a613b4d`、`8531edd1-2544-4f34-a240-b51cec7dfb2f` 均通过；三份最终回答均超过 20 字且不含拉丁字母，Markdown 标题、列表与加粗内容完整。随后新的无历史界面测试者在真实 EPUB 上检查根讨论和两个兄弟分支，3/3 回答为自然简体中文；一个保留的外文术语具有紧邻中文释义。

2026-09-11 09:54:13–15 UTC，启动／运行两阶段期限修复后的最终真实 first 运行 `346a023f-bbcf-49e6-95d8-d2e3a6b7d76f` 通过：initialized 后返回精确中文短句，进程清洁退出且 sessionReusable=true。对应竞态断言连续执行 10 次通过，静默进程超时和瞬时错误后成功用例另行通过。

CLI initialized.model 均为 `claude-opus-4-8[1m]`；此次 first 和 search 明确任务会话中的 assistant provider 返回 model 字段为 `glm-5.3-flash`。两者分别是 CLI 请求标识与 provider 自报标识，不据此保证实际底层模型身份。

WebSearch 这次没有复现早先 403，不能继续把当前失败归因为 403，也不能仅凭一次空查询认定 provider 永久不支持搜索。观察事实是：同一配置的普通推理和固定 URL 取回恢复，公开搜索没有给出本次查询的有效结果。没有为寻找成功截图而重复搜索或切换供应商。

复验原始日志位于本机忽略目录 `tmp/claude-recovery/`。首次 search 探针当时只检查 is_error，退出码 0 曾造成过宽的成功判定；已修正探针，新增 resultCount 和 query／REMINDER 排除测试。对该真实工具结果离线重放得到 `transportSuccess=true/resultCount=0/searchAcceptancePassed=false`，未额外发起模型调用。当前 26 项 Claude 模块测试覆盖空搜索门槛、瞬时 API 错误后恢复和单轮权限合并；全仓类型检查通过。这不代替完整系统与盲测验收。

## 首次使用盲测发现的权限提示风暴与修复

最终候选 `e4948e0` 的全新上下文盲测在一次真实原著匹配中遇到 49 次人工确认。SQLite 事件复核显示，这些是 Claude 并行产生的不同 WebSearch／WebFetch 请求，不是 SSE 重放；逐调用的 allowOnce 语义会把底层工具粒度暴露给读者，构成首次使用阻塞。

修复后，当前 matching 运行只显示一个决定条，并由 adapter 结清同轮并发请求；后续允许范围内的请求自动沿用本次决定，其他运行仍重新询问。提示词和 adapter 同时限制最多 3 次搜索、5 次取回；即使模型忽略提示也不能越过硬上限。合成 CLI 测试验证并发合并、后续调用、拒绝和超额拒绝。

2026-09-11 04:04 UTC 的真实 `search` 探针运行 `0f050f7e-dfa6-4bf3-b955-197613c4fbc5` 只产生一次 required → resolved(allowRun)，随后完成；WebSearch 仍返回零链接，因此搜索验收保持失败。04:06–04:07 UTC 在真实《虚无主义》产品界面运行 `aadc10e4-c304-472e-99ac-5163c4b42694`：只显示一个授权条，一次点击结清 2 个并发请求，随后 20 秒观察期没有再次出现。运行最终返回空候选且工具不可用，界面继续标记“原著尚未核对”。这证明权限交互修复，不证明自动原著发现可用。

## 来源

- 接口行为依据 [Claude Code 程序化运行文档](https://code.claude.com/docs/en/headless) 及本机 `claude --help`，均在核查日期读取。
- 协议模式参考 [ThoughtDAG 的 Claude bridge](https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/runtime/agents/claude.cjs)，固定 commit `3d63111dba182ece5d3c4c583ab1ac120d5276be`，[MIT 许可](https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/LICENSE)。MomentRead 按自己的端口重新实现；未迁入其目录快照、全局会话查找、任意文件工具或 bypass 权限分支。
