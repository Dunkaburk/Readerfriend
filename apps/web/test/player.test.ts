/**
 * Ping-pong player swap logic (§9.3) with fake audio elements.
 */

import { describe, expect, it, vi } from 'vitest';
import { PingPongPlayer, type AudioElementLike, type PlayerEvent } from '../src/audio/player';

interface FakeElement {
  el: AudioElementLike & { duration: number };
  fire(type: 'ended' | 'error' | 'loadedmetadata'): void;
}

function fakeElement(resetsRateOnLoad = false): FakeElement {
  let srcVal = '';
  const listeners = new Map<string, Set<(ev?: unknown) => void>>();
  const el: AudioElementLike & { duration: number } = {
    src: '',
    preload: '',
    currentTime: 0,
    playbackRate: 1,
    defaultPlaybackRate: 1,
    preservesPitch: true,
    paused: true,
    duration: 30,
    play() {
      el.paused = false;
      return Promise.resolve();
    },
    pause() {
      el.paused = true;
    },
    addEventListener(type, cb) {
      const set = listeners.get(type) ?? new Set();
      set.add(cb);
      listeners.set(type, set);
    },
    removeEventListener(type, cb) {
      listeners.get(type)?.delete(cb);
    },
  };
  if (resetsRateOnLoad) {
    // Chromium behaviour: every new resource load resets playbackRate to
    // defaultPlaybackRate — verified live: with default=1 a preloaded src
    // swap audibly reverted a 2× session to 1× after a couple of chunks.
    Object.defineProperty(el, 'src', {
      get: () => srcVal,
      set: (v: string) => {
        srcVal = v;
        el.playbackRate = el.defaultPlaybackRate;
      },
    });
  }
  return {
    el,
    fire(type) {
      for (const cb of listeners.get(type) ?? []) cb();
    },
  };
}

/** Builds a player on two fake elements; createElement is called in order. */
function makePlayerWithQueue() {
  const elements = [fakeElement(), fakeElement()];
  let n = 0;
  const player = new PingPongPlayer({
    createElement: () => elements[n++]!.el,
    positionIntervalMs: 50,
  });
  return { player, a: elements[0]!.el, b: elements[1]!.el, fireA: elements[0]!.fire, fireB: elements[1]!.fire };
}

