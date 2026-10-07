# CacheScope

[简体中文](README_ZH.md) · [English](README.md)

**本地对照 GitHub Actions 缓存证据，生成可独立打开的离线报告。**

**Local GitHub Actions cache evidence comparison, with a self-contained offline report.**

CacheScope 将一份工作流、两次运行日志及可选的上下文/缓存清单放在一起，展示 key、restore keys、OS、已解析路径和 ref 五项对照，以及事实、问题、待补证据、来源定位和可复制的 YAML 建议。

![合成案例的离线报告](docs/report-desktop.png)

## 从源码运行

需要 Node.js 24.15.0 或更新版本及 npm。在项目目录执行：

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js demo dynamic-key --html report.html --output-json report.json
```

直接用浏览器打开 `report.html`。页面包含数据、样式和脚本，使用系统字体，可断网使用。当前五个完整合成案例都返回 **退出码 2**：分析已完成，同时保留独立待确认项。

```sh
node dist/cli.js demo lockfile-path --json
node dist/cli.js demo path-change --html paths.html
node dist/cli.js demo restore-only --html restore.html
node dist/cli.js demo package-cache --html packages.html
```

省略案例名时默认为 `dynamic-key`。案例读取随包分发的真实合成 workflow、双日志和 context，经过与用户文件相同的 loader 和规则计算。

## 分析自己的文件

```sh
node dist/cli.js --workflow workflow.yml --run-a run-a.txt --run-b run-b.txt --context context.json --html report.html --output-json report.json --json
```

| 参数 | 用途 |
| --- | --- |
| `--workflow`、`--run-a`、`--run-b` | 三个必填的明确输入文件。 |
| `--context` | 将日志范围映射到步骤，并提供显式用户声明。参见[格式说明](docs/context.md)。 |
| `--cache-list` | 导入 GitHub REST `actions_caches` 对象或 `gh` 数组，保留版本、范围和分页证据。 |
| `--job`、`--step` | 选择 job 或唯一 step id；无 id 步骤可使用报告中的完整稳定 `stepRef`。 |
| `--locale zh-CN\|en` | 界面和文本摘要语言，默认中文；JSON 事实保持一致。 |
| `--html`、`--output-json` | 可同时输出两种文件。父目录需已存在；明确指定的工作目录外路径同样有效。 |
| `--json` | stdout 只输出一份 Report JSON；错误使用 `{schemaVersion:1,error:{diagnostics:[...]}}`。 |
| `--overwrite` | 替换已有的普通输出文件；输入及其任何别名始终受保护。 |
| `--version`、`--help` | 显示版本或命令说明。 |

未知或重复选项返回 3。文件输出不接受 `-`。默认 stdout 是安全摘要，诊断写入 stderr。退出码优先级为 **3 > 2 > 1 > 0**。

| 退出码 | 含义 |
| --- | --- |
| 0 | 证据完整，且没有已确认问题。 |
| 1 | 存在已确认问题，且无更高优先级状态。 |
| 2 | 仍有缺失、未核验、有歧义或冲突的证据。 |
| 3 | 输入无效、超过预算，或输入/输出失败。 |

## 使用报告

在已计算步骤间切换、搜索安全内容，并筛选事实/问题/待确认项。来源链接定位原输入物理行，列范围和 JSON Pointer 定位具体 token。省略号表示未导出的文本；零宽「已遮盖」只表示结构锚点。导出按钮保留完整报告 JSON；复制按钮提供带 `REPLACE_WITH_*` 必填占位符的固定 YAML。剪贴板权限不可用时，页面选中可手动复制的文本框。

步骤切换保留完整报告退出码。工作流表达式作为静态配置显示，日志观察与用户声明分别保留来源和核验等级。缺失、明确为空、已遮盖及未记录分别展示。`cache-hit=false` 本身不足以说明未恢复任何缓存。

## 证据范围

[兼容清单](compatibility.json) 包含 12 个固定模式，覆盖选定的 `actions/cache` v4.0.2、`actions/setup-node` v4.0.4 语句，以及 runner 下载和动作输入头。清单逐项保存精确源码提交、哈希和覆盖范围。声明 tag 只是候选适配版本；受支持的 runner 下载记录提供提交证据，`verified` 表示固定源码的**语句格式语义已核验**。步骤映射仍由用户声明的日志范围建立；日志真实性、运行成功和保存完备性分别需要证据。

五类案例覆盖日期 key、锁文件不可解析、路径变化、restore-only 配置和包管理器缓存对象。日期/key/路径/version 关系可以是明确限定的**用户声明事实**。锁文件 `pathBasis=action-input` 表示目标来自同一动作输入头，错误行提供不可解析结果。当前清单缺少独立保存完整边界和失败模式，因此保存结果可以持续待确认。完整缓存清单只描述声明的范围和观察时点。

## 隐私与文件安全

工具只读取明确输入文件，在本机运行，无网络请求、工作流命令或表达式执行。唯一 loader 在构建报告前遮盖敏感字段，导出最小必要证据。公开案例和截图均为合成材料；分享前请检查报告。

所有输出先完成编码与预算检查。新建输出通过同目录独占临时文件和无覆盖发布完成；覆盖使用同目录原子替换。写入过程中复核输入身份/哈希、输出身份和父目录；许可只能使用一次，payload 使用固定字节快照。后续文件失败时保留已完成文件，返回 `PARTIAL_OUTPUT` 和退出码 3。这是逐文件操作；路径复核与 rename 无法提供操作系统未保证的绝对无竞争性。身份或路径条件无法可靠核实时安全失败。

输入上限：workflow/context/cache-list 各 2 MiB，每份日志 10 MiB，全部物理行 200,000，workflow steps 2,000，每个 key 512 个 Unicode 码点。另有深度 64、YAML alias 引用 100、展开节点 100,000、观察 50,000、缓存条目 10,000、片段 20,000 和片段文本 5 MiB 的预算。单份 JSON 16 MiB、HTML 24 MiB，一次 CLI 所有请求输出合计 48 MiB。

## 库接口

```js
import { loadAnalysisInputs, analyzeInputs, renderHtml, exitCode } from 'cachescope';
const loaded = await loadAnalysisInputs({ workflow: 'workflow.yml', runA: 'a.log', runB: 'b.log' });
if (loaded.ok) {
  const analyzed = analyzeInputs(loaded.value.inputs);
  if (analyzed.ok) {
    const html = renderHtml(analyzed.value, 'zh-CN'); // Result<string>
    console.log(exitCode(analyzed));
  }
}
```

公共入口导出模型类型和 `loadAnalysisInputs`、`analyzeInputs`、`makeSuggestions`、`exitCode`、`renderHtml`。输入与报告必须来自真实 loader/analyzer，JSON 克隆不取得可信资格。私有 guard 和输出许可不可序列化；JSON 应序列化分析后的 Report。导入库不会自动分析或写文件。

## 开发与支持

```sh
npm test
npm run build
npm run test:browser
npm pack --ignore-scripts
```

浏览器测试使用 Playwright Chromium，可用 `npx playwright install chromium` 安装，或通过 `CACHESCOPE_BROWSER` 指定已有 Chrome。当前本机已在 Windows、Node 24.15.0 和断网 Chrome 验证。[支持状态](SUPPORT.md) 区分实际运行结果与待执行 CI 平台。另见[贡献](CONTRIBUTING.md)、[安全](SECURITY.md)和[第三方许可](THIRD_PARTY_LICENSES.md)。

MIT © cloudwallker。
