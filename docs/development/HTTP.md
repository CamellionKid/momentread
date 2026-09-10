# HTTP v1（提供方与调用方共同使用）

请求JSON，文件使用multipart字段file。响应对象直接返回，不套data；错误 {error:{code,message,retryable},requestId}。服务监听127.0.0.1:4317；开发UI5173代理/api。API client由主Agent维护。

| 方法/路径 | 输入 | 输出 |
|---|---|---|
| GET /api/health | 无 | {status,version} |
| GET /api/runtime | 无 | RuntimeProbe |
| GET /api/books | 无 | Book[] |
| POST /api/books | multipart file | Book |
| PATCH /api/books/:id | title?,author?,language?,translator?,edition?,identifier? | Book（用户补录资料；不修改EPUB文件） |
| GET /api/books/:id/state | 无 | {book,workspace,discussions,messages,summaries,receipts,sources,concepts,runs,activities} |
| PATCH /api/books/:id/workspace | position?,activeDiscussionId?,collapsed?,fontSize? | Workspace |
| GET /api/files/:id | 无 | 受控文件字节 |
| POST /api/books/:id/originals | multipart file | FileVersion |
| POST /api/analyses | AnalysisRequest | {discussionId,runId}（自动匹配后接解析） |
| POST /api/branches | BranchRequest | {discussionId,runId} |
| PATCH /api/discussions/:id | {draft?,scrollTop?} | Discussion |
| POST /api/discussions/:id/messages | {text} | {runId} |
| POST /api/discussions/:id/summary | 无 | {runId} |
| POST /api/summaries/:id/confirm | ConfirmRequest | {summary,parentId} |
| GET /api/discussions/:id/history | 无 | SummaryVersion[] |
| POST /api/discussions/:id/matching | 无 | {runId} |
| PATCH /api/sources/:id | {selected?,verification?} | SourceCandidate |
| GET /api/runs/:id | 无 | Run |
| GET /api/runs/:id/events | Last-Event-ID或?after=seq | SSE RunEvent |
| POST /api/runs/:id/cancel | 无 | {ok:true} |
| POST /api/runs/:id/permission | {requestId,decision:allowOnce或deny} | {ok:true} |
| GET /api/books/:id/report?date=YYYY-MM-DD&timezone=Asia/Shanghai | 无 | {book,date,timezone,activities,discussions,summaries,concepts,sources,advice} |
| POST /api/books/:id/report?date=YYYY-MM-DD&timezone=Asia/Shanghai | 无 | {runId}（202；可重复生成，GET 取同日期时区最新成功结果，历史运行保留） |
| GET /api/books/:id/report.html?date=...&timezone=... | 无 | 独立HTML下载 |
| POST /api/backups | 无 | {id} |
| GET /api/backups/:id | 无 | ZIP下载 |
| POST /api/restore | multipart file | {ok:true}（仅空书库） |

初次解析自动匹配与回答为两个顺序运行，前者失败也进入明确标注未对照原文的中文解析。界面根据state.runs显示阶段，不能因为第一个run终结就判全文解析完成。仅明确用户发起解析触发此链；恢复页面不自动重发。
