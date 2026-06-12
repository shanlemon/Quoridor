import { Graphics } from 'pixi.js';
import type { CharacterId } from '@quori/engine';

export interface CharacterMeta {
  name: string;
  emoji: string;
  color: number;
  colorCss: string;
  /** Distinct shape icon for color-blind-safe goal banners. */
  icon: string;
}

const cssOf = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

export const CHARACTER_META: Record<CharacterId, CharacterMeta> = {
  mochi: { name: 'Mochi', emoji: '🐰', color: 0xf06ba8, colorCss: cssOf(0xf06ba8), icon: '♥' },
  pebble: { name: 'Pebble', emoji: '🐸', color: 0x4cb04f, colorCss: cssOf(0x4cb04f), icon: '★' },
  biscuit: { name: 'Biscuit', emoji: '🐱', color: 0xf09030, colorCss: cssOf(0xf09030), icon: '✿' },
  tofu: { name: 'Tofu', emoji: '🐧', color: 0x4a90e2, colorCss: cssOf(0x4a90e2), icon: '❆' },
};

function eyes(g: Graphics, y: number, spread: number, r: number): void {
  for (const s of [-1, 1]) {
    g.circle(s * spread, y, r).fill(0x2e2420);
    g.circle(s * spread + r * 0.35, y - r * 0.35, r * 0.34).fill(0xffffff);
  }
}

function blush(g: Graphics, y: number, spread: number, r: number): void {
  for (const s of [-1, 1]) {
    g.circle(s * spread, y, r).fill({ color: 0xff9eb5, alpha: 0.55 });
  }
}

function mochi(g: Graphics, s: number): void {
  // ears
  for (const side of [-1, 1]) {
    g.ellipse(side * 0.16 * s, -1.0 * s, 0.095 * s, 0.26 * s)
      .fill(0xfff0f5)
      .stroke({ width: 0.035 * s, color: 0xe8a8c8 });
    g.ellipse(side * 0.16 * s, -1.0 * s, 0.045 * s, 0.17 * s).fill(0xffc9dd);
  }
  // head
  g.circle(0, -0.52 * s, 0.42 * s)
    .fill(0xfff0f5)
    .stroke({ width: 0.04 * s, color: 0xe8a8c8 });
  // feet
  for (const side of [-1, 1]) {
    g.ellipse(side * 0.16 * s, -0.06 * s, 0.11 * s, 0.07 * s)
      .fill(0xfff0f5)
      .stroke({ width: 0.03 * s, color: 0xe8a8c8 });
  }
  eyes(g, -0.56 * s, 0.16 * s, 0.055 * s);
  g.circle(0, -0.44 * s, 0.032 * s).fill(0xf06ba8); // nose
  blush(g, -0.44 * s, 0.25 * s, 0.06 * s);
}

function pebble(g: Graphics, s: number): void {
  // body blob
  g.ellipse(0, -0.42 * s, 0.43 * s, 0.4 * s)
    .fill(0x8fd97c)
    .stroke({ width: 0.04 * s, color: 0x62b150 });
  // belly
  g.ellipse(0, -0.26 * s, 0.22 * s, 0.16 * s).fill({ color: 0xeafbd7, alpha: 0.95 });
  // eye bumps
  for (const side of [-1, 1]) {
    g.circle(side * 0.21 * s, -0.78 * s, 0.135 * s)
      .fill(0x8fd97c)
      .stroke({ width: 0.035 * s, color: 0x62b150 });
    g.circle(side * 0.21 * s, -0.8 * s, 0.085 * s).fill(0xffffff);
    g.circle(side * 0.21 * s, -0.8 * s, 0.045 * s).fill(0x2e2420);
    g.circle(side * 0.21 * s + 0.018 * s, -0.82 * s, 0.016 * s).fill(0xffffff);
  }
  // smile (move the pen to the arc start first — a bare arc() after fill()
  // would otherwise stroke a stray segment from the path origin at (0,0))
  g.moveTo(0.15 * s * Math.cos(Math.PI * 0.18), -0.52 * s + 0.15 * s * Math.sin(Math.PI * 0.18))
    .arc(0, -0.52 * s, 0.15 * s, Math.PI * 0.18, Math.PI * 0.82)
    .stroke({
      width: 0.028 * s,
      color: 0x3a6e34,
      cap: 'round',
    });
  blush(g, -0.5 * s, 0.3 * s, 0.06 * s);
}

