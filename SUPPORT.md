# Support / 支持范围

## Verified locally / 本机已验证

- Windows on Node.js 24.15.0: source installation/build, tests, actual CLI demos and packaged CLI.
- Chrome: local `file://` reports with offline networking, five complete demos, insufficient/conflict inputs, computed step selection, source anchors, search/filter, clipboard or keyboard-copy fallback, JSON download, and 390px keyboard layout.
- The five complete demos return exit 2 and retain independent pending evidence.

Windows 上已实际运行安装、构建、测试和包内CLI；Chrome已实际断网检查报告交互与390px键盘布局。五个完整案例均保留待确认项并退出2。

## CI targets / CI 目标

The checked-in workflow targets Windows, Ubuntu and macOS on Node 24, with an Ubuntu Chromium report job. The workflow configuration is a planned check; remote executions must be recorded separately after publication. Linux/macOS are not described as locally verified platforms.

CI 配置包含 Windows、Ubuntu、macOS 与 Ubuntu Chromium；配置存在不等于已经运行。远端结果在发布后独立记录，当前本机支持证据限于 Windows。

## Evidence coverage / 证据覆盖

See `compatibility.json` for the fixed source commits, hashes, exact statement patterns and per-entry limitations. Use synthetic reproducers when a statement or workflow is unsupported. User range mapping, source-format verification and execution/save completeness are distinct evidence dimensions. Maintainer interviews and external user validation have not been run.

固定源码、哈希和模式以 compatibility.json 为准。用户范围映射、源码语句格式核验与执行/保存完备性分别保留。维护者访谈和外部用户验证尚未执行。
