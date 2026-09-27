import { Data } from 'effect';

export class ScanNotFound extends Data.TaggedError('ScanNotFound')<{ readonly id: string }> {}

/** Scans run one at a time; `scanId` is the active scan when it is known. */
export class ScanAlreadyRunning extends Data.TaggedError('ScanAlreadyRunning')<{ readonly scanId: string | null }> {}
