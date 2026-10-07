import { open, rename, link } from 'node:fs/promises';
import type { OutputPermit, OutputPayload } from './input.ts';
import { beginOutputSession, outputSessionPlan, registerOutputHandle, sealOutputHandle, validateOutputSession, commitOutputHandle, cleanupOutputSession } from './input.ts';
import type { Result } from './model.ts';
import { fail, ok } from './safety.ts';
/** Writes a fixed payload snapshot through a single-use, identity-checked permit. */
export async function writeOutputs(permit: OutputPermit, payloads: OutputPayload[]): Promise<Result<null>> {
    const started = beginOutputSession(permit, payloads);
    if (!started.ok)
        return started;
    const session = started.value;
    let committed = 0;
    const failed = (r: Result<unknown>): Result<null> => committed ? fail('PARTIAL_OUTPUT', 'output', 'io') : r as Result<null>;
    try {
        const plan = outputSessionPlan(session);
        if (!plan.ok)
            return plan;
        let checked = await validateOutputSession(session);
        if (!checked.ok)
            return checked;
        for (let i = 0; i < plan.value.entries.length; i++) {
            const entry = plan.value.entries[i]!, path = plan.value.staging[i]!;
            checked = await validateOutputSession(session);
            if (!checked.ok)
                return failed(checked);
            const handle = await open(path, 'wx+', 0o600);
            const registered = await registerOutputHandle(session, i, handle);
            if (!registered.ok) {
                await handle.close();
                return failed(registered);
            }
            await handle.writeFile(plan.value.payloads[i]!.utf8);
            await handle.sync();
            const sealed = await sealOutputHandle(session, i);
            if (!sealed.ok)
                return failed(sealed);
            checked = await validateOutputSession(session);
            if (!checked.ok)
                return failed(checked);
            // link is an exclusive-create publication: an intervening destination is never overwritten.
            // Existing destinations use same-directory atomic rename after identity revalidation.
            if (entry.mode === 'exclusive-create')
                await link(path, entry.canonicalPath);
            else
                await rename(path, entry.canonicalPath);
            committed++;
            const published = await commitOutputHandle(session, i);
            if (!published.ok)
                return failed(published);
            checked = await validateOutputSession(session);
            if (!checked.ok)
                return failed(checked);
        }
        return ok(null);
    }
    catch {
        return fail(committed ? 'PARTIAL_OUTPUT' : 'OUTPUT_WRITE_FAILED', 'output', 'io');
    }
    finally {
        await cleanupOutputSession(session);
    }
}
