# EPUB 阅读适配器

状态：模块已实现；生产界面浏览器联合验收由总负责人记录。单元／真实格式解析测试不等于真实渲染验收。

## 固定依赖与边界

- foliate-js 固定为 `78914aef4466eb960965702401634c2cb348e9b1`，最小代码闭包与 MIT 许可存于 `vendor/foliate-js`，本地改动详见同目录 `README.momentread.md`。
- 使用 `epub.js` 解析真实元数据、目录和 spine；使用 `paginator.js` 渲染可重排正文；使用 `epubcfi.js` 编解码 DOM 定位。压缩包通过固定的 `fflate` 解压。
- 书籍二进制仅从应用同源受控文件 URL 加载；不直接读取磁盘、创建讨论、发送 AI 请求或写入数据库。
- 导出 `src/reader/EpubReader.tsx` 的 `forwardRef` 组件，遵循 `shared/contracts/ports.ts` 的 `ReaderProps`／`ReaderHandle`。

## 输出和导航

`onReady` 在书籍解析及首章／恢复位置完成后发出。`onRelocate` 输出与文件版本绑定的 CFI、章节和进度；用户字号变化时仍以同一结构位置定位，进度按 spine 文件字节权重计算，不使用屏幕页数。

鼠标或触摸选区完成、键盘扩选完成时，`onSelection` 输出 `TextReference`；应用显示确认解析入口。适配器不自动调用 AI。单个 range CFI 同时包含起止边界，完整保存跨段选文及前后各最多 160 字。多个原生 Selection ranges 分别形成 segments。元素边界选区先规范为等价文本边界，避免上游 CFI 编码丢失 child offset；严格比较规范前后的选文，不能静默裁剪。

`navigateToReference` 先验证书籍 ID、文件版本、全部 segments 的章节和精确文本，再定位第一段。多段引用显示逐段定位控件；不是仅处理第一段。遇到文件或引用不一致报错，不使用模糊字符串搜索冒充原始定位。`restorePosition` 验证文件版本后使用 CFI。所有定位方法在 `onReady` 后调用；加载中直接定位会返回明确错误。

目录、上一／下一章节、上一／下一页均内建在阅读区域。正文使用章节内滚动；章节边缘可通过翻页控件接续。PageUp／PageDown 支持键盘翻页。目录支持 Escape 关闭并恢复焦点。

## 脚本及外部资源隔离

1. ZIP 原件不改写。HTML／SVG 在交给 foliate 前做运行时清洗，资源改写成 blob URL 后再清洗一次；CSS 去除远程 URL 与 imports。
2. 去除 script、事件属性、iframe、表单、活动 SVG、媒体、自动导航和可执行链接；foliate 的 resource load 事件也拒绝脚本。
3. 每个正文文档注入独立 CSP：`script-src 'none'`、`connect-src 'none'`、`default-src 'none'`，只允许本地 blob 与受限 data 图片／字体及本地样式。
4. iframe sandbox 仅 `allow-same-origin`，不授予 `allow-scripts`。书内外链不会自动打开或抓取。

禁止把 EPUB 脚本存在误报为“已运行”。只读检查用户指定的实测书确认存在脚本标签；测试验证净化后的章节不含脚本，不会修改原书。

## 支持范围

- 首版：桌面 Chromium、可重排 EPUB、章节目录、单章节跨段选区、多个离散引用、重复句结构定位、字号与 CFI 恢复。
- 每次拖选只在一个章节文档内完成；界面常驻提示“跨章节请分次选取”。不支持浏览器单次跨 iframe／章节拖选，也不静默拼接或截断。
- 固定版式 EPUB 明确报不支持；DRM 无法保证可读；不支持 EPUB 脚本、媒体播放、外部字体或资源自动加载。
- EPUB 压缩文件上限 150 MB，解压总量上限 350 MB，条目上限 10000。超限明确停止，ZIP 文件仍保留在书库。
- Safari 的旧 WebKit 事件兼容性不作未经验证的承诺；本适配器不会为了事件兼容而放开脚本。
- 大图／图片型章节可浏览但没有可提取文字；不会以 OCR 或演示正文替代。

## 验证

```sh
npm test -- tests/unit/reader.test.ts tests/unit/reader-epub.test.ts
```

默认测试使用程序生成的合成 EPUB，不提交第三方书籍内容。覆盖 ZIP → foliate 目录及章节解析、跨段和元素边界 range CFI、重复句定位、字号变化后的结构定位、版本拒绝、进度、脚本／SVG／远程 CSS 隔离。

用户指定的 EPUB 可单独启用完整章节遍历及 CFI 往返测试：

```sh
MOMENTREAD_TEST_EPUB='/absolute/path/to/authorized-book.epub' npm test -- tests/unit/reader.test.ts tests/unit/reader-epub.test.ts
```

测试只读该文件，断言仅输出布尔值与结构信息，不输出或保存书籍原文。2026-09-10 已使用用户指定实测书执行此命令：34 个 spine；章节级跨段 CFI 往返验证通过。发现并修复了 foliate 对元素边界 child offset 的编码问题，并增加了固定回归用例。

需由集成浏览器实测继续确认：真实选区→应用解析入口、正文可滚动、目录导航、字号及刷新／服务重启恢复、引用回跳、iframe 无脚本或外部资源执行。测试报告应清楚区分这些证据层级。

## 浏览器回归补充（2026-09-10）

独立 Chrome 会话已实际打开生产服务上的用户实测书：首章封面、真实目录、第一章正文成功显示；用真实鼠标拖选 25 字，应用出现正确的“解析一下”入口。该过程只验证阅读与选区接线，没有调用 AI，未把实书截图或原文存入仓库。

发现该书每章内联 CSS 为正文类单独指定黑体，导致 body 字体不能覆盖。现在正文后代继承阅读字体，普通段落恢复正常字重，标题和 strong/b 仍保留层级。新增独立合成 EPUB 浏览器回归页：

```sh
npm run dev:ui
# 浏览器打开 http://127.0.0.1:5173/tests/reader-harness.html
```

该页只使用内存合成 EPUB，不访问书库、数据库或 AI。已实际验证：跨两段鼠标选区 → 切第二章 → 字号从 24 改为 36 → 按原始 range CFI 回跳并高亮完整选区；之后跨章恢复保存位置成功。脚本探针仍为 `SCRIPT_BLOCKED`，浏览器 warn/error 为零。合成书证据图：`tests/evidence/reader-cross-paragraph-cfi.png`。

Codex 内置浏览器在总负责人会话中出现章节载入挂起；此适配器不把该环境标为通过，也不会放宽 iframe 的脚本隔离。新增 15 秒章节加载超时，返回可重试提示及使用 Chrome 的建议；计时器收尾和失败传播有单元测试。正式首版验收仍以 Chrome 为目标。
