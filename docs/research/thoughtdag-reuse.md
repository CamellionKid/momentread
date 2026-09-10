# ThoughtDAG 与 MomentRead 的复用评估

核查日期：2026-09-10。上游：[chenxiachan/thoughtdag](https://github.com/chenxiachan/thoughtdag)。固定版本：`3d63111dba182ece5d3c4c583ab1ac120d5276be`。

结论：值得按模块复用。最有价值的是分支上下文算法、上下文变更追踪、Claude Code 本地桥接，以及已经存在的 DeepSeek Harness 插件。MomentRead 继续沿用已确认的阅读布局与讨论流程；整仓改造会同时引入大量画布、编码代理和会话管理功能，现阶段不建议采用。

本次完成源码核查与 6 项纯图算法测试，没有迁入应用代码、安装上游依赖、启动其 UI 或调用真实 AI。以下“可复用”指源码层面的候选，不能理解为已经完成兼容验证。技术选型仍待决定。

## 1. 与我们的需求逐项对应

| MomentRead 需求 | 上游已有实现 | 复用判断 |
|---|---|---|
| 同一解析展开两个概念，概念继续展开子概念 | `addQuestion` 接收 `parentId`、`branchContext`，每次创建节点及父边；祖先遍历支持多级结构 | 分支算法可提取；需要改成“一个节点容纳整场讨论” |
| 子讨论知道来源背景，兄弟讨论互不混入 | 分开组装材料、主线和显式引用；按祖先关系获取上下文 | 高价值；6 项测试覆盖了其中的结构行为，真实后端会话隔离仍需验证 |
| 阅读中定位与切换概念 | React Flow 画布、节点选择、分支布局、来源信息 | 可参考选择状态与拓扑；全尺寸卡片布局需改成右侧窄线路图 |
| 子窗口“整理并返回” | 有回答摘要、回顾便签、压缩副本树 | 没有与本产品等价的完整流程，需要新增直接父讨论回馈和确认版本 |
| 上游内容修改后提示关联内容受影响 | `upstreamFingerprint` 与 `lastContextHash` 等记录 | 可改造为“子小结已更新，父讨论待重新整理”的提醒；不能直接替代小结版本管理 |
| 使用现成 CLI / harness | Claude Code、Codex、Pi runtime；另有 DSH 插件 | 桥接是具体可复用代码；当前 runtime 注册表没有 OpenCode |
| EPUB 阅读、字体变化后的选段回跳 | PDF 等附件阅读，节点有页码和选区矩形锚点 | 已查模块未发现 EPUB 支持；仍需 foliate-js / epub.js 等阅读内核及 CFI 定位 |
| 中文选段自动寻找外文原著 | 网页抓取、检索和材料引用相关设施 | 不等于跨语言段落对齐；未发现本产品所需的匹配、候选核对与版本追踪闭环 |
| “理性”等术语的多义书内记忆 | 全局偏好／身份／项目记忆，后台自动判断写入 | 不直接采用。需要按书、原语术语、语境、出处及确认状态保存概念 |
| 今日 HTML 阅读成就卡 | JSON / Markdown 导出、回顾便签、PNG 海报导出 | 可参考导出动作和视觉组织；阅读进度、概念汇总及离线 HTML 模板仍需新增 |

源码依据：[分支创建][ask]、[图与上下文分层][graph]、[上下文构建][context]、[节点类型][types]、[布局][layout]、[回顾便签][recap]、[压缩副本树][condense]、[记忆][memory]、[导出][export]、[海报][poster]。

## 2. 最重要的模型差异

ThoughtDAG 的问答节点保存 `question`、`response` 及答案版本。继续追问也会新增节点；连线决定哪些上游内容进入模型。MomentRead 已确认的是“一场概念讨论一个节点”，讨论内部可以有多轮问答，只有另一个概念才增加线路分支。上游 `responses` 是答案版本，不能直接当作多轮消息列表。[源码][ask]

例如一个段落分别引出“理性”和“知性”，“理性”再引出“先验”：

```text
段落解析（内部多轮问答）
├─ 理性（内部多轮问答）
│  └─ 先验（内部多轮问答）
└─ 知性（内部多轮问答）
```

“先验”整理后回到“理性”，“理性”整理后回到段落解析。这个返回动作不是新增一条“子节点 → 原父节点”的上下文边，否则会与原有父子边构成环。建议把讨论导航关系、生成时的背景快照、确认回馈分别表达；具体数据结构在实施前定案。

同一个词出现多个分支时，还需要来源消息与选区定位。上游 `branchContext` 和 `branchYRatio` 可以传递选中文字及视觉位置，但不能替代我们的 EPUB CFI、消息选区和术语义项标识。[类型定义][types]

上游的回答摘要被明确标为展示用途，不进入上下文；`recapToNote` 创建未连线的便签，也不会自动回馈。因此不能只给现有摘要按钮换名，就宣称实现了“整理并返回”。[摘要字段][types]、[便签流程][recap]

## 3. 哪些代码值得先提取

| 入口 | 提取价值 | 接入时必须处理 |
|---|---|---|
| `src/lib/graph.ts` | 祖先顺序、兄弟隔离、材料／主线／引用分层；运行时无外部依赖，仅类型引用 | 适配讨论粒度；保留防环约束；不照搬自由合流功能。下游遍历假设无环，多父 DAG 中也可能返回重复后代 |
| `src/store/context-builder.ts` | 有来源的背景块、引用块、生成背景指纹 | 与上游节点字段、附件、token 计数等耦合；需适配选段、书内概念和确认小结。指纹用于失效提示，不是可靠的内容版本号 |
| `runtime/agents/claude.cjs` | 启动 Claude Code、流式事件、恢复、取消及权限问答 | 依赖 `fs-diff.cjs`；现有编码工作区与权限逻辑需收窄到阅读用途。不能继承其 `allow → bypassPermissions` 分支作为默认行为 |
| `runtime/agents/http.cjs` + `src/lib/agents/http-bridge.ts` | 浏览器与本地 CLI 之间的请求／事件桥接 | 路由带有目录、终端、材料和会话管理依赖；按所需能力提取，不是拷贝两个文件即可运行 |
| `dsh/lib/index.js` | DSH 宿主内的会话创建、历史位置分叉、背景注入、继续对话与事件回传 | 依赖 DSH 插件服务及宿主版本；需映射为 MomentRead 的讨论和返回语义 |
| `src/lib/persistence.ts` | Zustand + IndexedDB 对象存储、延迟保存与切换时 flush | 可借鉴浏览器缓存；关闭页面的异步写入不能替代可验证的学习数据备份，也尚未决定作为主存储 |

源码：[runtime 说明][runtime]、[Claude Code 桥接][claude]、[HTTP 服务桥接][http]、[浏览器桥接][http-client]、[存储][persistence]。

### Claude Code 的分叉限制需要单独验证

桥接源码中，`forkEntryId` 只用于决定是否增加 `--fork-session`，没有把该字段的值作为历史消息位置传给 CLI。前端常规发送路径也主要判断是否接着已跟踪会话的末尾继续，否则新建会话并传入编译后的背景。因此，本次只能确认“有恢复／分叉桥接代码”，不能确认“可从任意旧问答精确分叉”。这直接影响兄弟分支是否会带入不该出现的历史。[CLI 参数][claude]、[前端会话路由][agent-client]

### DSH 插件比此前的候选描述更具体

它已有 `dsh-thoughtdag` 插件包，核查版本为 `0.4.12`。`runAgentTurn` 会根据历史用户消息找到回合结束位置，调用 `sessionController.fork({ atSeq })`；也会使用 `agent.inject` 添加背景，并通过 `sessionController.prompt` 发起下一轮。模型运行和工具循环由 harness 承担。[插件实现][dsh-code]

但同一插件也提供直接调用 `ctx.llm.stream` 的路径，用于画布模型请求等，不应把所有 AI 调用都理解为复用完整 agent 会话。选择首版路径时需明确摘要生成是否走同一个后端。[插件说明][dsh-readme]

其包声明的兼容记录为 DSH `0.1.2-rc.1`，不能据此保证其他版本运行正常。全局扫描其他工具历史会话、编码文件变更、终端等能力不属于 MomentRead MVP。[包声明][dsh-package]

## 4. 对选型的更新建议

“本地网页 + 现成 harness”仍然适用；ThoughtDAG 证明这种组合已有代码可借用。但复用 harness 后，产品仍需要管理书籍位置、讨论关系、回馈小结，以及送给模型的学习背景。

| 路线 | 相对优势 | 主要代价 |
|---|---|---|
| 独立 MomentRead 网页，提取 Claude Code 桥接 | 保留已选界面，有具体 CLI 代码起点，便于将来更换后端 | 自己维护本地服务与适配边界；精确分叉、恢复及摘要注入需要验证 |
| MomentRead 做成 DSH 插件 | 可沿用现成宿主与会话服务；ThoughtDAG 已有端到端调用路径的代码示例 | 与 DSH 插件体系和版本绑定；阅读界面及学习状态仍需开发 |
| 独立网页对接 OpenCode | 保留此前候选，原生服务接口值得对比 | 本次 ThoughtDAG 核查没有找到可直接提取的 OpenCode adapter，需要另行实现／验证 |

建议先验证 Claude Code 桥接和 DSH 插件这两个有现成代码的入口，再决定是否维持此前“OpenCode 优先”的顺序。若倾向独立 MomentRead 产品，先验证前者；若愿意依赖 DSH 宿主，后者值得优先试跑。此处没有替用户确定后端或数据模型。

第一轮验证应只打通：合成段落 → 两个概念分支 → 一个孙分支 → 整理回直接父讨论 → 重启恢复。加入一条只属于兄弟分支的独特信息，检查它是否泄入另一分支，并测试历史位置分叉、生成失败和返回重复点击。真实 EPUB、原著匹配、HTML 卡片在这条链路成立后再接入。

## 5. 已做验证与尚未覆盖的范围

从 GitHub 浅克隆固定提交，在临时目录直接导入上游 `src/lib/graph.ts`，使用 Node `v22.23.0` 的 TypeScript stripping 和 `node:assert/strict` 执行合成数据断言。未安装 npm 依赖，未访问个人书籍、其他 AI 工具的会话或凭据。

输入节点为 `book → p`、`p → a`、`p → b`、`a → a1`、`a1 → a2`；`book` 类型为 file，其余为 human。结果如下：

| 断言 | 结果 |
|---|---|
| `partitionContext(b).mainline` 为 `[p,b]`，不含 a 子树 | 通过 |
| `partitionContext(a2).mainline` 为 `[p,a,a1,a2]`，不含 b | 通过 |
| a2 的 materials 为 `[book]`，书籍材料与讨论分开 | 通过 |
| 添加 b 到 a2 的 cross-link 后，b 进入 quote reference，主线不变 | 通过 |
| `selectionSinks([p,a,b,a2])` 得到 `[b,a2]` | 通过 |
| 新建合流 m，令 b 的 contextOrder=1、a=2，祖先顺序为 `[book,p,b,a,m]` | 通过 |

这些结果只证明图工具在上述输入上的行为。完整构建、可视交互、流式 UI、真实 CLI、DSH 版本兼容、权限事件、重启恢复、真实 EPUB 和学习效果均未验证。没有执行上游 `dsh/scripts/verify-write-bridge.mjs`，该脚本针对已有会话且会发起真实模型请求，不属于这次源码研究的测试范围。

## 6. 许可与 Git 来源管理

根目录许可为 MIT，版权人为 Xia Chen；DSH 子包也标明 MIT。实际迁入代码时需保留适用的版权和许可文本，并记录上游仓库、固定提交、原文件路径与本地修改。依赖库按各自许可证处理。[上游许可][license]

本次仅提交研究文档及索引更新，没有把上游源码或临时克隆提交到 MomentRead。后续若开始模块提取，应将第三方源码引入与 MomentRead 适配分别提交，便于回退、追踪和对比更新。

[ask]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/store/slices/llm.ts#L16-L128
[graph]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/graph.ts
[context]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/store/context-builder.ts
[types]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/types.ts#L159-L243
[layout]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/layout.ts
[recap]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/recap.ts
[condense]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/condense.ts
[memory]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/memory.ts
[export]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/export.ts
[poster]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/poster.ts
[runtime]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/runtime/agents/README.md
[claude]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/runtime/agents/claude.cjs#L102-L159
[http]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/runtime/agents/http.cjs
[http-client]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/agents/http-bridge.ts
[agent-client]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/agents/agent-runtime.ts#L143-L177
[persistence]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/src/lib/persistence.ts
[dsh-code]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/dsh/lib/index.js#L668-L758
[dsh-readme]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/dsh/README.md
[dsh-package]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/dsh/package.json
[license]: https://github.com/chenxiachan/thoughtdag/blob/3d63111dba182ece5d3c4c583ab1ac120d5276be/LICENSE
