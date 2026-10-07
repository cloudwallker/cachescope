import type { CacheList, Result, Id, Context, CacheEntry, ListScope, Presence, Text } from './model.ts';
import { validateParseContext, jsonRef, requestJsonExcerpt, validTime, sanitizeSourceText } from './input.ts';
import type { ParseContext } from './input.ts';
import { LIMITS, check, SafeFailure, parseJson, object, integer, safeString, id, diagnostic } from './safety.ts';
export function parseCacheList(ctx: ParseContext, sourceId: Id, context?: Context): Result<CacheList> {
    const g = validateParseContext(ctx, sourceId, 'cache-list');
    if (!g.ok)
        return g;
    return ctx.withSource(sourceId, (text, offsets) => {
        const j = parseJson(text, () => { });
        const format = Array.isArray(j.value) ? 'gh' : 'rest';
        const list = format === 'gh' ? j.value : object(j.value) ? j.value.actions_caches : undefined;
        if (!Array.isArray(list))
            throw new SafeFailure('CACHE_LIST_SCHEMA_INVALID');
        check(list.length, LIMITS.entries, 'CACHE_ENTRIES_LIMIT');
        const total = format === 'rest' && object(j.value) ? j.value.total_count : undefined;
        if (total !== undefined && !integer(total))
            throw new SafeFailure('CACHE_LIST_COUNT_INVALID');
        const totalCount: Presence<number> = total === undefined ? { state: 'missing' } : { state: 'value', value: total as number };
        const result: CacheList = { sourceId, format, entries: [], totalCount, pagination: { state: 'unknown', allPages: context?.cacheList?.pagination.allPages ?? { state: 'missing' }, expectedCount: context?.cacheList?.pagination.expectedCount ?? { state: 'missing' }, importedCount: list.length, refs: context?.cacheList?.refs ?? [], origin: 'user_provided' }, scope: context?.cacheList?.scope ?? { repository: { state: 'missing' }, ref: { state: 'missing' }, observedAt: { state: 'missing' } }, diagnostics: [] };
        if (total !== undefined) {
            const r = jsonRef(sourceId, '/total_count', j.nodes, offsets);
            result.pagination.refs = [...result.pagination.refs, r];
            requestJsonExcerpt(ctx, r, j.nodes, offsets);
        }
        const map = format === 'rest' ? { providerId: 'id', key: 'key', version: 'version', ref: 'ref', sizeBytes: 'size_in_bytes', createdAt: 'created_at', lastAccessedAt: 'last_accessed_at' } : { providerId: 'id', key: 'key', version: 'version', ref: 'ref', sizeBytes: 'sizeInBytes', createdAt: 'createdAt', lastAccessedAt: 'lastAccessedAt' };
        list.forEach((raw, i) => {
            if (!object(raw))
                throw new SafeFailure('CACHE_ENTRY_SCHEMA_INVALID');
            if (Object.hasOwn(raw, 'resolvedKey'))
                throw new SafeFailure('UNKNOWN_FIELD_ALIAS');
            const prefix = format === 'rest' ? `/actions_caches/${i}` : `/${i}`;
            const entry: CacheEntry = { id: id('cache-entry', [sourceId, prefix]), providerId: { state: 'missing' }, key: { state: 'missing' }, version: { state: 'missing' }, ref: { state: 'missing' }, sizeBytes: { state: 'missing' }, createdAt: { state: 'missing' }, lastAccessedAt: { state: 'missing' }, fieldRefs: [] };
            for (const [field, nodeName] of Object.entries(map)) {
                const v = raw[nodeName];
                if (v === undefined)
                    continue;
                const ref = jsonRef(sourceId, prefix + '/' + nodeName, j.nodes, offsets);
                requestJsonExcerpt(ctx, ref, j.nodes, offsets);
                let p: Presence<any>;
                if (field === 'sizeBytes') {
                    if (!integer(v))
                        throw new SafeFailure('CACHE_ENTRY_SCHEMA_INVALID');
                    p = { state: 'value', value: v };
                }
                else {
                    if (field === 'providerId' && integer(v))
                        p = sanitizeSourceText(ctx, String(v), ref);
                    else {
                        if (typeof v !== 'string')
                            throw new SafeFailure('CACHE_ENTRY_SCHEMA_INVALID');
                        if (field === 'key')
                            check(Array.from(v).length, LIMITS.key, 'KEY_LIMIT');
                        if ((field === 'createdAt' || field === 'lastAccessedAt') && !validTime(v))
                            throw new SafeFailure('CACHE_TIME_INVALID');
                        p = sanitizeSourceText(ctx, v, ref);
                    }
                }
                Object.assign(entry, { [field]: p });
                entry.fieldRefs.push({ field: field as CacheEntry['fieldRefs'][number]['field'], refs: [ref] });
            }
            result.entries.push(entry);
        });
        let duplicate = false;
        const byProvider = new Map<string, CacheEntry[]>();
        for (const e of result.entries) {
            if (e.providerId.state === 'value') {
                const prior = byProvider.get(e.providerId.value) ?? [];
                prior.push(e);
                byProvider.set(e.providerId.value, prior);
            }
        }
        for (const es of byProvider.values())
            if (es.length > 1) {
                duplicate = true;
                const different = es.some(e => JSON.stringify([e.key, e.version, e.ref]) !== JSON.stringify([es[0]!.key, es[0]!.version, es[0]!.ref]));
                result.diagnostics.push(diagnostic(different ? 'CACHE_PROVIDER_CONFLICT' : 'CACHE_PROVIDER_DUPLICATE', 'cache-list', 'conflict', es.flatMap(e => e.fieldRefs.filter(f => f.field === 'providerId').flatMap(f => f.refs))));
            }
        const p = result.pagination;
        const expected = p.expectedCount.state === 'value' ? p.expectedCount.value : undefined;
        const all = p.allPages.state === 'value' ? p.allPages.value : undefined;
        if (duplicate || typeof total === 'number' && total < list.length || typeof total === 'number' && expected !== undefined && total !== expected || expected !== undefined && expected < list.length) {
            p.state = 'conflict';
            result.diagnostics.push(diagnostic('CACHE_COUNT_CONFLICT', 'cache-list', 'conflict', p.refs));
        }
        else if (all === false || typeof total === 'number' && total > list.length || expected !== undefined && expected > list.length)
            p.state = 'incomplete';
        else if (all === true && (expected ?? total) === list.length && result.entries.every(e => e.providerId.state === 'value') && Object.values(result.scope).every(p => p.state === 'value'))
            p.state = 'complete';
        return result;
    });
}
