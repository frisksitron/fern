import { Schema } from 'effect';

export class ScanNotFound extends Schema.TaggedError<ScanNotFound>()('ScanNotFound', { id: Schema.String }) {}

/** Scans run one at a time; `scanId` is the active scan when it is known. */
export class ScanAlreadyRunning extends Schema.TaggedError<ScanAlreadyRunning>()('ScanAlreadyRunning', {
  scanId: Schema.NullOr(Schema.String),
}) {}
