# Contributing / 贡献

Contributions should preserve the single loader/analyzer evidence flow. Start with a small synthetic fixture and an independently written expected outcome, including uncertainty, source lines and exit status. Run `npm ci --ignore-scripts`, `npm run build`, `npm test`, and `npm run test:browser` when report behavior changes. Browser setup is described in the README.

请保留唯一 loader/analyzer 证据链。先编写小型合成输入和独立预期，记录未知状态、来源行及退出码，再实现变更。报告交互变更需运行真实浏览器测试。

New log patterns require exact official source commits, file hashes, line ranges, and positive/negative examples. Preserve user-declared origins and all conflicting observations. Templates must use explicit placeholders and parse as YAML. Keep process logs, real logs, credentials, private paths and generated local reports out of commits. Use your own contributor identity.

新增日志模式需包含精确官方源码提交、文件哈希、行范围及正反例；用户来源与冲突观察不得改写。建议模板使用显式占位符并通过 YAML 解析。提交只包含合成材料和必要源码。

MIT licensing applies to contributions. List any additional redistributed dependency notices in THIRD_PARTY_LICENSES.md.
