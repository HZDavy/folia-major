import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerState } from '@/types';

// test/unit/hooks/usePlaybackVisualizerRate.test.ts
// Ensure the video gets the rate of the displayed deck before its clock position, including blends.

const mock = vi.hoisted(() => ({
    frames: [] as FrameRequestCallback[],
    updates: [] as Array<[string, number]>,
    state: { activePlaybackContext: 'main', playerState: 'playing', duration: 180, lyrics: null },
}));
vi.mock('react', () => ({
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => { effect(); },
}));
vi.mock('@/stores/usePlaybackStore', () => ({
    usePlaybackStore: (selector: (state: typeof mock.state) => unknown) => selector(mock.state),
    selectDisplayLyrics: () => null,
    setCurrentLineIndex: vi.fn(),
    setPlayerState: vi.fn(),
}));
vi.mock('@/stores/motionSignals', () => ({
    currentTime: { set: (value: number) => { mock.updates.push(['time', value]); } },
    displayPlaybackRate: { set: (value: number) => { mock.updates.push(['rate', value]); } },
    lyricCurrentTime: { set: vi.fn() },
    audioPower: { set: vi.fn() },
    audioBands: Object.fromEntries(['bass', 'lowMid', 'mid', 'vocal', 'treble', 'spectrum'].map(key => [key, { set: vi.fn() }])),
}));

const { usePlaybackVisualizerBridge } = await import('@/hooks/usePlaybackVisualizerBridge');

const runFrame = (audio: HTMLAudioElement | null, displayed: HTMLAudioElement | null = null) => {
    usePlaybackVisualizerBridge({
        audioRef: { current: audio }, analyserRef: { current: null }, animationFrameRef: { current: 0 },
        effectiveLoopMode: 'off', isNowPlayingStageActive: !audio, isPlayerCapStageActive: false,
        stageActiveEntryKind: null, stageLyricsSession: null,
        stageLyricsClockRef: { current: { startTimeSec: 0, endTimeSec: 180, baseTimeSec: 0, startedAtMs: null } },
        getSyntheticStageLyricsTime: () => 0, syncStageLyricsClock: vi.fn(),
        getNowPlayingDisplayTime: () => 12, getPlayerCapDisplayTime: () => 0, syncNowPlayingClock: vi.fn(),
        lyricTimelineOffsetMs: 0, isTransitionAudible: () => false, getDisplayElement: () => displayed,
    });
    mock.frames.shift()!(0);
};

const deck = (time: number, rate: number) => ({ paused: false, ended: false, currentTime: time, playbackRate: rate }) as HTMLAudioElement;

beforeEach(() => {
    mock.frames.length = 0;
    mock.updates.length = 0;
    mock.state.playerState = PlayerState.PLAYING;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { mock.frames.push(callback); return 1; });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('displayed playback rate', () => {
    it('publishes a tempo bend before its clock update', () => {
        runFrame(deck(30, 1.1));
        expect(mock.updates).toEqual([['rate', 1.1], ['time', 30]]);
    });

    it('follows the outgoing displayed deck while the incoming deck is active', () => {
        runFrame(deck(2, 1), deck(170, 0.9));
        expect(mock.updates).toEqual([['rate', 0.9], ['time', 170]]);
    });

    it('restores 1x for a synthetic clock after a bent audio track', () => {
        runFrame(null);
        expect(mock.updates).toEqual([['rate', 1], ['time', 12]]);
    });
});
