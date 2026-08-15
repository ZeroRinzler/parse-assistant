/** Clips are session-scoped: a resolved clip is memoized in memory and nothing is written to disk. */
import { Injectable, computed, signal } from '@angular/core';
import type { EncodedVideoPacketSource as PacketSource } from 'mediabunny';
import { WclFight } from '../../../core/models/wcl.models';
import { ClipAnchor } from '../../../core/models/capture.models';
import { logWarn } from '../../../core/log';

// All wall-clock fields are unix-epoch milliseconds, so `report.startTime + fight.startTime` maps directly onto a segment.

export interface CaptureProfile {
  codec: 'vp9' | 'vp8';
  maxHeight: number;
  fps: number;
  bitrateBps: number;
}

export interface Segment {
  idx: number;
  start: number;
  end: number;
  blob: Blob;
}

export interface ClipWindow {
  fromMs: number;
  toMs: number;
  key: string;
}

export interface ClipHandle {
  blobs: Blob[];
  startOffsetS: number;
  endOffsetS: number;
  mimeType: string;
}

export interface ClipRoll {
  preMs: number;
  postMs: number;
}

export const DEFAULT_CAPTURE_PROFILE: CaptureProfile = {
  codec: 'vp9',
  maxHeight: 1080,
  fps: 30,
  bitrateBps: 4_000_000,
};

/** A single continuous recorder with `timeslice` cannot be assembled via MSE. */
export const SEG_MS = 3_000;

/** Rolling-buffer retention: covers the longest fight plus WCL upload lag plus pre-roll. */
export const BUFFER_MS = 12 * 60 * 1_000;

export const POINT_CLIP_ROLL: ClipRoll = { preMs: 5_000, postMs: 5_000 };
export const NO_CLIP_ROLL: ClipRoll = { preMs: 0, postMs: 0 };

/** Grace period before a downloaded clip's object URL is revoked, so the browser can read the blob. */
const DOWNLOAD_URL_TTL_MS = 10_000;

export function absoluteWindowStart(reportStartTime: number, fightStartTime: number, timeS: number): number {
  return reportStartTime + fightStartTime + timeS * 1000;
}

export function buildClipWindow(
  reportStartTime: number, fightStartTime: number, window: ClipAnchor, roll: ClipRoll,
): ClipWindow {
  const absStart = absoluteWindowStart(reportStartTime, fightStartTime, window.timeS);
  return {
    fromMs: absStart - roll.preMs,
    toMs: absStart + window.windowLengthS * 1000 + roll.postMs,
    key: window.key,
  };
}

export function buildClipWindows(
  reportStartTime: number, fightStartTime: number, windows: ClipAnchor[], roll: ClipRoll,
): ClipWindow[] {
  return windows.map(window => buildClipWindow(reportStartTime, fightStartTime, window, roll));
}

export function fullPullWindow(reportStartTime: number, fightStartTime: number, fightEndTime: number): ClipWindow {
  return { fromMs: reportStartTime + fightStartTime, toMs: reportStartTime + fightEndTime, key: 'full-pull' };
}

/** Segments overlapping `[fromMs, toMs]`, sorted by start. Half-open on neither end (any touch counts). */
export function selectSegments(segments: Segment[], window: ClipWindow): Segment[] {
  return segments
    .filter(segment => segment.end > window.fromMs && segment.start < window.toMs)
    .sort((a, b) => a.start - b.start);
}

/** The assembled timeline re-bases to 0 at the first segment's start; never negative. */
export function segmentSeekOffset(window: ClipWindow, firstSegment: { start: number } | undefined): number {
  if (!firstSegment) return 0;
  return Math.max(0, (window.fromMs - firstSegment.start) / 1000);
}

