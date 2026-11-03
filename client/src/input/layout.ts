// Touch layouts (plan 1.12): landscape only. Phone — one thumb of the right hand: 'left' / 'right' at the two
// edges (a turn at a turn point, a line shift on an approach), the pace button at least 2×2 cm, the take-off tap
// in the central part of the right half. Tablet — two thumbs: the two direction buttons under the left thumb,
// pace and the take-off zone on the right. Portrait shows the "turn your phone" overlay instead.

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
  /** 2 cm at the CSS reference of 96 px per inch (plan 1.12: the pace button is at least 2×2 cm). */
  minButtonPx: 76,
  /** Shorter side (CSS px) from which a device counts as a tablet (iPad mini 744 → tablet; iPhone 16e 390 → phone). */
  tabletMinShortSidePx: 600,
  /** Edge buttons: fraction of the width on a phone, of the half-width on a tablet (the left column). */
  phoneEdgeFraction: 0.18,
  tabletColumnFraction: 0.25,
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
 * the safe-area insets), which the page measures, not the screen. Phone: direction buttons at the two edges (18%
 * wide), the pace square in the bottom-right corner, the tap zone in the right half. Tablet: the two direction
 * buttons side by side in the left 25% column, pace and tap on the right. The direction buttons start at 25% of
 * the height and end at min(75% of the height, the top of the pace square): on a short viewport the pace square
 * keeps its 2 cm and the buttons give way. Zones never overlap; every zone lies inside the viewport.
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

  let turnLeft: Rect;
  let turnRight: Rect;
  if (device === 'phone') {
    const edge = px(LAYOUT.phoneEdgeFraction * width);
    turnLeft = { x: 0, y: buttonTop, w: edge, h: buttonHeight };
    turnRight = { x: width - edge, y: buttonTop, w: edge, h: buttonHeight };
  } else {
    const column = px(LAYOUT.tabletColumnFraction * width);
    const half = Math.floor(column / 2);
    turnLeft = { x: 0, y: buttonTop, w: half, h: buttonHeight };
    turnRight = { x: half, y: buttonTop, w: half, h: buttonHeight };
  }

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
