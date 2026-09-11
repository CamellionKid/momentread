# 浏览器规模、布局与来源状态验收

2026-09-11：**最终构建的 21 项规模／布局检查与 4 项来源状态检查通过，0 产品失败。** TypeScript 检查通过。这是知晓公开契约与合成输入的浏览器验收，不是盲测。

## 环境与证据范围

- 浏览器：Playwright 启动的可见 Google Chrome `152.0.7977.83`，使用独立临时 profile；未连接用户原生 Chrome profile，未更改浏览器权限。
- 服务：`http://127.0.0.1:4325`，独立合成 SQLite／EPUB 数据目录。没有操作 root 的 4317 服务。
- 前端：复制 2026-09-11 最终候选 `dist/client` 到临时 candidate，再以只读副本提供页面；测试没有并发修改共享 dist。该构建包含 Markdown 呈现、元数据、失败提示和重试状态。
- 样本：1 个根讨论、24 个分支各含 19 个子讨论，以及独立的 19 层深分支，共 **500 个讨论**；根到最深节点共 **20 级**。全部由公开 Store／BookLibrary／LearningService 创建。
- 消息与运行：程序保存明确标记为「合成记录、模型未运行」的消息和 Run；没有执行 500 次 CLI，也没有调用一次真实 Claude。编辑小结对话框由测试专用 adapter 返回合成内容。
- EPUB：两个章节、重复合成句；没有读取、上传或提交用户书籍原文。
- 时间：规模检查 `18:35:10–18:35:18`（Asia/Shanghai）；来源状态随后完成。三尺寸各项为独立功能断言，不是图片相似度测试。

原始结果及前端资源 SHA-256：

- [规模结果 JSON](../../tests/browser/artifacts/2026-09-11-permission-final/results.json)
- [来源状态结果 JSON](../../tests/browser/artifacts/2026-09-11-permission-final/source-results.json)
- [构建与环境清单](../../tests/browser/artifacts/2026-09-11-permission-final/artifact-manifest.json)
- [合成数据清单](../../tests/browser/artifacts/2026-09-11-permission-final/seed-manifest.json)

## 三尺寸结果

| 检查 | 1487×1058 | 1280×720 | 390×844 |
|---|---|---|---|
| 页面宽高不溢出，输入和主要面板在视口内 | 通过 | 通过 | 通过；正文／AI 标签切换 |
| 500 节点保留尺寸并独立滚动 | 通过 | 通过 | 通过 |
| 完整祖先对话框有 20 项，顺序正确，最后一项可滚动到达 | 通过 | 通过 | 通过 |
| 折叠其他分支保留活动路径 | 500 → 44 | 500 → 44 | 500 → 44 |
| 展开恢复全部节点，无数据丢失 | 44 → 500 | 44 → 500 | 44 → 500 |
| 兄弟切换保留各自草稿，再返回最深节点 | 通过 | 通过 | 通过 |
| 长讨论独立滚动，Markdown 标题／表格／代码块存在且局部滚动 | 通过 | 通过 | 通过 |
| 可编辑小结对话框及操作可到达 | 通过 | 通过 | 通过 |

线路图画布为 **1275×48550 CSS px**，三个尺寸的节点点击区域均为 **42×42 px**；没有把 500 节点整体缩小塞进视口。线路图在窄栏中水平／垂直滚动。三个页面均无全页横向或纵向溢出，未产生 pageerror 或 HTTP(S) 外部请求。

每个尺寸的兄弟往返检查包含输入、等待持久化、切换两次及返回深层节点，整组耗时分别为 **773、1056、810 ms**。它们是本机一次合成样本的观测值，不是正式性能 SLA 或负载测试结论。

超长讨论标题使用自身滚动区域，完整名称也可在祖先对话框读取。390 px 窗口下 AI 面板宽 308 px、线路栏宽 82 px，功能可达但空间紧；本次不据此承诺手机长时间阅读体验。

## 截图

| 尺寸 | 主界面 | 完整路径 | 折叠后 | 小结编辑 |
|---|---|---|---|---|
| 1487×1058 | [讨论](../../tests/browser/artifacts/2026-09-11-permission-final/1487x1058-discussion.png) | [路径](../../tests/browser/artifacts/2026-09-11-permission-final/1487x1058-path-dialog.png) | [折叠](../../tests/browser/artifacts/2026-09-11-permission-final/1487x1058-folded.png) | [编辑](../../tests/browser/artifacts/2026-09-11-permission-final/1487x1058-summary-dialog.png) |
| 1280×720 | [讨论](../../tests/browser/artifacts/2026-09-11-permission-final/1280x720-discussion.png) | [路径](../../tests/browser/artifacts/2026-09-11-permission-final/1280x720-path-dialog.png) | [折叠](../../tests/browser/artifacts/2026-09-11-permission-final/1280x720-folded.png) | [编辑](../../tests/browser/artifacts/2026-09-11-permission-final/1280x720-summary-dialog.png) |
| 390×844 | [讨论](../../tests/browser/artifacts/2026-09-11-permission-final/390x844-discussion.png)、[正文](../../tests/browser/artifacts/2026-09-11-permission-final/390x844-reading.png) | [路径](../../tests/browser/artifacts/2026-09-11-permission-final/390x844-path-dialog.png) | [折叠](../../tests/browser/artifacts/2026-09-11-permission-final/390x844-folded.png) | [编辑](../../tests/browser/artifacts/2026-09-11-permission-final/390x844-summary-dialog.png) |