/** The assembled timeline is gapless, so a loop length from a wall-clock span shrinks by this much to end on the same footage. */
export function interSegmentGapMs(segments: { start: number; end: number }[]): number {
  let gaps = 0;
  let prev: { start: number; end: number } | undefined;
  for (const segment of segments) {
    if (prev) gaps += Math.max(0, segment.start - prev.end);
    prev = segment;
  }
  return gaps;
}

export function segmentsCover(segments: Segment[], fromMs: number, toMs: number): boolean {
  return segments.some(segment => segment.end > fromMs && segment.start < toMs);
}

/** MSE assembly re-declares this via `addSourceBuffer`, which rejects bare `video/webm`, so a codec-qualified pick keeps playback on the MSE path. */
function mimeFor(profile: CaptureProfile): string {
  const candidates = [`video/webm;codecs=${profile.codec}`, 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find(candidate => MediaRecorder.isTypeSupported(candidate)) ?? 'video/webm';
}

/** The picker-cancel and permission-deny paths both reject with a `NotAllowedError`. */
function isPickerDismissal(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotAllowedError';
}

@Injectable({ providedIn: 'root' })
export class LiveCaptureFeatureService {
  // Live-sync on/off. Lives here because this is the only service that reads it.
  private readonly liveActive = signal(false);

  readonly isCapturing = signal(false);
  readonly isStarting = signal(false);
  readonly sourceLabel = signal('');
  readonly captureProfile = signal<CaptureProfile>(DEFAULT_CAPTURE_PROFILE);
  readonly captureError = signal<string | null>(null);
  readonly downloadError = signal<string | null>(null);

  /** Includes `isStarting` so a cancelled picker moves the bound value, forcing Material to reset the switch - a plain `isCapturing` binding stays false and never re-writes it. */
  readonly recordToggleOn = computed(() => this.isCapturing() || this.isStarting());

  private stream: MediaStream | null = null;
  private readonly segments = signal<Segment[]>([]);
  private segIdx = 0;
  private mimeType = 'video/webm';

  readonly liveEnabled = this.liveActive.asReadonly();
  readonly status = signal('');

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

  async startRecording(profile: CaptureProfile = DEFAULT_CAPTURE_PROFILE): Promise<void> {
    if (this.isCapturing() || this.isStarting()) return;
    // Insecure context or an unsupported browser leaves `getDisplayMedia` absent (the dom lib overpromises); say so rather than fail silently.
    const mediaDevices = navigator.mediaDevices as MediaDevices | undefined;
    if (typeof mediaDevices?.getDisplayMedia !== 'function') {
      this.captureError.set('screen recording is not available in this browser');
      return;
    }
    this.captureError.set(null);
    this.isStarting.set(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const [track] = stream.getVideoTracks();
      if (!track) throw new Error('Screen capture produced no video track.');
      await track.applyConstraints({ width: { max: 1920 }, height: { max: profile.maxHeight }, frameRate: { max: profile.fps } });
      this.stream = stream;
      this.captureProfile.set(profile);
      this.mimeType = mimeFor(profile);
      this.sourceLabel.set(track.label || 'your screen');
      // Sharing stopped from the browser UI (or the window closed) ends capture cleanly.
      track.addEventListener('ended', () => { this.stopRecording(); });
      this.isCapturing.set(true);
      this.cycleSegment();
    } catch (err) {
      // Tear down any half-started capture (an unsupported recorder throws after the stream opens) so the toggle never sticks on "Recording".
      stream?.getTracks().forEach(track => { track.stop(); });
      this.stream = null;
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
    this.isCapturing.set(false);
    this.stream?.getTracks().forEach(track => { track.stop(); });
    this.stream = null;
    this.sourceLabel.set('');
  }

  /** Each segment is a complete WebM (own header + keyframe) so it appends cleanly during MSE assembly. */
  private cycleSegment(): void {
    if (!this.isCapturing() || !this.stream) return;
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
      if (this.isCapturing()) this.cycleSegment();
    };
    recorder.start();
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, SEG_MS);
  }

  prepare(reportCode: string, reportStartTime: number, fight: WclFight): void {
    this.ctx.set({ reportCode, reportStartTime, fight });
  }

  readonly clipReady = computed(() => {
    const ctx = this.ctx();
    if (!ctx) return false;
    const fightFrom = ctx.reportStartTime + ctx.fight.startTime;
    const fightTo = ctx.reportStartTime + ctx.fight.endTime;
    return segmentsCover(this.segments(), fightFrom, fightTo);
  });

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
    this.handle.set(this.resolveHandle(ctx.reportCode, ctx.fight.id, this.clipWindowFor(anchor, ctx)));
  }

  download(): void {
    const anchor = this.currentAnchor;
    const handle = this.handle();
    if (!anchor || !handle) return;
    void this.saveSegments(handle.blobs, `${anchor.key}.webm`);
  }

  downloadFullPull(): void {
    const ctx = this.ctx();
    if (!ctx) return;
    const segments = selectSegments(this.segments(), fullPullWindow(ctx.reportStartTime, ctx.fight.startTime, ctx.fight.endTime));
    void this.saveSegments(segments.map(segment => segment.blob), 'full-pull.webm');
  }

  /** No re-encode, so it stays near-instant. */
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

  private clipWindowFor(anchor: ClipAnchor, ctx: { reportStartTime: number; fight: WclFight }): ClipWindow {
    const { reportStartTime, fight } = ctx;
    // A window plays its exact span; a point-in-time cast gets pre/post roll for context.
    const roll: ClipRoll = anchor.windowLengthS > 0 ? NO_CLIP_ROLL : POINT_CLIP_ROLL;
    return buildClipWindow(reportStartTime, fight.startTime, anchor, roll);
  }

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

  /** The recorder-restart gaps are subtracted since the wall-clock span spans them but the assembled timeline does not. */
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
    setTimeout(() => { URL.revokeObjectURL(url); }, DOWNLOAD_URL_TTL_MS);
  }
}

