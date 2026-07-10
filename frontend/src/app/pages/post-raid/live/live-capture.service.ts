/**
 * Live slice runtime shell + its pure clip-correlation functions, colocated. The
 * `wl-live-controls`, `wl-clip-panel`, and `wl-clip-player` components inject only it.
 * It owns three concerns:
 *
 *  1. Recording engine - `getDisplayMedia` + a per-segment `MediaRecorder` rolling
 *     buffer, MSE clip assembly for playback, and single-file WebM export by remux.
 *  2. Live-sync toggle + status the controls strip renders (the page owns the polling).
 *  3. Clip flyover state - panel open/close, the current `ClipHandle`, and the
 *     correlation context captured from `prepare`.
 *
 * Clips are session-scoped: a resolved clip is memoized in memory and nothing is
 * written to disk.
 */
import { Injectable, computed, signal } from '@angular/core';
import {
  BlobSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, Output, WEBM, WebMOutputFormat,
} from 'mediabunny';
import { WclFight } from '../../../core/models/wcl.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { logWarn } from '../../../core/log';

/* ------------------------- slice-private data shapes ----------------------- */
/* Only `ClipAnchor`, the shape cards emit across the layer boundary, lives in
 * core/models. All wall-clock fields are unix-epoch milliseconds: recorder and WCL
 * timeline share one clock, so `report.startTime + fight.startTime` maps directly onto
 * a segment's `start`/`end` with no skew term. */

/** Capture quality knobs passed to `getDisplayMedia` + `MediaRecorder`. */
export interface CaptureProfile {
  codec: 'vp9' | 'vp8';
  maxHeight: number;
  fps: number;
  bitrateBps: number;
}

/** One finalized WebM segment of the rolling buffer, tagged with wall-clock bounds. */
export interface Segment {
  idx: number;
  start: number;
  end: number;
  blob: Blob;
}

/** A wall-clock span to cut a clip for, plus a stable key for the clip memo. */
export interface ClipWindow {
  fromMs: number;
  toMs: number;
  key: string;
}

/**
 * A resolved clip ready to play: the ordered segment blobs to stitch (via MSE) plus the
 * loop bounds within the assembled timeline. Playback loops over
 * `[startOffsetS, endOffsetS]`, the requested window trimmed from the whole-segment footage.
 */
export interface ClipHandle {
  blobs: Blob[];
  startOffsetS: number;
  endOffsetS: number;
  mimeType: string;
}

/** Pre/post roll (ms) added around a window so the moment has lead-in and tail. */
export interface ClipRoll {
  preMs: number;
  postMs: number;
}

/** Default capture profile: VP9 (VP8 fallback), 1080p / 30 fps / ~4 Mbps. */
export const DEFAULT_CAPTURE_PROFILE: CaptureProfile = {
  codec: 'vp9',
  maxHeight: 1080,
  fps: 30,
  bitrateBps: 4_000_000,
};

/**
 * Restart the recorder every `SEG_MS` so each segment is an independently decodable
 * WebM (a single continuous recorder with `timeslice` cannot be assembled via MSE).
 */
export const SEG_MS = 3_000;

/** Rolling-buffer retention: covers the longest fight plus WCL upload lag plus pre-roll. */
export const BUFFER_MS = 12 * 60 * 1_000;

/** Roll around a point-in-time anchor (a single cast). Window anchors use exact bounds. */
export const POINT_CLIP_ROLL: ClipRoll = { preMs: 5_000, postMs: 5_000 };
/** No roll: a window anchor plays exactly its own span. */
export const NO_CLIP_ROLL: ClipRoll = { preMs: 0, postMs: 0 };

/** Grace period before a downloaded clip's object URL is revoked, so the browser can read the blob. */
const DOWNLOAD_URL_TTL_MS = 10_000;

/* ----------------------------- pure functions ----------------------------- */

/** Absolute wall-clock start (unix epoch ms) of a bench offset. */
export function absoluteWindowStart(reportStartTime: number, fightStartTime: number, timeS: number): number {
  return reportStartTime + fightStartTime + timeS * 1000;
}

