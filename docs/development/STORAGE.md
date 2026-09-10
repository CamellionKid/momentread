# 存储与 EPUB 元数据

书籍原文件以不可变字节保存，文件版本使用独立 UUID 并记录 SHA256。阅读与用户补录资料不会改写 EPUB；重新导入相同字节复用书籍及文件版本身份。

## 书籍资料的读取规则

| 字段 | OPF 来源与处理 |
| --- | --- |
| `title` | 优先明确标注 `title-type=main` 的 `dc:title`；其次读取未标为 edition 的标题。 |
| `author` | `dc:creator` 的原始显示文本。 |
| `translator` | 仅接纳 `dc:contributor` 的明确 `opf:role=trl`，或通过 `refines=#贡献者ID` 关联的 `role=trl`。EPUB 3 角色 scheme 为 `marc:relators` 或未指定。多个译者去重后以顿号连接。 |
| `edition` | 将明确的版本文本、出版社和出版日期去重后用 ` · ` 连接。版本文本来自 `title-type=edition` 的标题，或 `edition`、`bookEdition`、`schema:bookEdition`、`prism:edition`、`calibre:edition` 元数据；出版信息来自 `dc:publisher`、无 event 或 `event=publication` 的 `dc:date`、`dcterms:issued`。 |
| `identifier` | 首先解析 package 的 `unique-identifier` 指向的 `dc:identifier`；找不到时优先明确标为 ISBN 的标识，最后取首个非空标识。保留原始字符串，不推断 ISBN。 |

未知的译者、版本资料和标识保存为空字符串。未标注角色的 contributor、作者、generator、角色为 `bkp` 的制作者均不会被推断为译者。`dcterms:modified` 和明确的 modification 日期不会被当作出版日期。

这些字段是 EPUB 自带的资料，可能包含网站名称或不准确的日期；读取成功不代表出版信息已经核实。生产界面可另行提供用户补录。元数据文本只作文本显示，不能作为 HTML 注入。

标准角色关联与版本标题依据：[EPUB 3.3 的 refines](https://www.w3.org/TR/epub-33/#sec-refines-attr)、[role](https://www.w3.org/TR/epub-33/#sec-property-role)、[title-type](https://www.w3.org/TR/epub-33/#sec-property-title-type)。常见的额外 edition 名称仅作显式字段兼容，不从介绍或正文猜测版次。

## 兼容与恢复

三个补充字段在契约中均为可选值，旧数据库和旧备份无需重写。重新导入同一 EPUB 时，仅补齐旧记录中尚不存在的字段；用户已经修改的字段，包括主动清空的值，保持原样。书籍 ID、文件版本 ID、SHA256、创建时间不变。

备份保留完整书籍记录、数据库事件与幂等记录，并包含已校验的不可变书籍文件。SQLite 序列化快照统一为可独立读取的回滚格式；此处理只作用于快照，不改变运行中的 WAL 数据库。恢复仅允许空书库，通过校验后在当前 Store 事务中导入，不替换仍被应用持有的数据库连接。

## 模块验证

运行：`npx vitest run tests/unit/storage.test.ts tests/integration/storage-books.test.ts`。

元数据用合成 EPUB 覆盖 EPUB 2 角色属性、EPUB 3 refines、多个贡献者、未知译者、制作者排除、版本标题、出版/修改日期区分、主标识选择，以及旧记录补齐和用户编辑保留。用户指定真实书仅在临时目录进行导入检查，不将书籍正文或 EPUB 纳入仓库。
