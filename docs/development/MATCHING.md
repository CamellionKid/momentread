# 原著候选、独立取回与核对

本模块位于 `server/matching`。公开检索仍由 Claude Code 独立运行负责；本模块不新增模型接口，也没有启用搜索引擎 fallback。

## 接入

- `createMatchingService(store, library)` 返回契约中的 `MatchingService`。
- `buildInput(discussionId)` 保存并返回 `ContextSnapshot`。根阅读选段合计最多 8,000 字符；超过时显式标记 `selectionTruncated`。不传递整段聊天或兄弟讨论。
- `MATCHING_OUTPUT_SCHEMA` 可直接传给 Claude adapter 的 `outputSchema`。模型必须返回严格对象 `{"candidates":[{"url","title","language","version","quote","locator","reason"}]}`，最多 8 项；不接受 Markdown 包裹、额外键或空白引句。
- `complete(discussionId, result)` 同时接受直接 JSON 对象／JSON 字符串，以及运行层的 `{result, toolResults}` 信封。每条候选独立取回验证后写入存储。
- `updateSource(id, {selected, verification})` 选中不等于确认。尚未取回引句的记录不能选用或确认。变更会标记实际依赖来源的讨论与祖先 `needsMerge`，历史小结不改写。
- `originalAdded(bookId, fileVersionId)` 必须在原著导入成功后调用。旧来源保留引句和证据指纹，改为待重新核对的 `conflict`；依赖讨论收到更新提示。再次匹配产生新来源记录。

模型给出的 `title`、`version`、对应关系和 `reason` 均不是核实结果。即使引句逐字存在，也只证明该网页包含该引句，不能证明它就是当前中文译本的底本。`verification` 初始始终为 `unverified`。

## 状态与故障

| 情况 | 存储状态 | 运行结果 |
|---|---|---|
| 正文实际取回，引句经 NFC 与空白规范化后逐字存在 | `retrieved / unverified`；保存引句、最终 URL、正文 SHA-256 | 正常完成，等待用户核对 |
| 正文已取回，但引句不在此版本 | `unavailable / conflict`；引句与证据指纹为空 | 展示错误候选，不能选用 |
| HTTP、DNS、超时、格式或体积失败 | `fetch_failed / unverified`；引句为空 | 展示取回失败 |
| 检索返回空数组 | 保存一条 `unavailable` 状态记录 | 明确“没有可核对候选”，不推断原著不存在 |
| 运行层报告工具失败，且没有实际取回的引句 | 保留失败来源；空结果建立 `fetch_failed` 状态记录 | 抛 `MATCHING_TOOLS_UNAVAILABLE`；解析链可转为明确未对照原著的中文解析 |
| JSON 结构无效 | 不保存为原著证据 | 抛 `MATCHING_RESULT_INVALID` |

重复候选在同一结果内去重；重复匹配不会覆盖上一轮来源记录。错误候选的文字不进入 `quote`，因此不会在页面中冒充原著引句。被阻断的不安全 URL 不作为可点击来源保留。

## 取回边界

- 只允许公开 HTTP(S)，无 URL 凭据，端口只接受默认端口／80／443。
- 每次跳转重新解析并验证全部 DNS 地址；每一跳连接固定到通过检查的地址，避免检查与连接之间再次解析。拒绝 HTTPS 降级。
- 私网、回环、链路本地、保留地址、IPv4 映射和非全球 IPv6 地址均拒绝。
- 单个来源整体期限 15 秒，最多 4 次跳转、2 MB；只接受 HTML、XHTML 或纯文本。拒绝压缩传输、非文本和无法可靠解码的文本。
- HTML 作为惰性字符串处理，移除脚本、样式等非正文标签；不启动浏览器，不执行脚本，不携带用户 Cookie、登录状态或代理凭据。
- 本机已观察到系统 DNS 使用 `198.18.0.0/15` fake-IP。仅当**域名的全部系统地址**均属于此范围，才使用固定 Cloudflare DoH 端点取得真实 IPv4。DoH 固定连接 `1.1.1.1`，TLS 名称为 `cloudflare-dns.com`，候选无法替换解析器；返回地址仍须通过公网检查。literal fake-IP、10/127/192.168 等其他私网地址绝不触发补救。未修改系统或代理配置。

## 用户补充原著

TXT／EPUB 由书库服务复制保存。匹配层只通过 `library.filePath(fileVersionId)` 访问当前书籍的原著版本，并验证文件 SHA-256。EPUB 使用已校验的 ZIP 读取器，章节 HTML 不执行。

提供给模型的是最多 5 个、每个 2,200 字符的原著窗口，地址为受控的 `momentread-original://文件版本/章节`；最终引句必须能在该版本对应章节中逐字找到。不会发送本地磁盘路径。窗口按选段／讨论中的词语匹配优先选择；中外文词汇不重合时会退回章节起始片段，因此不能保证从任意整本外语原著中自动定位对应段落。此限制应在使用说明中保留。

## 验证记录

自动测试：

```sh
npm test -- tests/unit/matching.test.ts tests/unit/matching-network.test.ts tests/integration/matching-service.test.ts
npm run typecheck
```

2026-09-10：66 项匹配单元／集成测试通过，类型检查通过。覆盖真实 SQLite 保存、本地 TXT／EPUB 版本、跨书拒绝、引句不匹配、无结果、HTTP 403 等失败、工具失败信封、幂等式候选去重、上下文长度、脚本去除、DNS pin、SSRF、重定向、DoH 补救、限体积和超时。测试内容为公开短句或合成文本，不包含用户《虚无主义》原文。