/** Map each bench window to an absolute wall-clock `ClipWindow`, widened by pre/post roll. */
export function buildClipWindows(
  reportStartTime: number, fightStartTime: number, windows: ClipAnchor[], roll: ClipRoll,
): ClipWindow[] {
  return windows.map(window => {
    const absStart = absoluteWindowStart(reportStartTime, fightStartTime, window.timeS);
    return {
      fromMs: absStart - roll.preMs,
      toMs: absStart + window.windowLengthS * 1000 + roll.postMs,
      key: window.key,
    };
  });
}

/** The whole-fight wall-clock window (unix epoch ms) whose segments make up a full-pull clip. */
export function fullPullWindow(reportStartTime: number, fightStartTime: number, fightEndTime: number): ClipWindow {
  return { fromMs: reportStartTime + fightStartTime, toMs: reportStartTime + fightEndTime, key: 'full-pull' };
}

/** Segments overlapping `[fromMs, toMs]`, sorted by start. Half-open on neither end (any touch counts). */
export function selectSegments(segments: Segment[], window: ClipWindow): Segment[] {
  return segments
    .filter(segment => segment.end > window.fromMs && segment.start < window.toMs)
    .sort((a, b) => a.start - b.start);
}

/**
 * Seconds to seek into an assembled clip so playback starts at the window start. The
 * assembled timeline re-bases to 0 at the first segment's start. Never negative.
 */
export function segmentSeekOffset(window: ClipWindow, firstSegment: { start: number } | undefined): number {
  if (!firstSegment) return 0;
  return Math.max(0, (window.fromMs - firstSegment.start) / 1000);
}

/**
 * Total wall-clock time lost to the recorder-restart gaps between consecutive segments.
 * The assembled timeline is gapless, so a loop length from a wall-clock span shrinks by
 * this much to end on the same footage.
 */
export function interSegmentGapMs(segments: { start: number; end: number }[]): number {
  let gaps = 0;
  for (let i = 1; i < segments.length; i++) gaps += Math.max(0, segments[i].start - segments[i - 1].end);
  return gaps;
}

/** Whether the buffer's covered span overlaps `[fromMs, toMs]` at all. */
export function segmentsCover(segments: Segment[], fromMs: number, toMs: number): boolean {
  return segments.some(segment => segment.end > fromMs && segment.start < toMs);
}

/* --------------------------- media type helpers --------------------------- */

/**
 * Most specific supported recording mime: profile codec, then VP8, then bare WebM. MSE
 * assembly re-declares this via `addSourceBuffer`, which rejects bare `video/webm`, so a
 * codec-qualified pick keeps playback on the MSE path.
 */
