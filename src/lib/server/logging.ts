import { Effect, Layer, Logger, References } from 'effect';
import { FernConfig } from './config';

/**
 * The application's logger: JSON lines for production (each entry carries its annotations, such
 * as requestId, scanId, jobId, sessionId, and program, as fields) or pretty output for terminals.
 */
export const loggingLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* FernConfig.Service;
    return Layer.mergeAll(
      Logger.layer([config.LOG_FORMAT === 'json' ? Logger.consoleJson : Logger.consolePretty()]),
      Layer.succeed(References.MinimumLogLevel, config.LOG_LEVEL),
    );
  }),
);
