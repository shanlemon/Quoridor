/**
 * All sounds are synthesized with WebAudio — no audio assets needed.
 * Soft, rounded envelopes; quiet by default (users may be in voice chat later).
 */

const MUTE_KEY = 'quori-muted';
const MASTER = 0.28;

let ctx: AudioContext | null = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

interface ToneOpts {
  freq: number;
  to?: number;
  dur: number;
  type?: OscillatorType;
  vol?: number;
  delay?: number;
}

function tone(opts: ToneOpts): void {
  const a = ac();
  if (!a) return;
  const t0 = a.currentTime + (opts.delay ?? 0);
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.to !== undefined) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.dur);
  const v = (opts.vol ?? 1) * MASTER;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(v, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + opts.dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.05);
}

export const sfx = {
  /** Boingy pawn hop. */
  hop(): void {
    tone({ freq: 320, to: 640, dur: 0.13 });
  },
  /** Fence lands with a soft thunk. */
  thunk(): void {
    tone({ freq: 150, to: 65, dur: 0.16, type: 'triangle', vol: 1.5 });
    tone({ freq: 96, dur: 0.07, type: 'square', vol: 0.25 });
  },
  /** Gentle "that's not allowed" bonk. */
  bonk(): void {
    tone({ freq: 210, to: 140, dur: 0.18, type: 'square', vol: 0.4 });
  },
  /** Two-note turn-start chime. */
  chime(): void {
    tone({ freq: 660, dur: 0.1, vol: 0.45 });
    tone({ freq: 880, dur: 0.14, vol: 0.45, delay: 0.09 });
  },
  /** Soft UI tick for pickers/toggles. */
  pick(): void {
    tone({ freq: 520, to: 620, dur: 0.06, vol: 0.35 });
  },
  /** Win fanfare arpeggio. */
  fanfare(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.24, vol: 0.6, delay: i * 0.13 }));
  },
  toggleMuted(): boolean {
    muted = !muted;
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    return muted;
  },
  isMuted(): boolean {
    return muted;
  },
};
