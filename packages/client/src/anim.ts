/** Tiny promise-based tween scheduler, driven by the Pixi ticker. */

export type Ease = (t: number) => number;

export const easings = {
  linear: (t: number): number => t,
  outQuad: (t: number): number => t * (2 - t),
  inQuad: (t: number): number => t * t,
  outCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  inOutSine: (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * t),
  outBack: (t: number): number => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  outBounce: (t: number): number => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
} satisfies Record<string, Ease>;

interface Job {
  elapsed: number;
  duration: number;
  ease: Ease;
  onUpdate: (k: number) => void;
  resolve: () => void;
}

const jobs: Job[] = [];

/** Run onUpdate with an eased 0→1 value over `duration` ms; resolves when done. */
export function animate(
  duration: number,
  onUpdate: (k: number) => void,
  ease: Ease = easings.outQuad,
): Promise<void> {
  return new Promise((resolve) => {
    jobs.push({ elapsed: 0, duration: Math.max(1, duration), ease, onUpdate, resolve });
  });
}

export function delay(ms: number): Promise<void> {
  return animate(ms, () => undefined, easings.linear);
}

/** Advance all running tweens. Call once per frame with the frame delta in ms. */
export function tickAnimations(dtMs: number): void {
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    j.elapsed += dtMs;
    const t = Math.min(1, j.elapsed / j.duration);
    try {
      j.onUpdate(j.ease(t));
    } catch (err) {
      // A tween targeting a destroyed display object must not kill the ticker.
      console.error('[quori] tween error, dropping tween', err);
      jobs.splice(i, 1);
      j.resolve();
      continue;
    }
    if (t >= 1) {
      jobs.splice(i, 1);
      j.resolve();
    }
  }
}

export function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}
