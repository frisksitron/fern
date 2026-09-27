import type { ScanState } from '$lib/shared/contracts/scans';

/** Every legal scan-state change. Any other transition is a programming error. */
const transitions: Readonly<Record<ScanState, readonly ScanState[]>> = {
  queued: ['running', 'failed'],
  // `queued` again when a graceful shutdown hands the scan back without using up an attempt.
  running: ['completed', 'retrying', 'queued', 'failed'],
  retrying: ['running', 'failed'],
  completed: [],
  failed: [],
};

/** States that occupy the single active-scan slot (see the scan_single_active index). */
export const activeScanStates: readonly ScanState[] = ['queued', 'running', 'retrying'];

export function isTerminalScanState(state: ScanState) {
  return transitions[state].length === 0;
}

export function canTransition(from: ScanState, to: ScanState) {
  return transitions[from].includes(to);
}

/** The states a scan may be in immediately before entering `to`. */
export function statesBefore(to: ScanState): ScanState[] {
  return (Object.keys(transitions) as ScanState[]).filter((from) => canTransition(from, to));
}
