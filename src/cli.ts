#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { loadAnalysisInputs, prepareOutputs, validateOutputPayloads } from './input.ts';
import type { InputPaths, OutputRequest, OutputPayload } from './input.ts';
import type { Diagnostic, Locale, Selection, Result, Report } from './model.ts';
import { analyzeInputs, assertTrustedReport } from './analyze.ts';
import { renderHtml } from './report.ts';
import { writeOutputs } from './output.ts';
import { exitCode } from './status.ts';
import { fail, safeString, LIMITS } from './safety.ts';
const demos = ['dynamic-key', 'lockfile-path', 'path-change', 'restore-only', 'package-cache'];
const usage = `CacheScope 0.1.0
  cachescope --workflow workflow.yml --run-a run-a.txt --run-b run-b.txt
    [--context context.json] [--cache-list cache-list.json]
    [--job JOB] [--step STEP_ID_OR_STABLE_REF] [--locale zh-CN|en]
    [--json] [--html report.html] [--output-json report.json] [--overwrite]
  cachescope demo [dynamic-key|lockfile-path|path-change|restore-only|package-cache]
    [--json] [--html report.html] [--output-json report.json] [--locale zh-CN|en]
  cachescope --version | --help
退出码 / Exit codes: 0 facts, 1 confirmed problem, 2 pending, 3 input/output failure.
`;
interface Options {
    values: Map<string, string>;
    json: boolean;
    overwrite: boolean;
    locale: Locale;
    demo?: string;
    special?: 'version' | 'help';
}
function parse(args: string[]): Result<Options> {
    const values = new Map<string, string>();
    let demo: string | undefined;
    if (args[0] === 'demo') {
        args = args.slice(1);
        demo = args[0] && !args[0].startsWith('--') ? args.shift()! : 'dynamic-key';
        if (!demos.includes(demo))
            return fail('DEMO_INVALID');
    }
    const flags = new Set(['--json', '--overwrite', '--version', '--help']);
    const pairs = new Set(['--workflow', '--run-a', '--run-b', '--context', '--cache-list', '--job', '--step', '--locale', '--html', '--output-json']);
    for (let i = 0; i < args.length; i++) {
        const k = args[i]!;
        if (values.has(k) || !flags.has(k) && !pairs.has(k))
            return fail('CLI_OPTIONS_INVALID');
        if (flags.has(k))
            values.set(k, 'true');
        else {
            const v = args[++i];
            if (!v || v.startsWith('--') || v === '-')
                return fail('CLI_OPTIONS_INVALID');
            values.set(k, v);
        }
    }
    if (values.has('--version') || values.has('--help')) {
        if (values.size !== 1 || demo)
            return fail('CLI_OPTIONS_INVALID');
        return { ok: true, value: { values, json: false, overwrite: false, locale: 'zh-CN', special: values.has('--version') ? 'version' : 'help' } };
    }
    const locale = values.get('--locale') ?? 'zh-CN';
    if (locale !== 'zh-CN' && locale !== 'en')
        return fail('LOCALE_INVALID');
    if (values.has('--overwrite') && !values.has('--html') && !values.has('--output-json'))
        return fail('OVERWRITE_REQUIRES_OUTPUT');
    if (demo && ['--workflow', '--run-a', '--run-b', '--context', '--cache-list'].some(k => values.has(k)))
        return fail('DEMO_INPUT_CONFLICT');
    if (!demo && !['--workflow', '--run-a', '--run-b'].every(k => values.has(k)))
        return fail('CLI_INPUT_REQUIRED');
    return { ok: true, value: { values, json: values.has('--json'), overwrite: values.has('--overwrite'), locale, ...(demo ? { demo } : {}) } };
}
type StandardStream = typeof process.stdout | typeof process.stderr;
const streamStates = new WeakMap<StandardStream, { failed: boolean }>();
function guardStream(stream: StandardStream): { failed: boolean } {
    const existing = streamStates.get(stream);
    if (existing) return existing;
    const state = { failed: false };
    // Keep one listener for the stream lifetime: an error event can follow its write callback.
    // The handler never formats the original error or writes back to a failed stream.
    stream.on('error', () => { state.failed = true; process.exitCode = 3; });
    streamStates.set(stream, state);
    return state;
}
async function writeStandard(stream: StandardStream, text: string): Promise<boolean> {
    const state = guardStream(stream);
    if (state.failed || stream.destroyed || stream.writableEnded) {
        state.failed = true;
        process.exitCode = 3;
        return false;
    }
    return new Promise(resolve => {
        try {
            stream.write(text, error => {
                if (error) { state.failed = true; process.exitCode = 3; }
                resolve(!state.failed);
            });
        } catch {
            state.failed = true;
            process.exitCode = 3;
            resolve(false);
        }
    });
}
async function stdoutFailure(filesWritten = false): Promise<number> {
    await writeStandard(process.stderr, filesWritten ? 'output: PARTIAL_OUTPUT\n' : 'output: STDOUT_WRITE_FAILED\n');
    return 3;
}
async function error(diagnostics: Diagnostic[], json: boolean): Promise<number> {
    if (json) {
        if (!await writeStandard(process.stdout, JSON.stringify({ schemaVersion: 1, error: { diagnostics } }) + '\n'))
            return stdoutFailure();
    } else {
        await writeStandard(process.stderr, diagnostics.map(d => `${d.stage}: ${d.code}`).join('\n') + '\n');
    }
    return 3;
}
export async function runCli(args: string[]): Promise<number> {
    // The error channel also honors --json when option validation itself fails.
    const wantsJson = args.includes('--json');
    guardStream(process.stdout);
    guardStream(process.stderr);
    try {
        const parsed = parse([...args]);
        if (!parsed.ok)
            return error(parsed.diagnostics, wantsJson);
        const o = parsed.value, v = o.values;
        if (o.special) {
            return await writeStandard(process.stdout, o.special === 'version' ? '0.1.0\n' : usage) ? 0 : stdoutFailure();
        }
        const base = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', o.demo ?? '');
        const paths: InputPaths = o.demo ? { workflow: join(base, 'workflow.yml'), runA: join(base, 'run-a.txt'), runB: join(base, 'run-b.txt'), context: join(base, 'context.json') } : { workflow: v.get('--workflow')!, runA: v.get('--run-a')!, runB: v.get('--run-b')!, ...(v.has('--context') ? { context: v.get('--context')! } : {}), ...(v.has('--cache-list') ? { cacheList: v.get('--cache-list')! } : {}) };
        const loaded = await loadAnalysisInputs(paths);
        if (!loaded.ok)
            return error(loaded.diagnostics, o.json);
        const selection: Selection = {};
        for (const k of ['--job', '--step'])
            if (v.has(k)) {
                const p = safeString(v.get(k)!);
                if (p.state !== 'value')
                    return error([{ ...((fail('SELECTION_INVALID') as {
                                ok: false;
                                diagnostics: Diagnostic[];
                            }).diagnostics[0]!) }], o.json);
                if (k === '--job')
                    selection.jobId = p.value;
                else
                    selection.step = { kind: /\/j\d+\/s\d+$/.test(p.value) ? 'stepRef' : 'stepId', value: p.value };
            }
        const analyzed = analyzeInputs(loaded.value.inputs, selection);
        if (!analyzed.ok)
            return error(analyzed.diagnostics, o.json);
        const report = analyzed.value, code = exitCode(report);
        const trusted = assertTrustedReport(report);
        if (!trusted.ok) return error(trusted.diagnostics, o.json);
        const json = JSON.stringify(report);
        if (Buffer.byteLength(json) + (o.json ? 1 : 0) > LIMITS.json)
            return error((fail('REPORT_JSON_LIMIT', 'output', 'limit') as {
                ok: false;
                diagnostics: Diagnostic[];
            }).diagnostics, o.json);
        const summary = o.locale === 'en' ? `CacheScope · exit ${code} · ${report.stepViews.length} steps · ${report.findings.filter(f => f.kind === 'fact').length} facts · ${report.findings.filter(f => f.kind === 'problem').length} problems · ${report.findings.filter(f => f.kind === 'pending').length} pending\n` : `CacheScope · 退出码 ${code} · ${report.stepViews.length} 个步骤 · ${report.findings.filter(f => f.kind === 'fact').length} 项事实 · ${report.findings.filter(f => f.kind === 'problem').length} 项问题 · ${report.findings.filter(f => f.kind === 'pending').length} 项待确认\n`;
        const stdout = o.json ? json + '\n' : summary;
        const requests: OutputRequest[] = [], payloads: OutputPayload[] = [];
        if (v.has('--html')) {
            const h = renderHtml(report, o.locale);
            if (!h.ok)
                return error(h.diagnostics, o.json);
            requests.push({ kind: 'html', path: v.get('--html')! });
            payloads.push({ kind: 'html', utf8: Buffer.from(h.value) });
        }
        if (v.has('--output-json')) {
            requests.push({ kind: 'json', path: v.get('--output-json')! });
            payloads.push({ kind: 'json', utf8: Buffer.from(json) });
        }
        const permit = await prepareOutputs(loaded.value, requests, { overwrite: o.overwrite });
        if (!permit.ok)
            return error(permit.diagnostics, o.json);
        const budget = validateOutputPayloads(permit.value, payloads, Buffer.byteLength(stdout));
        if (!budget.ok)
            return error(budget.diagnostics, o.json);
        const written = await writeOutputs(permit.value, payloads);
        if (!written.ok)
            return error(written.diagnostics, o.json);
        if (!await writeStandard(process.stdout, stdout))
            return stdoutFailure(requests.length > 0);
        if (!o.json && report.diagnostics.length && !await writeStandard(process.stderr, report.diagnostics.map(d => `${d.stage}: ${d.code}`).join('\n') + '\n'))
            return 3;
        return code;
    }
    catch {
        return error((fail('CLI_FAILURE', 'output', 'io') as {
            ok: false;
            diagnostics: Diagnostic[];
        }).diagnostics, wantsJson);
    }
}
if (process.argv[1]) {
    let isEntry = false;
    try {
        isEntry = await realpath(resolve(process.argv[1])) === await realpath(fileURLToPath(import.meta.url));
    } catch {
        const failure = fail('CLI_ENTRY_FAILURE', 'output', 'io');
        if (!failure.ok) process.exitCode = await error(failure.diagnostics, process.argv.includes('--json'));
    }
    if (isEntry) process.exitCode = await runCli(process.argv.slice(2));
}
