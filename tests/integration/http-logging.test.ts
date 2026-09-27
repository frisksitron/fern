import { Data, Effect, Logger, ManagedRuntime, References } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { respondOn } from '../../src/lib/server/http';
import type { PublicError } from '../../src/lib/server/public-errors';

class Missing extends Data.TaggedError('Missing')<object> {}
class Unavailable extends Data.TaggedError('Unavailable')<object> {}

type Entry = { level: string; message: unknown; annotations: Record<string, unknown> };

function recordingRuntime() {
  const entries: Entry[] = [];
  const logger = Logger.make((options) => {
    entries.push({
      level: options.logLevel,
      message: options.message,
      annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
    });
  });
  const runtime = ManagedRuntime.make(Logger.layer([logger]));
  return { entries, runtime };
}

const failure = (error: Missing | Unavailable): PublicError =>
  error._tag === 'Missing'
    ? { status: 404, code: 'media.not_found', message: 'Not found.' }
    : { status: 503, code: 'database.unavailable', message: 'Try again.' };

const request = (init: RequestInit = {}) => new Request('http://fern.test/api/thing', init);
const runtimes: ManagedRuntime.ManagedRuntime<never, never>[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe('respond', () => {
  function setup() {
    const recording = recordingRuntime();
    runtimes.push(recording.runtime);
    return recording;
  }

  it('answers expected client errors without logging them', async () => {
    const { runtime, entries } = setup();
    const response = await respondOn(runtime, request(), Effect.fail(new Missing()), {
      success: () => new Response(),
      failure,
    });
    expect(response.status).toBe(404);
    expect(entries).toEqual([]);
  });

  it('logs server-side failures as warnings with the request ID', async () => {
    const { runtime, entries } = setup();
    const response = await respondOn(
      runtime,
      request({ headers: { 'x-request-id': 'probe-17' } }),
      Effect.fail(new Unavailable()),
      { success: () => new Response(), failure },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('probe-17');
    expect(entries).toMatchObject([
      {
        level: 'Warn',
        annotations: { requestId: 'probe-17', method: 'GET', path: '/api/thing', status: 503, error: 'Unavailable' },
      },
    ]);
  });

  it('logs defects as errors and hides them from the client', async () => {
    const { runtime, entries } = setup();
    const response = await respondOn(runtime, request(), Effect.die(new Error('bug')), {
      success: () => new Response(),
      failure,
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: 'internal', message: 'Something went wrong.' });
    expect(entries.map((entry) => entry.level)).toEqual(['Error']);
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not treat a request the client abandoned as a server failure', async () => {
    const { runtime, entries } = setup();
    const controller = new AbortController();
    const pending = respondOn(runtime, request({ signal: controller.signal }), Effect.never, {
      success: () => new Response(),
      failure,
    });
    controller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(entries).toEqual([]);
  });

  it('replaces request IDs that are not safe to log', async () => {
    const { runtime } = setup();
    const response = await respondOn(
      runtime,
      request({ headers: { 'x-request-id': 'bad id <script>' } }),
      Effect.succeed('ok'),
      { success: (value) => new Response(value), failure },
    );
    expect(response.headers.get('x-request-id')).not.toContain('bad');
  });
});