function biscuit(g: Graphics, s: number): void {
  // ears
  for (const side of [-1, 1]) {
    g.poly([
      side * 0.34 * s,
      -0.72 * s,
      side * 0.27 * s,
      -1.02 * s,
      side * 0.08 * s,
      -0.84 * s,
    ]).fill(0xffce8c);
    g.poly([
      side * 0.29 * s,
      -0.76 * s,
      side * 0.25 * s,
      -0.94 * s,
      side * 0.13 * s,
      -0.82 * s,
    ]).fill(0xffa3b5);
  }
  // head
  g.circle(0, -0.5 * s, 0.41 * s)
    .fill(0xffce8c)
    .stroke({ width: 0.04 * s, color: 0xdd9c55 });
  // forehead stripes
  for (const dx of [-0.1, 0, 0.1]) {
    g.roundRect(dx * s - 0.022 * s, -0.92 * s, 0.044 * s, 0.1 * s, 0.02 * s).fill(0xe8a35c);
  }
  eyes(g, -0.56 * s, 0.16 * s, 0.055 * s);
  g.poly([-0.035 * s, -0.46 * s, 0.035 * s, -0.46 * s, 0, -0.41 * s]).fill(0xff8da1); // nose
  // whiskers
  for (const side of [-1, 1]) {
    g.moveTo(side * 0.4 * s, -0.5 * s)
      .lineTo(side * 0.6 * s, -0.54 * s)
      .moveTo(side * 0.4 * s, -0.44 * s)
      .lineTo(side * 0.6 * s, -0.42 * s)
      .stroke({ width: 0.018 * s, color: 0xc98c4e, cap: 'round' });
  }
  blush(g, -0.44 * s, 0.26 * s, 0.055 * s);
}

function tofu(g: Graphics, s: number): void {
  // flippers
  for (const side of [-1, 1]) {
    g.ellipse(side * 0.36 * s, -0.4 * s, 0.09 * s, 0.2 * s)
      .fill(0x46608c)
      .stroke({ width: 0.03 * s, color: 0x35496b });
  }
  // body
  g.ellipse(0, -0.48 * s, 0.37 * s, 0.47 * s)
    .fill(0x46608c)
    .stroke({ width: 0.04 * s, color: 0x35496b });
  // face + belly patch
  g.ellipse(0, -0.4 * s, 0.26 * s, 0.34 * s).fill(0xffffff);
  // feet
  for (const side of [-1, 1]) {
    g.ellipse(side * 0.14 * s, -0.03 * s, 0.1 * s, 0.06 * s).fill(0xffb347);
  }
  eyes(g, -0.6 * s, 0.13 * s, 0.05 * s);
  g.poly([-0.055 * s, -0.5 * s, 0.055 * s, -0.5 * s, 0, -0.4 * s]).fill(0xffb347); // beak
  blush(g, -0.42 * s, 0.2 * s, 0.05 * s);
}

/**
 * Build a chibi character. Local origin is the feet/base center; the art
 * extends upward to roughly -1.2 * size. Pure vector Graphics — no assets.
 */
export function createCharacter(id: CharacterId, size: number): Graphics {
  const g = new Graphics();
  switch (id) {
    case 'mochi':
      mochi(g, size);
      break;
    case 'pebble':
      pebble(g, size);
      break;
    case 'biscuit':
      biscuit(g, size);
      break;
    case 'tofu':
      tofu(g, size);
      break;
  }
  return g;
}
