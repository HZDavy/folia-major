import { describe, expect, it, vi } from 'vitest';
import { createVideoLayerPlayback } from '@/services/videoLayerPlayback';

// test/unit/services/videoLayerPlayback.test.ts
// Simulate independent audio/video clocks; assertions constrain seeks, speed, and stall recovery.

/** Advance independent clocks and capture script seeks without browser decoding noise. */
const setup = (duration = 10, time = 0) => {
    let clock = time;
    let now = 0;
    let rate = 1;
    let playing = true;
    let position = time % duration;
    const seek = vi.fn((value: number) => { position = value; });
    const listeners = new Map<string, () => void>();
    const media = {
        duration, seeking: false, readyState: 4, paused: true, playbackRate: 1,
        get currentTime() { return position; },
        set currentTime(value: number) { seek(value); },
        play: vi.fn(() => { media.paused = false; return Promise.resolve(); }),
        pause: vi.fn(() => { media.paused = true; }),
        addEventListener: vi.fn((name: string, callback: () => void) => { listeners.set(name, callback); }),
        removeEventListener: vi.fn((name: string) => { listeners.delete(name); }),
    };
    const controller = createVideoLayerPlayback(media as unknown as HTMLVideoElement, {
        getTime: () => clock, getRate: () => rate, isPlaying: () => playing, now: () => now,
    });
    return {
        media, controller, seek, listeners,
        setPosition: (value: number) => { position = value; },
        advance: (seconds: number, notify = true) => {
            now += seconds * 1000;
            clock += seconds * rate;
            if (!media.paused) position = (position + seconds * media.playbackRate) % duration;
            if (notify) controller.onClockChange(clock);
        },
        seekTo: (value: number) => { clock = value; controller.onClockChange(clock); },
        setRate: (value: number) => { rate = value; controller.onRateChange(); },
        setPlaying: (value: boolean) => { playing = value; controller.followState(); },
        stopClock: (seconds: number) => { now += seconds * 1000; controller.tick(); },
    };
};

