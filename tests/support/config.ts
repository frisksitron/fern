import { Layer } from 'effect';
import { FernConfig } from '../../src/lib/server/config';

/** `FernConfig` from test values, with defaults for everything else. */
export function testConfig(values: Record<string, string> = {}) {
  return FernConfig.layerFrom(values).pipe(Layer.orDie);
}