describe('PingPongPlayer', () => {
  it('loads the queue: current track into A, next preloaded into B, emits chunkChange', () => {
    const { player, a, b } = makePlayerWithQueue();
    const events: PlayerEvent[] = [];
    player.on((e) => events.push(e));
    player.loadQueue(
      [
        { url: 'u1', chunkIdx: 0 },
        { url: 'u2', chunkIdx: 1 },
        { url: 'u3', chunkIdx: 2 },
      ],
      0,
    );
    expect(a.src).toBe('u1');
    expect(b.src).toBe('u2');
    expect(events).toEqual([{ type: 'chunkChange', chunkIdx: 0 }]);
  });

  it('swaps to the preloaded element on ended and keeps rolling', () => {
    const { player, a, b, fireA } = makePlayerWithQueue();
    const chunkChanges: number[] = [];
    player.on((e) => {
      if (e.type === 'chunkChange') chunkChanges.push(e.chunkIdx);
    });
    player.loadQueue(
      [
        { url: 'u1', chunkIdx: 7 },
        { url: 'u2', chunkIdx: 8 },
      ],
      0,
    );
    player.play();
    expect(a.paused).toBe(false);

    fireA('ended');
    expect(chunkChanges).toEqual([7, 8]);
    expect(b.paused).toBe(false); // playback continues without a play() call
    expect(player.currentChunkIdx).toBe(8);
  });

  it('emits ended when the queue runs dry (narrator re-feeds it)', () => {
    const { player, fireB } = makePlayerWithQueue();
    const events: PlayerEvent[] = [];
    player.on((e) => events.push(e));
    player.loadQueue(
      [
        { url: 'u1', chunkIdx: 0 },
        { url: 'u2', chunkIdx: 1 },
      ],
      0,
    );
    player.play();
    // Swap to track 2...
    player.next();
    // ...and exhaust the queue.
    fireB('ended');
    expect(events.some((e) => e.type === 'ended')).toBe(true);
  });

  it('extendQueue appends unseen tracks and preloads the next one', () => {
    const { player, a, b } = makePlayerWithQueue();
    player.loadQueue([{ url: 'u1', chunkIdx: 0 }], 0);
    expect(b.src).toBe('');
    player.extendQueue([
      { url: 'u2', chunkIdx: 1 },
      { url: 'u3', chunkIdx: 2 },
    ]);
    expect(b.src).toBe('u2'); // next track preloaded into the idle element
    // Duplicates ignored.
    player.extendQueue([{ url: 'u2', chunkIdx: 1 }]);
    expect(player.queuedIdxs()).toEqual([0, 1, 2]);
    expect(a.src).toBe('u1');
  });

  it('jumpTo switches to the idle element without stopping playback', () => {
    const { player, a, b } = makePlayerWithQueue();
    const chunkChanges: number[] = [];
    player.on((e) => {
      if (e.type === 'chunkChange') chunkChanges.push(e.chunkIdx);
    });
    player.loadQueue(
      [
        { url: 'u1', chunkIdx: 0 },
        { url: 'u2', chunkIdx: 1 },
        { url: 'u3', chunkIdx: 2 },
      ],
      0,
    );
    player.play();
    player.jumpTo(2);
    expect(player.currentChunkIdx).toBe(2);
    expect(b.paused).toBe(false);
    expect(a.paused).toBe(true);
    expect(chunkChanges).toEqual([0, 2]);
  });

  it('previous() restarts the chunk when playback is past 3s', () => {
    const { player, a } = makePlayerWithQueue();
    player.loadQueue(
      [
        { url: 'u1', chunkIdx: 0 },
        { url: 'u2', chunkIdx: 1 },
      ],
      0,
    );
    a.currentTime = 4;
    player.previous();
    expect(a.currentTime).toBe(0);
    expect(player.currentChunkIdx).toBe(0);
  });

  it('setRate reaches both elements; position events tick', () => {
    vi.useFakeTimers();
    try {
      const { player, a, b } = makePlayerWithQueue();
      player.loadQueue([{ url: 'u1', chunkIdx: 0 }], 0);
      player.setRate(1.5);
      expect(a.playbackRate).toBe(1.5);
      expect(b.playbackRate).toBe(1.5);

      const events: PlayerEvent[] = [];
      player.on((e) => events.push(e));
      a.currentTime = 2;
      vi.advanceTimersByTime(60);
      expect(events.filter((e) => e.type === 'position').length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the chosen rate across every chunk preload (Chromium resets to defaultPlaybackRate per load)', () => {
    const elements = [fakeElement(true), fakeElement(true)];
    let n = 0;
    const player = new PingPongPlayer({
      createElement: () => elements[n++]!.el,
      positionIntervalMs: 50,
    });
    const a = elements[0]!.el;
    const b = elements[1]!.el;
    const fireA = elements[0]!.fire;
    player.setRate(2);
    // Each src assignment resets the element rate to defaultPlaybackRate;
    // setRate pinned it, so every load — initial, preload and post-swap —
    // lands on 2. (The regression: chunks 0–1 played at 2×, then the swap
    // onto the freshly preloaded element audibly fell back to 1×.)
    player.loadQueue(
      [
        { url: 'u1', chunkIdx: 0 },
        { url: 'u2', chunkIdx: 1 },
        { url: 'u3', chunkIdx: 2 },
      ],
      0,
    );
    expect(a.playbackRate).toBe(2);
    expect(b.playbackRate).toBe(2);
    fireA('ended'); // swap to b; preloadNext assigns u3 to a
    expect(a.playbackRate).toBe(2);
    expect(player.currentChunkIdx).toBe(1);
  });

  it('re-applies the rate once a load finishes (engines that clear it at load start)', () => {
    const { player, a, fireA } = makePlayerWithQueue();
    player.setRate(2);
    player.loadQueue([{ url: 'u1', chunkIdx: 0 }], 0);
    // Simulate an engine that clears both rates on load:
    a.playbackRate = 1;
    a.defaultPlaybackRate = 1;
    fireA('loadedmetadata');
    expect(a.playbackRate).toBe(2);
  });

  it('destroy stops the elements and clears handlers', () => {
    const { player, fireA } = makePlayerWithQueue();
    player.loadQueue([{ url: 'u1', chunkIdx: 0 }], 0);
    const events: PlayerEvent[] = [];
    player.on((e) => events.push(e));
    player.destroy();
    fireA('ended');
    expect(events).toEqual([]);
  });
});
