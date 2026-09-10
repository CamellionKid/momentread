# 开发契约 v1

生产入口在仓库根目录，prototype 保持视觉参考。公共 schema 在 shared/contracts/index.ts，模块端口在 ports.ts。总负责人维护契约、公共配置、HTTP 路由和 API client；模块不能自行修改公共契约。

Store 为 SQLite 持久化的具名实体集合，所有 put 使用对应 Zod schema 校验。领域关系由 learning 服务在 transaction 内校验；书籍文件版本不可变。结构化集合允许 JSON 列但必须索引 kind/id/bookId；运行事件按 runId/seq 唯一存储、持久化后再传输。confirmed summary 为不可变版本，不能覆盖旧正文。幂等键持久化，不因进程重启丢失。

Reader 为 forwardRef React 组件，导出 EpubReader，实现 ReaderProps/ReaderHandle。读取 /api/files/:id；只通过事件返回来源和位置。禁止用文字 includes 代替 CFI，来源绑定精确文件版本。

AI 导出 createClaudeAdapter(options?)，实现 ClaudeAdapter。事件 envelope 均携带 runId/bookId/discussionId/seq；适配器只负责 CLI 和协议，产品运行管理及写库由总负责人处理。讨论和整理禁用工具；matching 只允许 WebSearch/WebFetch（正常权限、不 bypass）。取消先正常中断，强停会话不得接续。不得读取用户其他会话。

生产 HTTP 统一 /api，错误 {error:{code,message,retryable},requestId}。启动运行返回 {runId}；SSE id 为 seq，支持 Last-Event-ID，重连不新建运行。实体查询返回对象，列表返回数组。后续路由说明与 OpenAPI 由同一 schema 生成。

## 运行事件数据示例

每个事件均有 runId/bookId/discussionId/seq/type/data/createdAt；SSE事件名固定为run。

- initialized：`data={cliSessionId:"...",runtimeVersion:"...",capabilities:[]}`。
- text_delta：`data={text:"新增文字"}`，不是整段替换。
- permission_required：`data={requestId:"...",toolName:"WebSearch",input:{query:"..."},description:"..."}`。
- permission_resolved：`data={requestId:"...",decision:"allowOnce"}`。
- retrying：`data={attempt:1,delayMs:1000,category:"..."}`。
- completed：`data={text:"完整最终文字",structuredOutput:可选JSON,sessionReusable:true,toolResults:可选数组}`。discussion/daily消费text；summary消费严格`{content:string}`；matching消费严格`{candidates:[{url,title,language,version,quote,locator,reason}]}`。toolResults中的失败不能当作检索成功。
- cancelled：`data={partialText:"...",sessionReusable:false}`；保留已有片段，不再追加。
- failed：`data={code:"...",message:"可展示原因",partialText:"...",sessionReusable:false}`。

少了最终结果、结构不符、只有stdout/退出码零，都不能标完成。summary不接受任意自然语言回退成有效结构化小结。事件终态只有一次；产品端持久化事件后再发到浏览器。