## 合成来源候选检查

此项只验证 UI 状态和明确操作边界。候选 A 的 `retrieved` 是预置测试状态，**不代表实际取回过任何原著**；候选标题、版本、原因和引文均明确标记合成。候选 B 为 `unavailable`，不含可引用文本。

1. A 初始为 unverified／未选择，显示「待核对」。B 显示「未取回」「没有可引用的原著文本」，选择与确认按钮均 disabled。
2. 实际点击 A 的「选作候选」后，保存状态为 `selected=true, verification=unverified`，卡片仍显示「待核对」。
3. 再次明确点击「我已对照确认」，才变为 `verification=confirmed`。B 仍未选择、未确认。
4. 浏览器实际发出的两次独立 PATCH 分别为 `{selected:true}` 与 `{verification:'confirmed',selected:true}`。确认动作可同时保留选择状态；它不是第一次选择动作的隐含效果。

截图：[未选择](../../tests/browser/artifacts/2026-09-11-permission-final/sources-unselected.png)、[已选但待核对](../../tests/browser/artifacts/2026-09-11-permission-final/sources-selected-still-unverified.png)、[明确确认后](../../tests/browser/artifacts/2026-09-11-permission-final/sources-explicitly-confirmed.png)。

没有点击外部来源链接或触发重新检索；`example.invalid` 仅用于合成候选的可识别占位地址。

另在同一独立合成服务检查默认报告日期：省略 date、指定 `Pacific/Kiritimati` 时，该时区日期为 **2026-09-11**；GET report 返回相同日期。此项为额外 API 回归，不计入前述 21 项浏览器检查。[结果](../../tests/browser/artifacts/2026-09-11-permission-final/default-report-date.json)

## 复现入口

所有脚本只在 `tests/browser/`，不修改产品代码：

- `run-scale.ts`：统一入口，使用仓库 Playwright 依赖。创建全新数据、复制已完成的前端构建、记录 SHA-256、启动独立服务、顺序执行以下三项，再关闭自己启动的服务；不运行 build，不覆盖已有证据目录。
- `seed-scale.ts`：通过公开模块生成独立数据目录；输出 manifest。
- `scale-server.ts <dataDir> <port>`：启动仅使用合成 adapter 的 HTTP 服务。拒绝使用 4317。工作目录中的 `dist/client` 应为已完成构建的独立副本。
- `scale-layout.cjs`：三尺寸真实 Chrome 检查；用 `MOMENTREAD_SCALE_URL`、`MOMENTREAD_SCALE_MANIFEST`、`MOMENTREAD_SCALE_OUTPUT` 指定服务、数据清单和结果目录。
- `source-state.cjs`：两条合成候选的 UI 操作。每次运行先通过公开 API 将这两条 fixture 复位为 unverified／未选，再执行选择与确认。
- `report-date.cjs`：直接用 Node 请求默认日期接口，校验指定时区；不需要浏览器或模型调用。

前提为项目要求的 Node 22、已安装仓库依赖（含 Playwright 1.63.0）与本机 Google Chrome。等待目标构建完成后，在仓库根目录执行：

```sh
npx tsx tests/browser/run-scale.ts --port 4325 --output tests/browser/artifacts/<new-run-name>
```

证据目录必须尚不存在，重复验收时使用新名称。省略 `--output` 则输出到本次临时数据目录的 `evidence/`，具体路径会打印。`--prepare-only` 只生成数据和固定构建副本，不启动 HTTP 或浏览器。`--help` 查看选项。入口会拒绝 4317、非有效端口与已占用端口，不会连接、关闭其他既有服务。

各独立脚本也可在设置 `MOMENTREAD_SCALE_URL`、`MOMENTREAD_SCALE_MANIFEST`、`MOMENTREAD_SCALE_OUTPUT` 后直接执行：

```sh
node tests/browser/scale-layout.cjs
node tests/browser/source-state.cjs
node tests/browser/report-date.cjs
```

`run-scale.ts` 自动传入这些变量，并调用上述仓库脚本。所有 `require('playwright')` 都解析仓库安装的依赖，不使用全局 Skill 路径或其 runner。Chrome 使用独立临时 profile，不修改全局浏览器设置。合成数据、候选状态与服务日志会保留在临时目录，供失败诊断；不会清理或覆盖用户数据。

最终构建复跑先发现测试入口通过书名进入时可能命中阅读页的“书籍资料”按钮；测试改为显式从书架点击“打开阅读”，未修改产品断言。随后以全新数据和证据目录重跑，21 + 4 项全部通过。

初次编写浏览器脚本时修正了可访问名称中的空格匹配、异步切换等待，以及将会影响后续场景的待确认小结创建顺序；这些属于测试脚本问题。正式结果来自重新生成的干净 500 节点数据集，未通过修改产品或放宽业务期望让测试通过。

## 不能从本结果推出的结论

- 不替代真实书籍导入、鼠标选文、真实 Claude 回答、逐层确认返回的完整主链验证。
- 不证明原著网络检索可用、候选真实或解释语义正确；没有真实模型或检索调用。
- 不属于新用户只依 README 的盲测，也不证明平台上传权限或原生文件选择框可用。
- 不覆盖后来生成的前端构建；应按构建清单中的资源指纹判断是否同一产物。
- 不宣称 500 节点、20 层之外的规模、其他浏览器或学习效果通过。

测试 Agent 未执行 Git。提交和最终构建归总负责人处理。
