import { Layer } from 'effect';
import { FernConfig, loadConfig } from '../../src/lib/server/config';

/** A `FernConfig` layer parsed from test values, with defaults for everything else. */
export function testConfig(values: Record<string, string> = {}) {
  return Layer.succeed(FernConfig, loadConfig(values));
}
