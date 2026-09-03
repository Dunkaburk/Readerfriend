/**
 * Web AudioPlayer (§6.3): two HTMLAudioElements ping-ponging for near-gapless
 * playback of consecutive chunks — while chunk n plays, chunk n+1 is
 * preloaded into the other element; swap on `ended`.
 *
 * The element surface is injected so the swap logic is testable without real
 * audio (happy-dom's media elements are stubs).
 */

export interface PlayerTrack {
  url: string;
  chunkIdx: number;
}

export interface AudioElementLike {
  src: string;
  preload: string;
  currentTime: number;
  playbackRate: number;
  preservesPitch: boolean;
  paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
  addEventListener(type: string, cb: (ev?: unknown) => void): void;
  removeEventListener(type: string, cb: (ev?: unknown) => void): void;
  removeAttribute?(name: string): void;
}

export type PlayerEvent =
  | { type: 'position'; ms: number }
  | { type: 'chunkChange'; chunkIdx: number }
  | { type: 'ended' }
  | { type: 'error'; error: Error };

type Handler = (ev: PlayerEvent) => void;

export interface PingPongPlayerOptions {
  createElement?(): AudioElementLike;
  /** How often to emit position updates, in ms (default 250). */
  positionIntervalMs?: number;
}

export class PingPongPlayer {
  private elements: [AudioElementLike, AudioElementLike];
  private activeIdx: 0 | 1 = 0;
  private tracks: PlayerTrack[] = [];
  private index = 0;
  private isPlaying = false;
  private rate = 1;
  private handlers = new Set<Handler>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private destroyed = false;

  constructor(opts: PingPongPlayerOptions = {}) {
    const createElement =
      opts.createElement ??
      (() => {
        const el = new Audio();
        // §9.3: pitch stays constant across rates.
        (el as HTMLAudioElement).preservesPitch = true;
        return el as AudioElementLike;
      });
    this.elements = [createElement(), createElement()];
    for (const el of this.elements) {
      el.preload = 'auto';
      el.addEventListener('ended', () => this.onEnded());
      el.addEventListener('error', () => this.handlers.forEach((h) => h({ type: 'error', error: new Error('Audio element error') })));
    }
    this.startTimer(opts.positionIntervalMs ?? 250);
  }

  on(cb: Handler): () => void {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }

  private emit(ev: PlayerEvent): void {
    for (const h of this.handlers) h(ev);
  }

  /** Load the queue and start (paused) at `startIndex`. */
  loadQueue(tracks: PlayerTrack[], startIndex: number): void {
    this.tracks = tracks;
    this.index = Math.max(0, Math.min(startIndex, tracks.length - 1));
    this.activeIdx = 0;
    const a = this.elements[0]!;
    const b = this.elements[1]!;
    const current = tracks[this.index];
    if (current) a.src = current.url;
    a.currentTime = 0;
    const next = tracks[this.index + 1];
    if (next) {
      b.src = next.url;
    } else {
      b.removeAttribute?.('src');
    }
    this.emit({ type: 'chunkChange', chunkIdx: current?.chunkIdx ?? -1 });
  }

  get currentChunkIdx(): number {
    return this.tracks[this.index]?.chunkIdx ?? -1;
  }

  /** Chunk indices currently in the queue (narrator uses this to feed it). */
  queuedIdxs(): number[] {
    return this.tracks.map((t) => t.chunkIdx);
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get positionMs(): number {
    return Math.round(this.elements[this.activeIdx]!.currentTime * 1000);
  }

  get durationMs(): number {
    const d = (this.elements[this.activeIdx] as unknown as { duration?: number }).duration;
    return typeof d === 'number' && Number.isFinite(d) ? Math.round(d * 1000) : 0;
  }

  get playbackRate(): number {
    return this.rate;
  }

  play(): void {
    if (this.destroyed) return;
    this.isPlaying = true;
    void this.elements[this.activeIdx]!.play();
  }

  pause(): void {
    this.isPlaying = false;
    this.elements[this.activeIdx]!.pause();
  }

  /** Seek within the current chunk. */
  seek(ms: number): void {
    const el = this.elements[this.activeIdx]!;
    el.currentTime = Math.max(0, ms / 1000);
  }

  setRate(rate: number): void {
    this.rate = rate;
    for (const el of this.elements) el.playbackRate = rate;
  }

  /** Jump to a specific queue position (skip forward/back by chunk). */
  jumpTo(index: number): void {
    if (index < 0 || index >= this.tracks.length) return;
    const previous = this.tracks[this.index];
    const idleIdx = (this.activeIdx === 0 ? 1 : 0) as 0 | 1;
    // Reuse the idle element for the new track to avoid resetting the active one.
    const idle = this.elements[idleIdx]!;
    idle.src = this.tracks[index]!.url;
    idle.currentTime = 0;
    if (previous && previous.chunkIdx !== this.tracks[index]!.chunkIdx) {
      this.elements[this.activeIdx]!.pause();
    }
    this.activeIdx = idleIdx;
    this.index = index;
    if (this.isPlaying) void this.elements[this.activeIdx]!.play();
    this.preloadNext();
    this.emit({ type: 'chunkChange', chunkIdx: this.tracks[index]!.chunkIdx });
  }

  next(): void {
    this.jumpTo(this.index + 1);
  }

  previous(): void {
    // Standard player behaviour: restart the chunk if we're past its start.
    if (this.positionMs > 3000) {
      this.seek(0);
      return;
    }
    this.jumpTo(this.index - 1);
  }

  /** Append tracks as their audio is resolved ahead of the playhead. */
  extendQueue(tracks: PlayerTrack[]): void {
    for (const t of tracks) {
      if (this.tracks.some((x) => x.chunkIdx === t.chunkIdx)) continue;
      this.tracks.push(t);
    }
    this.preloadNext();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    for (const el of this.elements) {
      el.pause();
      el.src = '';
    }
    this.handlers.clear();
  }

  /** Preload the following chunk into the idle element. */
  private preloadNext(): void {
    const idleIdx = (this.activeIdx === 0 ? 1 : 0) as 0 | 1;
    const next = this.tracks[this.index + 1];
    const idle = this.elements[idleIdx]!;
    if (next) {
      if (idle.src !== next.url) idle.src = next.url;
      idle.currentTime = 0;
    }
  }

  private onEnded(): void {
    if (this.destroyed) return;
    const nextIndex = this.index + 1;
    if (nextIndex >= this.tracks.length) {
      this.isPlaying = false;
      this.emit({ type: 'ended' });
      return;
    }
    // Swap to the preloaded element and keep rolling.
    const idleIdx = (this.activeIdx === 0 ? 1 : 0) as 0 | 1;
    this.activeIdx = idleIdx;
    this.index = nextIndex;
    if (this.isPlaying) void this.elements[this.activeIdx]!.play();
    this.preloadNext();
    this.emit({ type: 'chunkChange', chunkIdx: this.tracks[nextIndex]!.chunkIdx });
  }

  private startTimer(intervalMs: number): void {
    this.timer = setInterval(() => {
      if (this.destroyed) return;
      this.emit({ type: 'position', ms: this.positionMs });
    }, intervalMs);
  }
}