function mimeFor(profile: CaptureProfile): string {
  const candidates = [`video/webm;codecs=${profile.codec}`, 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? 'video/webm';
}

/**
 * Whether a `getDisplayMedia` rejection is the user dismissing the picker (a benign no-op),
 * as opposed to a real failure worth surfacing. The picker-cancel and permission-deny paths
 * both reject with a `NotAllowedError`.
 */
function isPickerDismissal(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotAllowedError';
}

/* ----------------------------- feature service ---------------------------- */

@Injectable({ providedIn: 'root' })
export class LiveCaptureFeatureService {
  // Live-sync on/off. Lives here because this is the only service that reads it.
  private readonly liveActive = signal(false);

  // --- recording engine state ---
  readonly isCapturing = signal(false);
  readonly isStarting = signal(false);
  readonly sourceLabel = signal('');
  readonly captureProfile = signal<CaptureProfile>(DEFAULT_CAPTURE_PROFILE);
  /** Non-null when recording could not start or stopped unexpectedly; the controls strip renders it. */
  readonly captureError = signal<string | null>(null);
  /** Non-null when the last clip export failed; the clip player renders it next to the button. */
  readonly downloadError = signal<string | null>(null);

  /**
   * Drives the record toggle's `checked`. Includes `isStarting` so a cancelled picker
   * moves the bound value (true while open, false on dismiss), forcing Material to reset
   * the switch - a plain `isCapturing` binding stays false and never re-writes it.
   */
  readonly recordToggleOn = computed(() => this.isCapturing() || this.isStarting());

  private stream: MediaStream | null = null;
  private recording = false;
  private readonly segments = signal<Segment[]>([]);
  private segIdx = 0;
  private mimeType = 'video/webm';

  // --- live-sync toggle + status (rendered by wl-live-controls) ---
  readonly liveEnabled = this.liveActive.asReadonly();
  readonly status = signal('');

  // --- clip flyover state ---
  readonly open = signal(false);
  readonly handle = signal<ClipHandle | null>(null);
  /** True once the clip player's `<video>` fails to decode (MSE assembly and the single-blob fallback both failed). */
  readonly playbackFailed = signal(false);

  private readonly ctx = signal<{ reportCode: string; reportStartTime: number; fight: WclFight } | null>(null);
  private currentAnchor: ClipAnchor | null = null;
  /** Clips already cut this session, keyed `reportCode:fightId:windowKey`; keeps a window openable after the buffer rolls past it. */
  private readonly resolved = new Map<string, ClipHandle>();

  setLive(on: boolean): void { this.liveActive.set(on); }
  setStatus(message: string): void { this.status.set(message); }

  /* ------------------------- recording engine ---------------------------- */

  /** Opt in to recording: prompt for a window, then run the rolling-buffer loop. */
  async startRecording(profile: CaptureProfile = DEFAULT_CAPTURE_PROFILE): Promise<void> {
    if (this.recording || this.isStarting()) return;
    // Insecure context or an unsupported browser leaves `getDisplayMedia` absent; say so rather than fail silently.
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.captureError.set('screen recording is not available in this browser');
      return;
    }
    this.captureError.set(null);
    this.isStarting.set(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const [track] = stream.getVideoTracks();
      await track.applyConstraints({ width: { max: 1920 }, height: { max: profile.maxHeight }, frameRate: { max: profile.fps } });
      this.stream = stream;
      this.captureProfile.set(profile);
      this.mimeType = mimeFor(profile);
      this.sourceLabel.set(track.label || 'your screen');
      // Sharing stopped from the browser UI (or the window closed) ends capture cleanly.
      track.addEventListener('ended', () => this.stopRecording());
      this.recording = true;
      this.isCapturing.set(true);
      this.cycleSegment();
    } catch (err) {
      // Tear down any half-started capture (an unsupported recorder throws after the stream opens) so the toggle never sticks on "Recording".
      stream?.getTracks().forEach(track => track.stop());
      this.stream = null;
      this.recording = false;
      this.isCapturing.set(false);
      this.sourceLabel.set('');
      // A dismissed picker is benign; a real failure (unsupported codec, denied by policy) surfaces so the user learns why nothing records.
      if (!isPickerDismissal(err)) this.captureError.set('recording could not start');
      logWarn('LiveCaptureFeatureService.startRecording', err);
    } finally {
      this.isStarting.set(false);
    }
  }

  /** Stop recording and release the display stream; the buffer is kept so covered fights stay clip-able. */
  stopRecording(): void {
    this.recording = false;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.isCapturing.set(false);
    this.sourceLabel.set('');
  }

  /**
   * Record one `SEG_MS` segment, then roll into the next. Each segment is a complete
   * WebM (own header + keyframe) so it appends cleanly during MSE assembly.
   */
  private cycleSegment(): void {
    if (!this.recording || !this.stream) return;
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(this.stream, { mimeType: this.mimeType, videoBitsPerSecond: this.captureProfile().bitrateBps });
    const start = Date.now();
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    // A runtime encoder failure would otherwise stall the buffer silently: surface it and tear the recording down.
    recorder.onerror = event => {
      logWarn('LiveCaptureFeatureService.cycleSegment', event);
      this.captureError.set('recording stopped unexpectedly');
      this.stopRecording();
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: this.mimeType });
      const cutoff = Date.now() - BUFFER_MS;
      // Only a segment with footage counts toward clip coverage; a zero-byte blob cannot decode.
      if (blob.size) {
        const segment: Segment = { idx: this.segIdx++, start, end: Date.now(), blob };
        this.segments.update(buffer => [...buffer.filter(existing => existing.end >= cutoff), segment]);
      }
      if (this.recording) this.cycleSegment();
    };
    recorder.start();
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, SEG_MS);
  }

  /* --------------------------- clip flyover ------------------------------ */

  /**
   * Capture the correlation context for the resolved fight so a clip button can map a
   * bench offset to buffer time. Called from the page on every newly resolved fight.
   */
  prepare(reportCode: string, reportStartTime: number, fight: WclFight): void {
    this.ctx.set({ reportCode, reportStartTime, fight });
  }

  /** True once the rolling buffer covers the prepared fight. Drives the `showClip` gate. */
  readonly clipReady = computed(() => {
    const ctx = this.ctx();
    if (!ctx) return false;
    const fightFrom = ctx.reportStartTime + ctx.fight.startTime;
    const fightTo = ctx.reportStartTime + ctx.fight.endTime;
    return segmentsCover(this.segments(), fightFrom, fightTo);
  });

  /** Open the clip panel at an anchor emitted by a card: resolve the clip, then show it. */
  openClip(anchor: ClipAnchor): void {
    this.currentAnchor = anchor;
    this.open.set(true);
    this.downloadError.set(null);
    this.playbackFailed.set(false);
    const ctx = this.ctx();
    if (!ctx) {
      this.handle.set(null);
      logWarn(`LiveCaptureFeatureService.openClip ${anchor.key}`, 'no correlation context (report not resolved)');
      return;
    }
    this.handle.set(this.resolveHandle(ctx.reportCode, ctx.fight.id, this.clipWindowFor(anchor)));
  }

  /** Export the clip currently in the player to one downloadable WebM file. */
  download(): void {
    const anchor = this.currentAnchor;
    const handle = this.handle();
    if (!anchor || !handle) return;
    void this.saveSegments(handle.blobs, `${anchor.key}.webm`);
  }

  /** Export the whole prepared fight from the rolling buffer to one downloadable WebM file. */
  downloadFullPull(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const segments = selectSegments(this.segments(), fullPullWindow(ctx.reportStartTime, ctx.fight.startTime, ctx.fight.endTime));
    void this.saveSegments(segments.map(segment => segment.blob), 'full-pull.webm');
  }

  /** Remux the buffered segments into one seekable WebM and save it. No re-encode, so it stays near-instant. */
  private async saveSegments(blobs: Blob[], filename: string): Promise<void> {
    this.downloadError.set(null);
    if (!blobs.length) {
      this.downloadError.set('Download failed.');
      logWarn('LiveCaptureFeatureService.saveSegments', `no footage for ${filename}`);
      return;
    }
    try {
      this.triggerDownload(await remuxSegments(blobs), filename);
    } catch (err) {
      this.downloadError.set('Download failed.');
      logWarn('LiveCaptureFeatureService.saveSegments', err);
    }
  }

  /** The clip player's `<video>` could not decode the assembled footage; flip to the dead-clip message. */
  onPlaybackError(): void {
    logWarn('LiveCaptureFeatureService.onPlaybackError', this.currentAnchor?.key ?? '');
    this.playbackFailed.set(true);
  }

  close(): void { this.open.set(false); }

  /** Drop the flyover context and memoized clips (a new analysis); recording is independent and untouched. */
  clear(): void {
    this.open.set(false);
    this.handle.set(null);
    this.ctx.set(null);
    this.currentAnchor = null;
    this.resolved.clear();
    this.downloadError.set(null);
    this.playbackFailed.set(false);
  }

  private clipWindowFor(anchor: ClipAnchor): ClipWindow {
    const { reportStartTime, fight } = this.ctx()!;
    // A window plays its exact span; a point-in-time cast gets pre/post roll for context.
    const roll: ClipRoll = anchor.windowLengthS > 0 ? NO_CLIP_ROLL : POINT_CLIP_ROLL;
    const [window] = buildClipWindows(reportStartTime, fight.startTime, [anchor], roll);
    return window;
  }

  /** Serve a memoized cut, or cut the window from the rolling buffer and memoize it. */
  private resolveHandle(reportCode: string, fightId: number, window: ClipWindow): ClipHandle | null {
    const key = `${reportCode}:${fightId}:${window.key}`;
    const cached = this.resolved.get(key);
    if (cached) return cached;
    const segments = selectSegments(this.segments(), window);
    if (!segments.length) return null;
    const handle = this.handleFor(window, segments);
    this.resolved.set(key, handle);
    return handle;
  }

  /**
   * Build the playable handle: the loop starts where the window begins inside the first
   * segment and ends one window-span later, trimming the whole-segment footage to the
   * requested window. The recorder-restart gaps are subtracted since the wall-clock span
   * spans them but the assembled timeline does not.
   */
  private handleFor(window: ClipWindow, segments: Segment[]): ClipHandle {
    const startOffsetS = segmentSeekOffset(window, segments[0]);
    const loopSpanS = (window.toMs - window.fromMs - interSegmentGapMs(segments)) / 1000;
    return {
      blobs: segments.map(segment => segment.blob),
      startOffsetS,
      endOffsetS: startOffsetS + Math.max(0, loopSpanS),
      mimeType: this.mimeType,
    };
  }

  private triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    // Revoking synchronously can invalidate the URL before the browser reads the blob.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
  }
}

