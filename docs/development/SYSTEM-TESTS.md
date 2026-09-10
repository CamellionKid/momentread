# 独立 HTTP／系统测试

日期：2026-09-10。执行者：独立系统测试 Agent G。测试依据为 PRD A01–A21、HTTP.md、CONTRACTS.md、LEARNING.md、CLAUDE.md、EPUB.md、shared/contracts 和模块公开导出。未读取产品实现细节来生成预期；缺陷交给产品模块负责人修复，测试不修改产品源码或公共契约。

**当前结果：49 项全部通过。** 2026-09-10 18:18:17（本机时间）完整执行四个系统测试文件，49 项通过，0 失败、0 未执行，测试进程报告耗时 1.25 秒；`npx tsc --noEmit` 通过。原有 23 项、边界回归 9 项、报告／恢复回归 5 项及元数据回归 12 项一起复验；没有放宽期望。SYS-01 与 SYS-02 由负责人修复后通过原始断言复验。

## 输入与边界

- 每个用例创建独立系统临时目录和真实 SQLite、BookLibrary、LearningService、MatchingService，以及真实 Hono HTTP 应用；经 `app.request(Request)` 调用路由。
- EPUB 为 fflate 在内存生成的两个合成章节。相同句子在两章各出现一次，引用同时带书籍、不可变文件版本、章节、spine 与 range CFI。不读取或提交用户书籍。
- 导入／下载／备份／恢复使用真实文件字节及 multipart；重开通过关闭 Store、重新创建服务完成。
- ControlledAdapter 仅为有意注入流式、取消、结束缺失和错误结构的确定性测试替身，不连接 Claude、检索服务或模型供应商。不把它的解释文本作为语义质量或检索证据。
- 不执行 Git；测试文件由总负责人审查并按项目要求提交。

## 运行

在仓库根目录，使用 `.nvmrc` 指定的 Node 22.23.0：

```sh
npx vitest run tests/integration/system-*.test.ts
npx tsc --noEmit
```

测试实现：`tests/integration/system-http.test.ts`、`tests/integration/system-boundaries.test.ts`、`tests/integration/system-reports.test.ts`、`tests/integration/system-metadata.test.ts`；共享合成输入与可控适配器：`tests/contract/system-fixtures.ts`。

## 覆盖范围

| 验收／风险 | 系统检查 |
|---|---|
| A01、A11 | 文件复制后移动原文件、下载字节一致；保存章节／CFI／字号／活动节点／独立草稿，关闭并重新打开 SQLite 后比对；重开不启动 AI |
| HTTP 契约、A21 | health、runtime、books、state、report 的公开响应 schema；AI 不可用时既有记录可读；非法／缺失 ID、畸形 JSON 与损坏 EPUB 返回结构化 4xx |
| A02、A08 | 原著匹配失败后仅顺序触发一个 discussion 运行；保持同书同选段及未确认来源状态；重复读取 state 不重发 |
| A03、A14、A15 | 不接受另一书的来源消息或错误文本范围；通过公开分支接口建立三层树，保持直接父子关系 |
| A05、A17 | 独立草稿持久化；运行途中切换活动节点，最终消息仍属于发起节点 |
| A06、A07、A16 | 结构化小结仅为待确认草稿；用户编辑后确认、历史查询；仅直接父节点收到回馈；重复确认和重启后幂等；同 requestId 换正文冲突；过期预览拒绝且保留讨论与草稿 |
| A12 | HTML 在离线文本中保留恶意字符串的字面值，不生成 script、img、onerror 等可执行内容 |
| SSE | 全量事件响应满足 EventSchema；query／Last-Event-ID 重放严格晚于游标、序号唯一、归属一致且不重启适配器 |
| 运行故障 | 同讨论并发请求被拒绝且不保存被拒绝问题；取消保留片段并禁用接续；流结束但缺最终结果失败；summary 结构不符失败、不给出虚假完成小结 |
| 备份恢复 | ZIP 恢复真实书籍和学习记录到空库；已导入书籍的目标库拒绝覆盖，原库不变 |
| 运行中重启 | 先完成一次可接续运行，再让第二次以 resume 开始且保存部分输出；不发送 cancel／最终事件，关闭 Store 并重建服务。旧运行变 interrupted／不可接续，第三次调用必须 new，不能复用第一个成功运行留下的旧 session |
| 恢复后的下载权限 | 在备份 SQLite 中注入旧 `backup-download:<id> → {path}` 记录，指向合成本机哨兵文件；使用公共存储序列化并重算 manifest 摘要，避免校验和拒绝掩盖路径问题。恢复可安全拒绝或接收数据，但下载必须返回结构化 4xx，不能读取哨兵内容 |
| 备份下载生命周期 | 当前服务创建的备份可下载；服务重建后旧下载 ID 失效；新生成备份仍可下载 |
| OpenAPI | 实际 books 列表 200／数组、import 201／Book、analysis 202／discussionId+runId、run 200／Run、输入错误 400／Error、缺失运行 404／Error，与生成文档的状态和 JSON schema 一致 |
| A12 重复生成报告 | 同书／日期／时区通过真实 POST 连续生成两个不同 AI text，均 202 后 completed；每个 run 保留 advice／date／timezone／summaryIds，旧建议不被覆盖。随后生成其他书籍与时区的报告；JSON／HTML 仍读取目标组合的最新版，不串书籍、日期或时区 |
| 无效日历日期 | `2026-02-30`、`2026-02-29`、`2026-04-31` 分别在 GET report、GET HTML、POST report 中返回结构化 400 日期错误；没有新增 run 或调用 AI |
| 便携备份会话隔离 | 先成功建立可接续会话，再在第二次 resume 的活动阶段创建真实 ZIP 并恢复到空库。恢复的活动 run 为 interrupted／不可接续、保留 partialText；导入的 Session 记录全部 reusable=false；下一轮通过 new 会话继续 |
| F01 元数据补录 | `PATCH /api/books/:id` 以 200 返回补录的 title／author／language／translator／edition／identifier；关闭并重开后仍一致，不改变 EPUB 字节、fileVersionId、阅读位置、活动讨论或已有原文引用 |
| F01 旧记录兼容与校验 | 只有旧必填字段的 Book 可持久化、重开、列表读取并补入新字段；六个字段的长度上限可接受，可选字段可清空。未知键、空白标题及超长字段返回结构化 400，书籍状态与文件字节均无部分写入 |

