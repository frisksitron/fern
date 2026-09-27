import { Option, Schema } from 'effect';
import { readApiError } from '$lib/shared/contracts/api-error';
import { ScanEvent, ScanRun, ScanStatusResponse, StartScanResponse, type ScanState } from '$lib/shared/contracts/scans';

type ScanProgress = {
  state: ScanState;
  /** Why the scan is retrying or failed. */
  message: string | null;
  /** The root being walked, while the scan runs. */
  currentRootId: string | null;
  currentPath: string | null;
  filesSeen: number;
  videosSeen: number;
  audioSeen: number;
  errorsCount: number;
};

const decodeStatus = Schema.decodeUnknownOption(ScanStatusResponse);
const decodeStarted = Schema.decodeUnknownOption(StartScanResponse);
const decodeSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(ScanRun));
const decodeEvent = Schema.decodeUnknownOption(ScanEvent);

const liveEventNames = ScanEvent.members.map((member) => member.fields.type.literal);

function fromRun(scan: ScanRun): ScanProgress {
  return {
    state: scan.state,
    message: scan.state === 'retrying' || scan.state === 'failed' ? scan.errorSummary : null,
    currentRootId: scan.currentRootId,
    currentPath: scan.currentPath,
    filesSeen: scan.filesSeen,
    videosSeen: scan.videosSeen,
    audioSeen: scan.audioSeen,
    errorsCount: scan.errorsCount,
  };
}

/** The progress after a live event. Warnings concern one root and do not change the scan's state. */
function applyEvent(progress: ScanProgress, event: ScanEvent): ScanProgress {
  switch (event.type) {
    case 'scan.started':
      return { ...progress, state: 'running', message: null };
    case 'scan.progress':
      return {
        ...progress,
        ...event.data,
        currentRootId: event.data.rootId,
        currentPath: event.data.currentDisplayPath,
        message: null,
      };
    case 'scan.warning':
      return progress;
    case 'scan.retrying':
      return { ...progress, state: 'retrying', message: event.data.message, currentPath: null };
    case 'scan.completed':
      return { ...progress, ...event.data, message: null, currentRootId: null, currentPath: null };
    case 'scan.failed':
      return { ...progress, state: 'failed', message: event.data.message, currentRootId: null, currentPath: null };
  }
}

const queued: ScanProgress = {
  state: 'queued',
  message: null,
  currentRootId: null,
  currentPath: null,
  filesSeen: 0,
  videosSeen: 0,
  audioSeen: 0,
  errorsCount: 0,
};

/** The library scan shown on the media settings page, followed through its server-sent events. */
export class LibraryScan {
  progress = $state<ScanProgress | null>(null);
  rootId = $state<string | null>(null);
  error = $state('');
  #events: EventSource | null = null;

  get running() {
    const state = this.progress?.state;
    return state === 'queued' || state === 'running' || state === 'retrying';
  }

  /** Shows the active scan, if any, and follows it. */
  async restore() {
    const response = await fetch('/api/scans');
    if (!response.ok) return;
    const status = Option.getOrNull(decodeStatus(await response.json().catch(() => null)));
    if (!status?.scan) return;
    this.progress = fromRun(status.scan);
    this.rootId = status.scan.rootId;
    this.connect(status.scan.id);
  }

  async start(rootId?: string) {
    this.error = '';
    const response = await fetch('/api/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootId }),
    });
    const body: unknown = await response.json().catch(() => null);
    const started = response.ok ? Option.getOrNull(decodeStarted(body)) : null;
    if (!started) {
      this.error = readApiError(body)?.message ?? 'Could not start scan.';
      return;
    }
    this.rootId = rootId ?? null;
    this.progress = queued;
    this.connect(started.scanId);
  }

  stop() {
    this.#events?.close();
    this.#events = null;
  }

  private connect(scanId: string) {
    this.stop();
    const events = new EventSource(`/api/scans/${scanId}/events`);
    this.#events = events;
    const update = (next: ScanProgress) => {
      if (this.#events !== events) return;
      this.progress = next;
      // The server closes the stream once the scan is finished; close first so EventSource does not reconnect.
      if (!this.running) this.stop();
    };
    events.addEventListener('scan.snapshot', (message) => {
      const scan = Option.getOrNull(decodeSnapshot((message as MessageEvent<string>).data));
      if (scan) update(fromRun(scan));
    });
    for (const type of liveEventNames) {
      events.addEventListener(type, (message) => {
        let data: unknown;
        try {
          data = JSON.parse((message as MessageEvent<string>).data);
        } catch {
          return;
        }
        const event = Option.getOrNull(decodeEvent({ type, data }));
        if (event) update(applyEvent(this.progress ?? queued, event));
      });
    }
  }
}
