// Touch layouts (plan 1.12, changed by K1.1 step 1): landscape only, two thumbs on every device. The two direction
// buttons sit side by side in a column at the left edge under the left thumb — Left on the left, Right on the
// right — ('left' / 'right': a turn at a turn point, a line shift on an approach); the pace button is a square in
// the bottom-right corner and the take-off tap ("Jump!") lies in the right half above the pace square and to its
// left, both under the right thumb. The column is LAYOUT.phoneColumnFraction (≈30 %) of the width on a phone and
// LAYOUT.tabletColumnFraction (25 %) on a tablet. On the target phone areas (844×390 — iPhone 16e; 667×375;
// 667×320 — with the Safari bars) each direction button and the pace square are at least 2×2 cm
// (LAYOUT.minButtonPx), the take-off zone at least 3×3 cm (LAYOUT.minTapPx); the top LAYOUT.hudTopFraction of
// the height belongs to the HUD and no zone reaches into it. Portrait shows the "turn your phone" overlay instead.

export type Device = 'phone' | 'tablet';
export type Control = 'turn-left' | 'turn-right' | 'gear' | 'tap';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  device: Device;
  width: number;
  height: number;
  zones: Record<Control, Rect>;
}

export const LAYOUT = {
  /** 2 cm at the CSS reference of 96 px per inch: every direction button and the pace square are at least 2×2 cm. */
  minButtonPx: 76,
  /** 3 cm at 96 px per inch: the take-off zone ("Jump!") is at least 3×3 cm on the target phone areas (K1.1 step 1). */
  minTapPx: 113,
  /** Shorter side (CSS px) from which a device counts as a tablet (iPad mini 744 → tablet; iPhone 16e 390 → phone). */
  tabletMinShortSidePx: 600,
  /** The left column of the two direction buttons, as a fraction of the width: ≈30 % on a phone (K1.1), 25 % on a tablet. */
  phoneColumnFraction: 0.3,
  tabletColumnFraction: 0.25,
  /** The top of the area that belongs to the HUD: no zone starts above this fraction of the height. */
  hudTopFraction: 0.15,
  /** The take-off zone: the central part of the right half (fractions of width / height). */
  tapZone: { x: 0.5, y: 0.15, w: 0.32, h: 0.6 },
  /** The direction buttons span 25%–75% of the height, except that they never reach below the top of the pace square. */
  buttonHeightFraction: 0.5,
  /** Pace button: a square of max(minButtonPx, 20% of the height) in the bottom-right corner, with this margin. */
  gearMarginPx: 8,
} as const;

/** The pace square: 20% of the height. */
const GEAR_HEIGHT_FRACTION = 0.2;

/** Zones are whole CSS px, so shared edges meet exactly and nothing leaks past the viewport by a rounding error. */
const px = (value: number): number => Math.round(value);

export function deviceFor(width: number, height: number): Device {
  return Math.min(width, height) >= LAYOUT.tabletMinShortSidePx ? 'tablet' : 'phone';
}

/** Portrait (height > width) needs the rotate overlay; a square counts as landscape. */
export function needsRotation(width: number, height: number): boolean {
  return height > width;
}

/**
 * The zones for a landscape viewport of width × height CSS px — the AVAILABLE area (after the browser chrome and
 * the safe-area insets), which the page measures, not the screen. Phone and tablet alike (K1.1 step 1): the two
 * direction buttons side by side in the left column (Left at x 0, Right right next to it; the column is
 * phoneColumnFraction of the width on a phone, tabletColumnFraction on a tablet), the pace square of
 * max(minButtonPx, 20 % of the height) in the bottom-right corner with gearMarginPx to both edges, the take-off zone
 * in the right half, above the pace square and to its left. On the tablet the direction buttons start at 25 % of the
 * height and end at min(75 % of the height, the top of the pace square), and the take-off zone keeps LAYOUT.tapZone
 * (the K1 tablet layout is unchanged). On the target phone areas (844×390, 667×375, 667×320) every direction button
 * and the pace square are at least minButtonPx on both sides and the take-off zone at least minTapPx. Everywhere:
 * zones never overlap, every zone lies inside the viewport and none reaches into the top hudTopFraction of the height.
 */
export function layoutFor(width: number, height: number, device: Device = deviceFor(width, height)): Layout {
  const side = px(Math.max(LAYOUT.minButtonPx, GEAR_HEIGHT_FRACTION * height));
  const gear: Rect = {
    x: width - side - LAYOUT.gearMarginPx,
    y: height - side - LAYOUT.gearMarginPx,
    w: side,
    h: side,
  };

  const buttonTop = px((1 - LAYOUT.buttonHeightFraction) / 2 * height);
  const buttonBottom = Math.min(px((1 + LAYOUT.buttonHeightFraction) / 2 * height), gear.y);
  const buttonHeight = Math.max(0, buttonBottom - buttonTop);

  // One column at the left edge on both devices: Left from x 0, Right right next to it up to the column's edge (an
  // odd column gives Right the extra pixel).
  const column = px((device === 'phone' ? LAYOUT.phoneColumnFraction : LAYOUT.tabletColumnFraction) * width);
  const half = Math.floor(column / 2);
  const turnLeft: Rect = { x: 0, y: buttonTop, w: half, h: buttonHeight };
  const turnRight: Rect = { x: half, y: buttonTop, w: column - half, h: buttonHeight };

  const tap: Rect = {
    x: px(LAYOUT.tapZone.x * width),
    y: px(LAYOUT.tapZone.y * height),
    w: px(LAYOUT.tapZone.w * width),
    h: px(LAYOUT.tapZone.h * height),
  };

  return { device, width, height, zones: { 'turn-left': turnLeft, 'turn-right': turnRight, gear, tap } };
}

const CONTROLS: readonly Control[] = ['turn-left', 'turn-right', 'gear', 'tap'];

const contains = (rect: Rect, x: number, y: number): boolean =>
  x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;

/** The control under (x, y) — the smaller zones (gear) win over the larger ones they could touch; null outside every zone. */
export function hitTest(layout: Layout, x: number, y: number): Control | null {
  let best: Control | null = null;
  let bestArea = Infinity;
  for (const control of CONTROLS) {
    const rect = layout.zones[control];
    if (!contains(rect, x, y)) continue;
    const area = rect.w * rect.h;
    if (area < bestArea) {
      best = control;
      bestArea = area;
    }
  }
  return best;
}
