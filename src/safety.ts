import { createHash } from 'node:crypto';
import type { Diagnostic, Field, FieldValues, Id, Presence, Result, SourceRef, Text } from './model.ts';
export const LIMITS = Object.freeze({ workflow: 2 * 1024 ** 2, log: 10 * 1024 ** 2, context: 2 * 1024 ** 2, 'cache-list': 2 * 1024 ** 2, lines: 200000, steps: 2000, key: 512, expression: 4096, depth: 64, aliases: 100, nodes: 100000, observations: 50000, entries: 10000, excerptBytes: 5 * 1024 ** 2, excerpts: 20000, excerptLines: 8, excerptSize: 4096, json: 16 * 1024 ** 2, html: 24 * 1024 ** 2, outputs: 48 * 1024 ** 2 });
export const fields: Field[] = ['primaryKey', 'restoredKey', 'restoreKeys', 'runnerOS', 'ref', 'defaultBranch', 'resolvedPaths', 'actionRef', 'executedCommit', 'lockfileMatches', 'lockfileHash', 'lockfileError', 'saveOutcome', 'saveReason', 'cacheHit', 'keyLayout', 'cacheEnabled', 'packageManager', 'cacheVersion'];
export const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
export const id = (kind: string, tuple: unknown): Id => `${kind}:${hash(JSON.stringify(tuple))}`;
export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const staticText = (s: string): Text => s as Text;
export function diagnostic(code: string, stage: Diagnostic['stage'] = 'input', category: Diagnostic['category'] = 'invalid', refs: SourceRef[] = []): Diagnostic { return { id: id('diagnostic', [stage, code, refs]), code, stage, category, label: staticText(stage), refs, message: { code, params: [] } }; }
export const fail = <T = never>(code: string, stage: Diagnostic['stage'] = 'input', category: Diagnostic['category'] = 'invalid', refs: SourceRef[] = []): Result<T> => ({ ok: false, diagnostics: [diagnostic(code, stage, category, refs)] });
export class SafeFailure extends Error {
    readonly code: string;
    readonly category: Diagnostic['category'];
    constructor(code: string, category: Diagnostic['category'] = 'invalid') { super(code); this.code = code; this.category = category; }
}
export function check(n: number, limit: number, code: string): void {
    if (n > limit)
        throw new SafeFailure(code, 'limit');
}
export function isSecret(s: string): boolean {
    if (/\$\{\{[\s\S]*?\bsecrets\s*\./i.test(s))
        return true;
    if (/(?:token|password|passwd|secret|private[-_ ]?key|credential|authorization)\s*[:=]|\bBearer\s+\S+|-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:gh[pousr]_|github_pat_|AKIA|ASIA|sk_live_|sk-proj-)[A-Za-z0-9_-]+/i.test(s))
        return true;
    if (/https?:\/\/[^\s/]+@|[?&](?:token|key|password|secret|credential|signature|auth)=/i.test(s))
        return true;
    // Conservatively mask mixed-alphabet opaque tokens. Pure hashes are retained only by explicit hash schemas.
    return s.split(/[^A-Za-z0-9_+\/=.-]/).some(t => t.length >= 32 && /[A-Z]/.test(t) && /[a-z]/.test(t) && /\d/.test(t) && new Set(t).size >= 12);
}
export function safeString(s: string, semantic?: string): Presence<Text> {
    if (s.includes('***') || /token|password|secret|private.?key|credential|authorization/i.test(semantic ?? '') || isSecret(s) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s) || /(?:^|\s)(?:[A-Za-z]:[\\/]|\/(?:home|Users|private|tmp|var|etc)\/)/.test(s))
        return { state: 'masked' };
    if (s === '')
        return { state: 'empty' };
    return { state: 'value', value: s as Text };
}
export const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function object(v: unknown): v is Record<string, unknown> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
export function fieldSchema(field: Field, value: unknown): boolean {
    const text = typeof value === 'string';
    switch (field) {
        case 'cacheHit': return ['true', 'false', 'empty', 'unrecorded'].includes(value as string);
        case 'cacheEnabled': return typeof value === 'boolean';
        case 'packageManager': return ['npm', 'yarn', 'pnpm'].includes(value as string);
        case 'saveOutcome': return ['saved', 'skipped', 'write-denied', 'error'].includes(value as string);
        case 'executedCommit': return text && /^[a-f\d]{40}$/i.test(value);
        case 'restoreKeys':
        case 'resolvedPaths':
        case 'lockfileMatches': return Array.isArray(value) && value.every(v => typeof v === 'string');
        case 'lockfileError': return object(value) && typeof value.path === 'string' && ['not-found', 'not-resolved'].includes(value.reason as string) && ['error-message', 'action-input'].includes(value.pathBasis as string) && Object.keys(value).every(k => ['path', 'reason', 'pathBasis'].includes(k));
        case 'saveReason': return object(value) && ['normal-policy', 'failure', 'unknown'].includes(value.class as string) && typeof value.code === 'string' && Object.keys(value).every(k => ['class', 'code'].includes(k));
        case 'keyLayout': return object(value) && Object.keys(value).every(k => k === 'parts') && Array.isArray(value.parts) && value.parts.every(p => {
            if (!object(p))
                return false;
            if (p.kind === 'literal')
                return Object.keys(p).every(k => ['kind', 'text', 'keyStart', 'keyEnd'].includes(k)) && presenceSchema(p.text) && integer(p.keyStart) && integer(p.keyEnd) && p.keyEnd >= p.keyStart;
            if (p.kind !== 'variable' || Object.keys(p).some(k => !['kind', 'variable'].includes(k)) || !object(p.variable))
                return false;
            const v = p.variable;
            return Object.keys(v).every(k => ['expression', 'resolved', 'kind', 'keyStart', 'keyEnd', 'refs'].includes(k)) && presenceSchema(v.expression) && presenceSchema(v.resolved) && ['date', 'other'].includes(v.kind as string) && integer(v.keyStart) && integer(v.keyEnd) && v.keyEnd >= v.keyStart && (v.refs === undefined || Array.isArray(v.refs));
        });
        default: return text;
    }
}
export function presenceSchema(v: unknown): boolean { return object(v) && Object.keys(v).every(k => ['state', 'value'].includes(k)) && (v.state === 'value' ? Object.hasOwn(v, 'value') && typeof v.value === 'string' : ['empty', 'missing', 'masked'].includes(v.state as string) && !Object.hasOwn(v, 'value')); }
export function sanitize<F extends Field>(field: F, v: unknown): Presence<FieldValues[F]> {
    if (!fieldSchema(field, v))
        throw new SafeFailure('FIELD_SCHEMA_INVALID');
    if (field === 'keyLayout') {
        for (const part of (v as FieldValues['keyLayout']).parts) {
            if (part.kind === 'variable' && part.variable.expression.state === 'value')
                check(Buffer.byteLength(part.variable.expression.value), LIMITS.expression, 'EXPRESSION_LIMIT');
        }
    }
    if (['primaryKey', 'restoredKey'].includes(field)) {
        check(Array.from(v as string).length, LIMITS.key, 'KEY_LIMIT');
    }
    if (field === 'restoreKeys')
        for (const k of v as string[])
            check(Array.from(k).length, LIMITS.key, 'KEY_LIMIT');
    let masked = false;
    const walk = (x: unknown): unknown => {
        if (typeof x === 'string') {
            if (field === 'executedCommit')
                return x as Text;
            const p = safeString(x);
            if (p.state === 'masked')
                masked = true;
            return p.state === 'value' ? p.value : staticText('');
        }
        if (Array.isArray(x))
            return x.map(walk);
        if (object(x)) {
            const out: Record<string, unknown> = {};
            for (const [k, y] of Object.entries(x)) {
                if (k === 'refs')
                    continue;
                out[k] = walk(y);
            }
            return out;
        }
        return x;
    };
    const out = walk(v);
    if (masked)
        return { state: 'masked' };
    if (typeof v === 'string' && v === '' && field !== 'cacheHit')
        return { state: 'empty' };
    return { state: 'value', value: out as FieldValues[F] };
}
export function freeze<T>(v: T): T {
    if (v && typeof v === 'object') {
        Object.values(v).forEach(freeze);
        Object.freeze(v);
    }
    return v;
}
export function physical(text: string): {
    starts: number[];
    ends: number[];
    lines: string[];
} {
    const starts: number[] = [], ends: number[] = [], lines: string[] = [];
    if (!text)
        return { starts, ends, lines };
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\r' || text[i] === '\n') {
            starts.push(start);
            ends.push(i);
            lines.push(text.slice(start, i));
            if (text[i] === '\r' && text[i + 1] === '\n')
                i++;
            start = i + 1;
        }
    }
    if (start < text.length) {
        starts.push(start);
        ends.push(text.length);
        lines.push(text.slice(start));
    }
    return { starts, ends, lines };
}
export function lineAt(starts: number[], offset: number): number {
    let lo = 0, hi = starts.length;
    while (lo < hi) {
        const m = (lo + hi) >>> 1;
        if (starts[m]! <= offset)
            lo = m + 1;
        else
            hi = m;
    }
    return Math.max(1, lo);
}
export interface JsonIndex {
    value: unknown;
    nodes: Map<string, {
        start: number;
        end: number;
    }>;
}
export function parseJson(text: string, consume: (n: number) => void): JsonIndex {
    let i = 0;
    const nodes = new Map<string, {
        start: number;
        end: number;
    }>();
    const skip = () => {
        while (/[ \t\r\n]/.test(text[i] ?? '!'))
            i++;
    };
    const str = () => {
        const start = i++;
        while (i < text.length) {
            if (text[i] === '\\') {
                i += 2;
                continue;
            }
            if (text[i++] === '"') {
                return JSON.parse(text.slice(start, i)) as string;
            }
        }
        throw new SafeFailure('JSON_INVALID');
    };
    const parse = (ptr: string, depth: number): unknown => {
        skip();
        const start = i;
        if (text[i] === '{' || text[i] === '[')
            check(depth, LIMITS.depth, 'DEPTH_LIMIT');
        consume(1);
        let v: unknown;
        if (text[i] === '{') {
            i++;
            const out: Record<string, unknown> = {};
            const keys = new Set<string>();
            skip();
            while (text[i] !== '}') {
                if (text[i] !== '"')
                    throw new SafeFailure('JSON_INVALID');
                const k = str();
                if (keys.has(k))
                    throw new SafeFailure('JSON_DUPLICATE_KEY');
                keys.add(k);
                skip();
                if (text[i++] !== ':')
                    throw new SafeFailure('JSON_INVALID');
                const p = ptr + '/' + k.replaceAll('~', '~0').replaceAll('/', '~1');
                const x = parse(p, depth + 1);
                Object.defineProperty(out, k, { value: x, enumerable: true, writable: true, configurable: true });
                skip();
                if (text[i] !== ',')
                    break;
                i++;
                skip();
                if (text[i] === '}')
                    throw new SafeFailure('JSON_INVALID');
            }
            if (text[i++] !== '}')
                throw new SafeFailure('JSON_INVALID');
            v = out;
        }
        else if (text[i] === '[') {
            i++;
            const a: unknown[] = [];
            skip();
            while (text[i] !== ']') {
                a.push(parse(ptr + '/' + a.length, depth + 1));
                skip();
                if (text[i] !== ',')
                    break;
                i++;
                skip();
                if (text[i] === ']')
                    throw new SafeFailure('JSON_INVALID');
            }
            if (text[i++] !== ']')
                throw new SafeFailure('JSON_INVALID');
            v = a;
        }
        else if (text[i] === '"')
            v = str();
        else {
            const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
            if (!m)
                throw new SafeFailure('JSON_INVALID');
            i += m[0].length;
            v = JSON.parse(m[0]);
        }
        nodes.set(ptr, { start, end: i });
        return v;
    };
    const value = parse('', 1);
    skip();
    if (i !== text.length)
        throw new SafeFailure('JSON_INVALID');
    return { value, nodes };
}
export function stripAnsiLines(lines: string[]): {
    text: string;
    columns: number[];
}[] {
    let state: 'text' | 'esc' | 'csi' | 'osc' | 'osc-esc' = 'text';
    return lines.map(line => {
        let text = '';
        const columns: number[] = [];
        const cps = Array.from(line);
        for (let i = 0; i < cps.length; i++) {
            const c = cps[i]!;
            if (state === 'osc') {
                if (c === '\x07')
                    state = 'text';
                else if (c === '\x1b')
                    state = 'osc-esc';
                continue;
            }
            if (state === 'osc-esc') {
                if (c === '\\')
                    state = 'text';
                else
                    state = c === '\x1b' ? 'osc-esc' : 'osc';
                continue;
            }
            if (state === 'csi') {
                if (/[@-~]/.test(c))
                    state = 'text';
                continue;
            }
            if (state === 'esc') {
                state = c === '[' ? 'csi' : c === ']' ? 'osc' : 'text';
                continue;
            }
            if (c === '\x1b') {
                state = 'esc';
                continue;
            }
            if (c === '\x9b') {
                state = 'csi';
                continue;
            }
            if (c === '\x9d') {
                state = 'osc';
                continue;
            }
            if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c))
                continue;
            columns.push(i);
            text += c;
        }
        return { text, columns };
    });
}
