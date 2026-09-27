import { Layer, Logger, References } from 'effect';
import type { AppConfig } from './config';

/**
 * The application's logger: JSON lines for production (each entry carries its annotations, such
 * as requestId, scanId, jobId, sessionId, and program, as fields) or pretty output for terminals.
 */
export function loggingLayer(config: Pick<AppConfig, 'LOG_FORMAT' | 'LOG_LEVEL'>) {
  return Layer.mergeAll(
    Logger.layer([config.LOG_FORMAT === 'json' ? Logger.consoleJson : Logger.consolePretty()]),
    Layer.succeed(References.MinimumLogLevel, config.LOG_LEVEL),
  );
}