CFI 在这些系统用例中验证持久化与身份，不能证明浏览器 DOM 选区往返。本报告不替代阅读模块的格式／CFI 测试，也不替代真实浏览器鼠标选段和渲染验证。

运行中重启测试通过重新实例化公开服务、复用同一持久化文件，验证启动恢复逻辑；没有启动并强杀真实 Claude／Node 子进程，不能替代进程级 SIGKILL 端到端验证。追加边界由负责人提出并修复，新增测试首轮即通过，不能声称独立复现过其修复前行为。

## 首轮缺陷证据

2026-09-10 17:49（本机时间），首轮完成 21 项：9 通过，12 失败。12 个失败不是 12 个独立产品缺陷；多个后续断言被同一个状态读取问题阻断。

| 编号 | 最小操作与实际结果 | 预期／影响 | 处置 |
|---|---|---|---|
| SYS-01 | `POST /api/books` 成功，返回 Book 通过 schema，`GET /api/files/:fileVersionId` 字节一致；但同书 `GET /api/books/:id/state`、`PATCH /api/books/:id/workspace` 和合法 `POST /api/analyses` 返回 `404 {error:{code:"NOT_FOUND",message:"找不到记录。",retryable:false},requestId:...}` | 新导入书可立即查询、定位、分析；该问题阻断重启恢复、跨书校验后状态比对、回馈、备份恢复读回等用例 | 负责人修复；17:52 完整复验通过 |
| SYS-02 | `POST /api/analyses`，Content-Type application/json，body `{broken` 返回 500 | 输入解析错误应返回结构化 4xx，并保持库不变 | 负责人修复；17:52 完整复验通过 |

17:50 只复跑上述三个最小用例，3 失败／18 未执行；复现 SYS-01 与 SYS-02。随后新增两项公共 schema／有效结构化 summary 检查，总用例数为 23。`npx tsc --noEmit` 已通过。

## 尚不能据此判定通过

- 浏览器实际选区、字号和面板变化后的 CFI 恢复、蓝圈唯一性、悬停标签、深层折叠导航、父节点滚动恢复的可见效果。
- 真实 Claude CLI 连接、语义解释、同词多义理解、原著候选真实性、网络检索权限与供应商可用性。
- A09、A10、A13、A18 的完整业务与界面验收，以及 A20 干净环境只依 README 安装。
- 用户使用后的学习效果、返回思路是否顺畅、真实数据规模与跨平台兼容性。

以上由总负责人及另外的浏览器盲测者分别验证，不从合成接口测试推定通过。