/**
 * Stitch the ordered segment blobs into `video` via MSE in `sequence` mode, which re-bases
 * each segment's timecodes so the assembled timeline starts at 0. The MediaSource only
 * reaches `sourceopen` once attached, so the URL is set on `video` first, then the buffers
 * appended, then the URL revoked (the element keeps the MediaSource alive). Falls back to a
 * concatenated single-blob src if any append throws.
 */
export async function pipeIntoElement(video: HTMLVideoElement, blobs: Blob[], mimeType: string): Promise<void> {
  releaseElement(video);
  try {
    const source = new MediaSource();
    const attachUrl = URL.createObjectURL(source);
    video.src = attachUrl;
    await onceOpen(source);
    URL.revokeObjectURL(attachUrl);
    const buffer = source.addSourceBuffer(mimeType);
    buffer.mode = 'sequence';
    for (const blob of blobs) await appendAndWait(buffer, await blob.arrayBuffer());
    source.endOfStream();
  } catch (err) {
    logWarn('pipeIntoElement: MSE assembly failed, falling back to single-blob src', err);
    video.src = URL.createObjectURL(new Blob(blobs, { type: mimeType }));
  }
}

/**
 * Stitch the independently-recorded WebM segments into one continuous, seekable WebM by remuxing,
 * no re-encode. Each segment is a self-contained WebM whose clusters restart at 0, so a plain blob
 * concat repeats the header and timeline and players read only the first segment's ~SEG_MS. Here each
 * segment's encoded packets are re-timed onto one gapless timeline (offset by the running duration) and
 * written to a single output, so the file plays and seeks its full length while staying near-instant.
 */
