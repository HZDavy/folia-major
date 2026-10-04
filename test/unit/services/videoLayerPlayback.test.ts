import { describe, expect, it, vi } from 'vitest';
import { createVideoLayerPlayback } from '@/services/videoLayerPlayback';

// test/unit/services/videoLayerPlayback.test.ts
// Temporary playback-only behavior: state changes must leave the video position untouched.

const setup = (playing = true) => {
    const seek = vi.fn();
    const listeners = new Map<string, () => void>();
    const media = {
        paused: true, playbackRate: 1.08,
        get currentTime() { return 12; },
        set currentTime(value: number) { seek(value); },
        play: vi.fn(() => { media.paused = false; return Promise.resolve(); }),
        pause: vi.fn(() => { media.paused = true; }),
        addEventListener: vi.fn((name: string, callback: () => void) => { listeners.set(name, callback); }),
        removeEventListener: vi.fn((name: string) => { listeners.delete(name); }),
    };
    const controller = createVideoLayerPlayback(media as unknown as HTMLVideoElement, {
        isPlaying: () => playing,
    });
    return {
        media, controller, seek, listeners,
        setPlaying: (value: boolean) => { playing = value; controller.followState(); },
    };
};

describe('video layer playback-only experiment', () => {
    it('starts at native speed without aligning the existing position', () => {
        const probe = setup();
        expect(probe.media.paused).toBe(false);
        expect(probe.media.playbackRate).toBe(1);
        expect(probe.seek).not.toHaveBeenCalled();
    });

    it('pauses and resumes at the existing video position', async () => {
        const probe = setup();
        await Promise.resolve();
        await Promise.resolve();
        probe.setPlaying(false);
        expect(probe.media.paused).toBe(true);
        probe.setPlaying(true);
        expect(probe.media.paused).toBe(false);
        expect(probe.seek).not.toHaveBeenCalled();
    });

    it('leaves newly loaded metadata paused until playback resumes', () => {
        const probe = setup(false);
        probe.listeners.get('loadedmetadata')?.();
        expect(probe.media.play).not.toHaveBeenCalled();
        probe.setPlaying(true);
        expect(probe.media.paused).toBe(false);
        expect(probe.seek).not.toHaveBeenCalled();
    });

    it('does not repeatedly request playback while already playing', () => {
        const probe = setup();
        probe.controller.followState();
        probe.listeners.get('loadedmetadata')?.();
        expect(probe.media.play).toHaveBeenCalledTimes(1);
    });

    it('removes listeners and ignores changes after disposal', () => {
        const probe = setup();
        probe.controller.dispose();
        probe.setPlaying(true);
        expect(probe.listeners.size).toBe(0);
        expect(probe.media.paused).toBe(true);
        expect(probe.media.play).toHaveBeenCalledTimes(1);
        expect(probe.seek).not.toHaveBeenCalled();
    });
});