真实网络取回使用生产 `fetchPublicDocument`，不是 WebFetch 摘要。初次取回因 fake-IP 正确阻断；固定 DoH 补救后，以下三项均实际取回且短引句逐字匹配。版本对应性仍未自动确认。

| 语言／实际页面 | 取回字符数 | 耗时 | 规范化正文 SHA-256 |
|---|---:|---:|---|
| [德语，Kant 1781 / Einleitung](https://de.wikisource.org/wiki/Critik_der_reinen_Vernunft_(1781)/Einleitung) | 22,864 | 2,593 ms | `99fb99677db867ddaf9e034198e47aea8f5b1b65f2870f1e01c25c405c5ff7f5` |
| [英语，Meiklejohn / Introduction](https://en.wikisource.org/wiki/Critique_of_Pure_Reason_(Meiklejohn)/Introduction) | 43,126 | 1,748 ms | `4ce22562e72f3acc46e9c828f83bf7e69963ad867bc58c5fbcdf5c4d828f50d9` |
| [拉丁语，Descartes 1685 / Meditatio II](https://la.wikisource.org/wiki/Meditationes_de_prima_philosophia_(1685)/Meditatio_II) | 17,127 | 2,168 ms | `67819ebc8739f5300158e143aa2c3906acd098507ec17cd9bb75024afd8f46f3` |

以上仅证明候选的独立取回与字面核对能力，不代表 Claude 搜索工具可用，也不代表《虚无主义》原著匹配成功。

## 无 key 搜索的只读可行性探测

2026-09-10，未将以下途径接入生产：

| 途径 | 实测结果 | 判断 |
|---|---|---|
| DuckDuckGo HTML | HTTP 202，出现 CAPTCHA／anomaly 标记 | 不可用，不规避验证码 |
| Bing 公开搜索页 | HTTP 200，取得结果 HTML，未出现明显 CAPTCHA | 当前可读取，但没有稳定结构化 API；需单独产品决定 |
| Gutenberg 搜索页 | HTTP 200，页面明确提示不要抓取 | 不用此搜索页作为生产抓取接口 |
| Wikisource en／de MediaWiki Search API | HTTP 200，结构化查询命中，无 API key | 可用于公共文本库检索，覆盖有限；不是全网搜索 |

接口示例：[英文文本库查询](https://en.wikisource.org/w/api.php?action=query&list=search&srsearch=Critique%20Pure%20Reason&format=json)、[德文文本库查询](https://de.wikisource.org/w/api.php?action=query&list=search&srsearch=Kritik%20reinen%20Vernunft&format=json)。启用替代检索应由总负责人确认，不静默改变来源策略。

### 追加验证：候选发现是否真正相关

2026-09-10 09:56 UTC，增加三类真实查询，每类检查前 5 个候选；Bing 另用 `mkt=en-US&cc=US&setlang=en` 及更具体的查询复查一次。仅返回 HTTP 200 不作为可用判据。

| 目标 | Bing RSS 首轮／复查 | Wikisource API |
|---|---|---|
| `"Nolen Gertz" "Nihilism"` | 首轮返回 Google Translate 帮助；加 MIT Press 和固定地域后返回 Personio 登录／HR 产品 | en 站点 0 命中；不能从此文本库提供现代原著候选 |
| `Kant "Kritik der reinen Vernunft"` | 首轮多为 Kant 人物百科或介绍；加 Originaltext 和固定地域后返回 Gmail／BT 帮助 | de 站点首项为 `Critik der reinen Vernunft (1781)`，其后混有人物与评论材料 |
| `Augustinus Confessiones` | 首轮返回 easyJet；加 Latin text 和固定地域后返回德文应急清单 | la 站点返回 `Confessiones (ed. Migne)` 的导言和章节，具有实际版本指向 |

Bing 复查的 RSS channel title 正确回显请求的查询字符串，但 items 与查询无关。当前环境下结果语义不可靠；不将它列为可上线的候选发现方式，也不推测服务端／网络造成这一现象的具体原因。没有遇到验证码后继续重试，没有绕过 CAPTCHA。

对 Wiki 实际命中 URL，进一步调用生产 `fetchPublicDocument` 读回：

- [Kant 1781 版](https://de.wikisource.org/wiki/Critik_der_reinen_Vernunft_%281781%29)：实际取回 10,810 个规范化字符，书名、作者、1781 标识都存在。此页为版本入口，匹配具体选段仍需继续到章节。
- [Augustine，Migne 版第二卷](https://la.wikisource.org/wiki/Confessiones_%28ed._Migne%29/2)：实际取回 20,836 个规范化字符，`Aurelius Augustinus`、`LIBER SECUNDUS`、`Migne` 均存在；结果是实际拉丁文章节，不是空模板或错误地域结果。

可迁移方案仅建议**固定语言站点的 MediaWiki Search API → 书名／作者／版本筛选 → 章节候选 → 独立正文取回 → 引句逐字核对**。搜索 snippet 仅帮助发现，不充当原文证据。人物条目、评论、版本入口与正文必须区分；API 的排序不能直接当作语义匹配置信度。对于 Nolen Gertz 这类现代书籍，这条路径已有明确覆盖缺口，不能作为全网原著检索的替代承诺。

探测 JSON 在本机忽略目录 `tmp/matching-search-probe/`：`discovery.json`、`bing-followup.json`、`candidate-readback.json`。证据只含公开查询与返回信息，未上传或写入用户书籍内容。本轮未改变产品接口、未启用 fallback。