export async function remuxSegments(blobs: Blob[]): Promise<Blob> {
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  let source: EncodedVideoPacketSource | null = null;
  // The decoder config only needs to ride the first packet; every segment shares one codec.
  let firstMeta: Parameters<EncodedVideoPacketSource['add']>[1];
  let timeOffset = 0;
  for (const blob of blobs) {
    const track = await new Input({ formats: [WEBM], source: new BlobSource(blob) }).getPrimaryVideoTrack();
    if (!track) continue;
    if (!source) {
      source = new EncodedVideoPacketSource(track.codec ?? 'vp8');
      output.addVideoTrack(source);
      await output.start();
      const config = await track.getDecoderConfig();
      firstMeta = config ? { decoderConfig: config } : undefined;
    }
    let segmentEnd = 0;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      await source.add(packet.clone({ timestamp: packet.timestamp + timeOffset }), firstMeta);
      firstMeta = undefined;
      segmentEnd = Math.max(segmentEnd, packet.timestamp + packet.duration);
    }
    timeOffset += segmentEnd;
  }
  if (!source) throw new Error('no decodable video track in the buffered segments');
  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer) throw new Error('remux produced no output');
  return new Blob([buffer], { type: 'video/webm' });
}

/** Revoke a media element's blob src (a no-op for an already-revoked or non-blob src). */
export function releaseElement(video: HTMLVideoElement): void {
  if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
}

/** Resolve once a `MediaSource` reaches `sourceopen`. */
function onceOpen(source: MediaSource): Promise<void> {
  return new Promise(resolve => source.addEventListener('sourceopen', () => resolve(), { once: true }));
}

/** Append one buffer and resolve on `updateend` (SourceBuffer appends are async). */
function appendAndWait(buffer: SourceBuffer, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    buffer.addEventListener('updateend', () => resolve(), { once: true });
    buffer.addEventListener('error', () => reject(new Error('append failed')), { once: true });
    buffer.appendBuffer(data);
  });
}
