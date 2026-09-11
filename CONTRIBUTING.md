# 参与贡献

感谢关注 MomentRead。当前项目处于「首版主链已完成验收」状态，欢迎 issue 讨论、缺陷报告与 PR。

## 环境

- macOS + Chrome 桌面浏览器（当前已承诺的支持范围）
- Node.js：使用 [.nvmrc](.nvmrc) 的版本（`nvm install && nvm use`）
- Claude Code CLI 已安装并认证；未安装时按 [README](README.md) 的说明安装

## 开发流程

```sh
npm ci
npm run build
npm test
```

开发模式（双终端）与浏览器规模验收命令见 [README 开发与测试一节](README.md#开发与测试)。

## 提交 PR 前

- 通过 `npm run typecheck` 与全部自动化测试（当前 244 项）
- 不把书籍文件、学习数据、凭据、构建产物或个人路径新引入 Git
- 提交格式沿用 `[scope] short imperative description`
- 涉及与 AI 或原著匹配的行为变更时，请同步更新相关 docs；不要宣称未经验证的能力（例如原著自动检索的当前状态见 [STATUS](docs/development/STATUS.md)）

## 报告缺陷

Issue 请附：复现步骤、期望与实际行为、`npm run build` 与相关测试输出。涉及 AI 回复质量的问题，请附脱敏后的最小复现文本，不要包含书籍版权内容或个人信息。
