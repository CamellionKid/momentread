# 学习、分支与小结服务

模块：`server/learning/index.ts`。导出 `createLearningService(store): LearningService`，实现既定 `shared/contracts/ports.ts`；没有额外 HTTP 端点或自建 AI harness。所有领域写入通过 SQLite Store 的同步事务完成。

## 接入顺序

- `createRoot`：校验书籍和当前不可变文件版本、文件角色、选段范围结构；同时创建段落讨论及最初 user 问题。返回 rootId 等于自身 ID 的讨论。API 不要再次保存同一个初始问题。
- `createBranch`：校验父路径、原消息归属、完整生成状态、UTF-16 起止范围与 exact 严格一致。创建独立节点及最初 user 问题，同名分支也保留不同 ID。
- 开始普通运行前调用 `buildInput(id, 'discussion')`；追问先 `appendUser`，再构建输入。讨论生成成功或中断后用 `appendAssistant` 保存完整/部分结果，必须传入已存在、同书同讨论且用途为 discussion 的 runId。相同 runId 的相同终态可重试；不同内容不能覆盖。
- 整理使用独立 `buildInput(id, 'summary')`，运行结果传入 `createSummaryDraft(contextId, content)`；不要把整理结果追加为普通 assistant 消息，否则该草稿对应的讨论 revision 会过期。
- 用户编辑后的正文与 UUID requestId 传给 `confirmSummary`。只有确认成功才根据返回的 parentId 导航；根讨论返回 null。
- `updateDiscussion` 持久化独立草稿和滚动位置。草稿/滚动更新不增加语义 revision；追加消息、确认小结及接收直接子小结增加 revision。

## 背景与隔离

ContextSnapshot 的 input 是包含固定任务说明与结构化数据的 JSON 字符串，记录书籍元数据、原始选文、冻结祖先、当前讨论、已确认子小结、相关书内概念及来源。

分支创建时保存截至所选父消息的祖先背景。分支首个 ContextSnapshot 通过持久化的 `learning:baseline:<discussionId>` 元数据键关联，无需修改公共 Discussion 类型。重新启动仍从同一快照恢复，后来父讨论的消息不会进入该背景；无法找到快照时明确报错，不临时拼装新背景。

当前讨论只包含自己的消息。直接子讨论通过已确认 Receipt 提供小结，不传递子讨论全文；兄弟未确认内容从不进入背景。已经确认且与当前术语相关的书内概念作为明确的概念记录加入，附义项语境及来源；同名概念不合并。关联范围包括最新 user 追问；API 未额外传 question 时也能找回用户后续提到的已确认义项。最多取 12 个相关概念，单次序列化背景超过 160000 字符时明确拒绝，要求用户整理并选取相关概念继续，不静默截断。

原段落只包含用户选区及每段前后最多 160 字，不读取或发送整书。选段总计最多 80000 字符/100 段。仅 `retrieval=retrieved` 的来源向模型提供 quote，失败来源仅提供状态和定位信息。来源选中不等于核实，指令要求区分原著证据、解释和推测。每次持久化快照都要求区分“中文选段”与“外文原句”：没有实际取回的外文证据时，回答须明确写“尚未核对外文原著”，中文内容只能称“中文选段依据”。有取回的外文候选时保留原句、版本与出处及核对状态，不强制丢弃可用引文，也不能把未核实的候选说成已确认对应。相关概念的外文来源不会单独使当前段落被误判为已有外文依据。

普通讨论携带相关已确认概念时，快照允许模型在完成当前解释后自然提出至多一个明确“可跳过”的回顾问题；不阻断后续阅读、不评分或推断掌握、不要求每轮提问。用户表示跳过或直接继续时本轮不再提问。整理任务不插入回顾问题。这是持久化的生成约束，模型是否实际遵循仍须真实 AI 验证。

ContextSnapshot 固定 messageIds、discussionRevision、summaryDependencies 和 sourceIds。冻结祖先的小结作为历史背景，不成为可变依赖；当前子回馈及纳入的相关概念是确认时必须检查的依赖。

## 小结事务与历史

草稿 version 为 0，并保留生成时的 revision、依赖和来源。确认时在同一事务内：

1. 读取全局 requestId 幂等记录；同 ID、同 summaryId 与正文返回原结果，同 ID 不同内容返回冲突。
2. 拒绝已确认草稿、过期讨论 revision、已更新的子小结或概念依赖，以及尚未合并的新子回馈。
3. 以当前讨论最大已确认版本 + 1 保存确认正文；已确认历史由存储层禁止修改或删除。
4. 更新当前讨论 revision 并清除 needsMerge。
5. 若有直接父讨论，仅新增/更新这一 parent-child Receipt；增加父 revision。父已有确认小结时置 needsMerge，不修改旧小结，也不跨越父级向根回馈。
6. 概念子讨论生成独立 ConceptSense，保留其选词语境和根选文定位。根段落小结进入成果但不伪装成名为“段落解析”的术语。原语术语未得到结构化确认时 originalTerm 留空。
7. 保存幂等结果。任意一步失败则回滚版本、Receipt、概念、revision 及幂等记录；编辑内容仍在未确认草稿中。

再次整理会生成新的草稿，确认产生新版本；每个概念版本保留单独 ConceptSense 历史。展示当前概念时可按 discussionId 取最新 confirmed summary，不能按名称去重。来源模块改变证据或核对结论时，应提升受影响讨论 revision，使已生成的小结预览重新核对。

## 定位校验边界

服务拒绝非 range CFI、格式中被 foliate 解析器忽略的杂字、未闭合断言、无效数值、逆序或空范围、另一书籍/文件版本。每段仍保留 spineId 和 exact；不以文字搜索代替 CFI。

既定 `createLearningService(store)` 不接收 BookLibrary/文件访问端口，因此这里不读取 EPUB 二进制，不宣称已验证 CFI 对应 DOM 的语义或选文真实性。实际 DOM、spine 与 exact 的往返核对由阅读适配器完成，文件导入与身份由书库完成。若将来允许第三方客户端直接提交选区，应在服务入口增加受控文件读取和服务器端 CFI/文本验证，不能仅依赖当前语法校验。

## 验证范围

```sh
npm test -- tests/unit/learning.test.ts tests/integration/learning-scale.test.ts
```

当前 22 项测试使用真实 SQLite 和合成数据，覆盖：跨书/错版本/错误范围、消息归属、防环、祖先截止和重启恢复、兄弟隔离、独立草稿、同运行回复去重、失败来源引用抑制、逐层回馈、根小结、过期预览、重复确认、确认版本历史、两个预览竞争、父 needsMerge、依赖变化、事务故障回滚、同名义项隔离，以及 500 节点/20 层路径的保存与恢复。另覆盖中文/失败来源的外文披露、真实取回候选引用保留、后续追问关联已确认概念、可跳过回顾规则和未确认兄弟隔离。

这些证据不等于模型解释质量或浏览器端可用性；真实 EPUB→选择→AI→编辑确认→重启的系统与盲测由集成负责人执行。