/** The MediaSource only reaches `sourceopen` once attached, so the URL is set on `video` first, then the buffers appended, then the URL revoked (the element keeps the MediaSource alive). */
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

/** Each segment is a self-contained WebM whose clusters restart at 0, so a plain blob concat repeats the header and timeline and players read only the first segment's ~SEG_MS. */
export async function remuxSegments(blobs: Blob[]): Promise<Blob> {
  // A module-scope import would put the muxer in the landing bundle.
  const {
    BlobSource, BufferTarget, EncodedPacketSink, EncodedVideoPacketSource, Input, Output, WEBM, WebMOutputFormat,
  } = await import('mediabunny');
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  let source: PacketSource | null = null;
  // The decoder config only needs to ride the first packet; every segment shares one codec.
  let firstMeta: Parameters<PacketSource['add']>[1];
  let timeOffset = 0;
  for (const blob of blobs) {
    const track = await new Input({ formats: [WEBM], source: new BlobSource(blob) }).getPrimaryVideoTrack();
    if (!track) continue;
    if (!source) {
      source = new EncodedVideoPacketSource((await track.getCodec()) ?? 'vp8');
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

export function releaseElement(video: HTMLVideoElement): void {
  if (video.src.startsWith('blob:')) URL.revokeObjectURL(video.src);
}

function onceOpen(source: MediaSource): Promise<void> {
  return new Promise(resolve => { source.addEventListener('sourceopen', () => { resolve(); }, { once: true }); });
}

/** Append one buffer and resolve on `updateend` (SourceBuffer appends are async). */
function appendAndWait(buffer: SourceBuffer, data: ArrayBuffer): Promise<void> {
  return new Promise((resolve, reject) => {
    buffer.addEventListener('updateend', () => { resolve(); }, { once: true });
    buffer.addEventListener('error', () => { reject(new Error('append failed')); }, { once: true });
    buffer.appendBuffer(data);
  });
}