describe('video layer playback', () => {
    it('softly corrects a small phase error across the loop boundary instead of seeking', () => {
        const probe = setup(10, 9.9);
        probe.advance(0.2);
        probe.setPosition(9.9);
        probe.controller.tick();
        expect(probe.seek).not.toHaveBeenCalled();
        expect(probe.media.playbackRate).toBeCloseTo(1.04);
    });

    it('slows a video that is ahead across the loop boundary', () => {
        const probe = setup(10, 9.9);
        probe.setPosition(0.1);
        probe.controller.tick();
        expect(probe.seek).not.toHaveBeenCalled();
        expect(probe.media.playbackRate).toBeCloseTo(0.96);
    });

    it('follows tempo changes for minutes without periodic hard corrections', () => {
        const probe = setup();
        for (const rate of [1.1, 0.9, 1]) {
            probe.setRate(rate);
            for (let i = 0; i < 120; i += 1) {
                probe.advance(0.5);
                probe.controller.tick();
            }
            expect(probe.media.playbackRate).toBeCloseTo(rate);
        }
        expect(probe.seek).not.toHaveBeenCalled();
    });

    it('does not interpret a multi-second scheduling gap as a seek', () => {
        const probe = setup(100);
        probe.advance(2.5);
        expect(probe.seek).not.toHaveBeenCalled();
    });

    it('aligns forward and backward seeks immediately, including while paused', () => {
        const probe = setup(100);
        probe.seekTo(25);
        expect(probe.seek).toHaveBeenLastCalledWith(25);
        probe.seekTo(3);
        expect(probe.seek).toHaveBeenLastCalledWith(3);
        probe.setPlaying(false);
        probe.seekTo(4);
        expect(probe.seek).toHaveBeenLastCalledWith(4);
        expect(probe.media.paused).toBe(true);
    });

    it('corrects moderate drift gradually and converges without seeks', () => {
        const probe = setup(100, 10);
        probe.setPosition(9);
        for (let i = 0; i < 60; i += 1) {
            probe.controller.tick();
            probe.advance(0.5);
        }
        expect(probe.seek).not.toHaveBeenCalled();
        expect(Math.abs(probe.media.currentTime - 40)).toBeLessThan(0.1);
        expect(probe.media.playbackRate).toBe(1);
    });

    it('repairs severe drift once instead of continuously seeking', () => {
        const probe = setup(100, 10);
        probe.setPosition(5);
        probe.controller.tick();
        probe.controller.tick();
        expect(probe.seek).toHaveBeenCalledExactlyOnceWith(10);
    });

    it('stops on a stale clock without repeatedly seeking backwards and resumes on fresh time', async () => {
        const probe = setup(100, 10);
        await Promise.resolve();
        await Promise.resolve();
        probe.stopClock(2);
        probe.stopClock(2);
        expect(probe.media.paused).toBe(true);
        expect(probe.seek).not.toHaveBeenCalled();
        probe.advance(0.1);
        expect(probe.media.paused).toBe(false);
        expect(probe.seek).toHaveBeenCalledTimes(1);
    });

    it('does not correct or restart video during a user pause', () => {
        const probe = setup(100, 10);
        probe.setPlaying(false);
        const plays = probe.media.play.mock.calls.length;
        probe.setPosition(8);
        probe.stopClock(10);
        expect(probe.seek).not.toHaveBeenCalled();
        expect(probe.media.play).toHaveBeenCalledTimes(plays);
    });

    it('does not seek on every frame while a paused audio deck is finishing its fade', () => {
        const probe = setup(100, 10);
        probe.setPlaying(false);
        for (let i = 0; i < 30; i += 1) probe.advance(1 / 60);
        expect(probe.seek).not.toHaveBeenCalled();
    });

    it('aligns newly loaded metadata even while the player is paused', () => {
        const probe = setup(100, 10);
        probe.setPlaying(false);
        probe.media.duration = Number.NaN;
        probe.seekTo(25);
        probe.media.duration = 100;
        probe.listeners.get('loadedmetadata')?.();
        expect(probe.seek).toHaveBeenCalledExactlyOnceWith(25);
        expect(probe.media.paused).toBe(true);
    });

    it('preserves a seek until the previous media seek finishes', () => {
        const probe = setup(100);
        probe.media.seeking = true;
        probe.seekTo(20);
        probe.seekTo(30);
        expect(probe.seek).not.toHaveBeenCalled();
        probe.media.seeking = false;
        probe.controller.tick();
        expect(probe.seek).toHaveBeenCalledExactlyOnceWith(30);
    });

    it('does not schedule a second hard seek when playback starts during an existing seek', () => {
        const probe = setup(100);
        probe.setPlaying(false);
        probe.seekTo(0.238);
        probe.media.seeking = true;
        probe.setPlaying(true);
        probe.advance(0.5);
        // A slow decoder finishes the original seek after the music has already advanced.
        probe.setPosition(0.238);
        probe.media.seeking = false;
        probe.controller.tick();
        expect(probe.seek).toHaveBeenCalledExactlyOnceWith(0.238);
        expect(probe.media.playbackRate).toBeGreaterThan(1);
    });

    it('waits for buffering to finish before drift correction', () => {
        const probe = setup(100, 10);
        probe.media.readyState = 1;
        probe.setPosition(0);
        probe.controller.tick();
        expect(probe.seek).not.toHaveBeenCalled();
        probe.media.readyState = 4;
        probe.controller.tick();
        expect(probe.seek).toHaveBeenCalledExactlyOnceWith(10);
    });

    it('ignores invalid clocks and unknown duration, then aligns when metadata arrives', () => {
        const probe = setup(100, 10);
        probe.media.duration = Number.NaN;
        probe.seekTo(20);
        expect(probe.seek).not.toHaveBeenCalled();
        probe.media.duration = 100;
        probe.listeners.get('loadedmetadata')?.();
        expect(probe.seek).toHaveBeenCalledExactlyOnceWith(20);
        probe.seekTo(Number.NaN);
        expect(probe.seek).toHaveBeenCalledTimes(1);
    });

    it('removes listeners and stops all corrections after disposal', () => {
        const probe = setup();
        probe.controller.dispose();
        probe.advance(5);
        probe.controller.tick();
        probe.controller.followState();
        expect(probe.listeners.size).toBe(0);
        expect(probe.media.paused).toBe(true);
        expect(probe.seek).not.toHaveBeenCalled();
    });
});
