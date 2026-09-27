import { Zero } from '@rocicorp/zero';
import { env } from '$env/dynamic/public';
import { schema } from '$lib/zero/schema';
import { mutators } from '$lib/zero/mutators';

type FernZero = Zero<typeof schema>;
type FernMutation = Parameters<FernZero['mutate']>[0];
type MutationTarget = 'client' | 'server';

let instance: FernZero | undefined;

export function createId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getZero(): FernZero {
  if (!instance) {
    const cacheURL = new URL(env.PUBLIC_ZERO_URL || '/zero', window.location.origin).href;
    instance = new Zero<typeof schema>({
      cacheURL,
      schema,
      mutators,
      storageKey: 'fern',
    });
  }
  return instance;
}

export async function mutate(request: FernMutation, target: MutationTarget = 'client'): Promise<void> {
  const result = await getZero().mutate(request)[target];
  if (result.type === 'error') throw new Error(result.error.message);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void instance?.close();
    instance = undefined;
  });
}
