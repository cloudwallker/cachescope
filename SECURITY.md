# Security / 安全

Use synthetic reproductions for public issues. Do not attach live workflow logs, credentials, private keys, environment files or reports containing private data. Describe the affected version, command shape, expected behavior and synthetic input.

公开问题请使用合成材料，提供版本、命令结构、预期和复现输入。不要上传真实运行日志、凭据、私钥、环境配置或含私人数据的报告。

The loader masks known secret formats and conservatively handles unsupported evidence. Redaction is a risk reduction measure; inspect reports before sharing. If a report discloses a secret, revoke the affected credential and contact the repository maintainer through an available private channel before public disclosure.

脱敏减少泄露风险，分享前仍应人工检查。若报告泄露密钥，先撤销相关凭据，再通过仓库维护者可用的私密渠道报告。
