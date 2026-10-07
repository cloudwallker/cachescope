# 第三方许可 / Third-party licenses

锁文件来自官方 npm registry，安装未运行生命周期脚本。The lockfile uses the official npm registry; lifecycle scripts were disabled during installation.

| 包 / Package | 精确版本 / Version | 用途 / Use | 许可 / License |
|---|---|---|---|
| yaml | 2.8.1 | Runtime YAML AST | ISC |
| TypeScript | 5.9.3 | Development compiler | Apache-2.0 |
| @types/node | 24.10.1 | Development types | MIT |
| undici-types | 7.16.0 | Transitive development types | MIT |
| playwright | 1.62.1 | Development browser automation | Apache-2.0 |
| playwright-core | 1.62.1 | Transitive browser automation | Apache-2.0 |

yaml copyright: Eemeli Aro. TypeScript copyright: Microsoft Corporation. Node type declarations: Microsoft Corporation and DefinitelyTyped contributors. undici-types copyright: Undici contributors. Complete upstream notices accompany each installed dependency; release packaging must preserve notices for any redistributed dependency.

官方许可 / Official licenses: [yaml](https://github.com/eemeli/yaml/blob/v2.8.1/LICENSE), [TypeScript](https://github.com/microsoft/TypeScript/blob/v5.9.3/LICENSE.txt), [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped/blob/master/LICENSE), [Undici](https://github.com/nodejs/undici/blob/v7.16.0/LICENSE).

兼容清单仅包含核查过的官方源码语句、定位与哈希；不执行或捆绑 Action 的代码。The compatibility profile records reviewed official source statements, locations, and hashes; it does not execute or bundle Action implementations.

Playwright copyright: Microsoft Corporation. Its complete Apache-2.0 license and notices accompany the installed development packages. Browser executables are not bundled in the CacheScope package. Playwright 版权归 Microsoft Corporation；完整许可随开发依赖提供，CacheScope 包不捆绑浏览器。
