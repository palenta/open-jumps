// Plan 1.12 as changed by K1.1 step 1: landscape touch layouts for two thumbs on every device. The phone takes the
// tablet's family: Left and Right side by side in a left column (≈30 % of the width on a phone, 25 % on a tablet)
// under the left thumb; the pace square in the bottom-right corner and the take-off zone ("Jump!") in the right
// half above it and to its left, under the right thumb. On the target phone areas (844×390 — iPhone 16e; 667×375;
// 667×320 — with the Safari bars) every direction button and the pace square are at least 2×2 cm, Jump! at least
// 3×3 cm; zones never overlap, lie inside the area, and leave the top 15 % (the HUD) free. Portrait asks to rotate.
import { describe, expect, it } from 'vitest';
import { deviceFor, hitTest, LAYOUT, layoutFor, needsRotation, type Control, type Layout, type Rect } from '../src/input/layout.js';

const CONTROLS: Control[] = ['turn-left', 'turn-right', 'gear', 'tap'];

/** Zones are CSS px; an implementation may round them, so a pixel of slack is allowed. */
function expectPx(actual: number, expected: number): void {
  expect(actual).toBeGreaterThanOrEqual(expected - 1);
  expect(actual).toBeLessThanOrEqual(expected + 1);
}

function expectRect(rect: Rect, x: number, y: number, w: number, h: number): void {
  expectPx(rect.x, x);
  expectPx(rect.y, y);
  expectPx(rect.w, w);
  expectPx(rect.h, h);
}

const centre = (rect: Rect): [number, number] => [rect.x + rect.w / 2, rect.y + rect.h / 2];

/** Two rectangles overlap when they share more than half a pixel in both axes (a shared edge is not an overlap). */
function overlaps(a: Rect, b: Rect): boolean {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0.5 && h > 0.5;
}

const inside = (rect: Rect, width: number, height: number): boolean =>
  rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= width && rect.y + rect.h <= height;

const VIEWPORTS: { name: string; width: number; height: number }[] = [
  { name: 'iPhone 16e landscape', width: 844, height: 390 },
  { name: 'iPhone SE landscape', width: 667, height: 375 },
  { name: 'iPad mini landscape', width: 1133, height: 744 },
  { name: 'iPad landscape', width: 1180, height: 820 },
  { name: 'iPhone SE landscape with the Safari bars showing', width: 667, height: 320 },
  { name: 'a short wide viewport', width: 568, height: 320 },
  { name: 'the smallest landscape worth supporting', width: 480, height: 300 },
];

describe('LAYOUT', () => {
  it('2 cm buttons, a 3 cm take-off zone, 600 px tablet threshold, a ≈30 % phone column and a 25 % tablet column, the top 15 % for the HUD', () => {
    expect(LAYOUT).toMatchObject({
      minButtonPx: 76,
      minTapPx: 113,
      tabletMinShortSidePx: 600,
      phoneColumnFraction: 0.3,
      tabletColumnFraction: 0.25,
      hudTopFraction: 0.15,
      gearMarginPx: 8,
    });
  });

  it('no edge buttons any more: the K1 phone edge fraction is gone from the contract', () => {
    expect(LAYOUT).not.toHaveProperty('phoneEdgeFraction');
  });
});

describe('deviceFor', () => {
  it('an iPhone 16e in landscape (844×390) is a phone', () => {
    expect(deviceFor(844, 390)).toBe('phone');
  });

  it('an iPad mini in landscape (1133×744) is a tablet', () => {
    expect(deviceFor(1133, 744)).toBe('tablet');
  });

  it('goes by the shorter side: a portrait phone (390×844) is still a phone', () => {
    expect(deviceFor(390, 844)).toBe('phone');
  });

  it('a shorter side of exactly 600 px counts as a tablet, 599 px as a phone', () => {
    expect(deviceFor(600, 1000)).toBe('tablet');
    expect(deviceFor(599, 1000)).toBe('phone');
  });
});

describe('needsRotation', () => {
  it('portrait needs the rotate overlay', () => {
    expect(needsRotation(390, 844)).toBe(true);
  });

  it('landscape does not', () => {
    expect(needsRotation(844, 390)).toBe(false);
  });

  it('a square counts as landscape', () => {
    expect(needsRotation(500, 500)).toBe(false);
  });
});

/** The target phone areas of K1.1 step 1: an iPhone 16e, a small iPhone, the small iPhone with the Safari bars showing. */
const PHONE_TARGETS: { name: string; width: number; height: number }[] = [
  { name: 'iPhone 16e landscape', width: 844, height: 390 },
  { name: 'iPhone SE landscape', width: 667, height: 375 },
  { name: 'iPhone SE landscape with the Safari bars showing', width: 667, height: 320 },
];

/** The tablet areas the layout keeps from K1. */
const TABLET_TARGETS: { name: string; width: number; height: number }[] = [
  { name: 'iPad mini landscape', width: 1133, height: 744 },
  { name: 'iPad landscape', width: 1180, height: 820 },
];

describe('layoutFor on a phone (844×390)', () => {
  it('reports the device and echoes the viewport', () => {
    const layout = layoutFor(844, 390);
    expect(layout.device).toBe('phone');
    expect(layout.width).toBe(844);
    expect(layout.height).toBe(390);
  });

  it('the gear is a square of max(2 cm, 20% of the height) = 78 px in the bottom-right corner with an 8 px margin', () => {
    const { gear } = layoutFor(844, 390).zones;
    expectRect(gear, 844 - 78 - 8, 390 - 78 - 8, 78, 78);
    expect(gear.w).toBe(gear.h);
    expect(gear.w).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
  });

  it('on a small phone (667×375) the 2 cm floor wins over 20% of the height: a 76 px gear square', () => {
    const { gear } = layoutFor(667, 375).zones;
    expectRect(gear, 667 - 76 - 8, 375 - 76 - 8, 76, 76);
  });

  it('on a short viewport (667×320, the Safari bars showing) the pace square keeps its 2 cm in the corner', () => {
    expectRect(layoutFor(667, 320).zones.gear, 667 - 76 - 8, 320 - 76 - 8, 76, 76);
  });

  it('an explicit device overrides the detection: the tablet layout on a phone viewport is the 25 % column', () => {
    const { device, zones } = layoutFor(844, 390, 'tablet');
    expect(device).toBe('tablet');
    expectPx(zones['turn-left'].x, 0);
    expectPx(zones['turn-right'].x, zones['turn-left'].w);
    expectPx(zones['turn-right'].x + zones['turn-right'].w, 0.25 * 844);
  });
});

describe('layoutFor on the target phone areas: two thumbs (K1.1 step 1)', () => {
  it.each(PHONE_TARGETS)('Left and Right side by side in the left column, Left at the edge and Right right next to it ($name $width×$height)', ({ width, height }) => {
    const { zones } = layoutFor(width, height);
    const left = zones['turn-left'];
    const right = zones['turn-right'];
    expectPx(left.x, 0);
    expectPx(right.x, left.x + left.w);
    expect(left.x + left.w / 2).toBeLessThan(right.x + right.w / 2);
    expect(right.y).toBe(left.y);
    expect(right.h).toBe(left.h);
  });

  it.each(PHONE_TARGETS)('the column is ≈30 % of the width: Right ends at LAYOUT.phoneColumnFraction of it ($name $width×$height)', ({ width, height }) => {
    const right = layoutFor(width, height).zones['turn-right'];
    expectPx(right.x + right.w, LAYOUT.phoneColumnFraction * width);
  });

  it.each(PHONE_TARGETS)('nothing of the two direction buttons is right of the column: the right edge of the area is not a button any more ($name $width×$height)', ({ width, height }) => {
    const layout = layoutFor(width, height);
    const right = layout.zones['turn-right'];
    const [, y] = centre(right);
    expect(hitTest(layout, width - 1, y)).not.toBe('turn-right');
    expect(hitTest(layout, width - 1, y)).not.toBe('turn-left');
  });

  it.each(PHONE_TARGETS)('each direction button is at least 2×2 cm ($name $width×$height)', ({ width, height }) => {
    const { zones } = layoutFor(width, height);
    for (const control of ['turn-left', 'turn-right'] as const) {
      expect(zones[control].w, `${control} width`).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
      expect(zones[control].h, `${control} height`).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
    }
  });

  it.each(PHONE_TARGETS)('the pace square is at least 2×2 cm in the bottom-right corner ($name $width×$height)', ({ width, height }) => {
    const { gear } = layoutFor(width, height).zones;
    expect(gear.w).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
    expect(gear.h).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
    expectPx(gear.x + gear.w, width - LAYOUT.gearMarginPx);
    expectPx(gear.y + gear.h, height - LAYOUT.gearMarginPx);
  });

  it.each(PHONE_TARGETS)('Jump! is at least 3×3 cm, in the right half, above the pace square and to its left ($name $width×$height)', ({ width, height }) => {
    const { tap, gear } = layoutFor(width, height).zones;
    expect(tap.w).toBeGreaterThanOrEqual(LAYOUT.minTapPx);
    expect(tap.h).toBeGreaterThanOrEqual(LAYOUT.minTapPx);
    expect(tap.x).toBeGreaterThanOrEqual(width / 2 - 1);
    expect(tap.x).toBeLessThan(gear.x);
    expect(tap.y).toBeLessThan(gear.y);
  });

  it('negative: a viewport too small for the targets (480×300) still keeps every zone inside and apart, the pace square still 2 cm', () => {
    const { zones } = layoutFor(480, 300);
    for (const control of CONTROLS) expect(inside(zones[control], 480, 300), control).toBe(true);
    expect(zones.gear.w).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
    expect(overlaps(zones['turn-left'], zones['turn-right'])).toBe(false);
  });
});

describe('layoutFor on a tablet (1133×744)', () => {
  it('reports the device and echoes the viewport', () => {
    const layout = layoutFor(1133, 744);
    expect(layout.device).toBe('tablet');
    expect(layout.width).toBe(1133);
    expect(layout.height).toBe(744);
  });

  it('turn-left and turn-right are two adjacent buttons under the left thumb, each half of a 25% column, 50% high and centred', () => {
    const { zones } = layoutFor(1133, 744);
    const w = (0.25 * 1133) / 2;
    expectRect(zones['turn-left'], 0, 0.25 * 744, w, 0.5 * 744);
    expectRect(zones['turn-right'], w, 0.25 * 744, w, 0.5 * 744);
  });

  it('the tap zone keeps the phone fractions', () => {
    expectRect(layoutFor(1133, 744).zones.tap, 0.5 * 1133, 0.15 * 744, 0.32 * 1133, 0.6 * 744);
  });

  it('the gear is a square of 20% of the height (above the 2 cm floor) in the bottom-right corner with the margin', () => {
    const side = Math.max(LAYOUT.minButtonPx, 0.2 * 744);
    const { gear } = layoutFor(1133, 744).zones;
    expectRect(gear, 1133 - side - 8, 744 - side - 8, side, side);
    expect(gear.w).toBe(gear.h);
  });

  it('the tablet buttons end at the lower of 75% of the height and the pace square top: 335 px takes the square (251), 336 px either (252), 340 px the 75% (255)', () => {
    const bottom = (height: number) => {
      const { zones } = layoutFor(667, height, 'tablet');
      return zones['turn-right'].y + zones['turn-right'].h;
    };
    expectPx(bottom(335), 335 - 76 - 8);
    expectPx(bottom(336), 0.75 * 336);
    expectPx(bottom(340), 0.75 * 340);
    expect(bottom(335)).toBeLessThanOrEqual(layoutFor(667, 335, 'tablet').zones.gear.y);
  });
});

describe('layoutFor invariants', () => {
  it.each(VIEWPORTS)('every zone lies inside the viewport ($name $width×$height)', ({ width, height }) => {
    const { zones } = layoutFor(width, height);
    for (const control of CONTROLS) {
      expect(inside(zones[control], width, height), `${control} inside ${width}×${height}`).toBe(true);
    }
  });

  it.each(VIEWPORTS)('no two zones overlap ($name $width×$height)', ({ width, height }) => {
    const { zones } = layoutFor(width, height);
    for (let i = 0; i < CONTROLS.length; i += 1) {
      for (let j = i + 1; j < CONTROLS.length; j += 1) {
        const a = CONTROLS[i];
        const b = CONTROLS[j];
        if (a === undefined || b === undefined) throw new Error('control pair out of range');
        expect(overlaps(zones[a], zones[b]), `${a} overlaps ${b} on ${width}×${height}`).toBe(false);
      }
    }
  });

  it.each(VIEWPORTS)('the gear square is never smaller than 2 cm ($name $width×$height)', ({ width, height }) => {
    const { gear } = layoutFor(width, height).zones;
    expect(gear.w).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
    expect(gear.h).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
  });

  it.each(VIEWPORTS)('the top 15 % of the height is the HUD\'s: no zone starts above it ($name $width×$height)', ({ width, height }) => {
    const { zones } = layoutFor(width, height);
    for (const control of CONTROLS) {
      expect(zones[control].y, `${control} on ${width}×${height}`).toBeGreaterThanOrEqual(LAYOUT.hudTopFraction * height - 0.5);
    }
  });

  it.each([...PHONE_TARGETS, ...TABLET_TARGETS])('the shared invariants of both families: Left left of Right in one column at the left edge, every button 2×2 cm, Jump! 3×3 cm in the right half ($name $width×$height)', ({ width, height }) => {
    const { zones } = layoutFor(width, height);
    expectPx(zones['turn-left'].x, 0);
    expectPx(zones['turn-right'].x, zones['turn-left'].x + zones['turn-left'].w);
    for (const control of ['turn-left', 'turn-right', 'gear'] as const) {
      expect(Math.min(zones[control].w, zones[control].h), control).toBeGreaterThanOrEqual(LAYOUT.minButtonPx);
    }
    expect(Math.min(zones.tap.w, zones.tap.h)).toBeGreaterThanOrEqual(LAYOUT.minTapPx);
    expect(zones.tap.x).toBeGreaterThanOrEqual(width / 2 - 1);
  });
});

describe('hitTest', () => {
  it.each([
    { name: 'phone', width: 844, height: 390 },
    { name: 'tablet', width: 1133, height: 744 },
  ])('the centre of each zone maps to its control ($name)', ({ width, height }) => {
    const layout = layoutFor(width, height);
    for (const control of CONTROLS) {
      const [x, y] = centre(layout.zones[control]);
      expect(hitTest(layout, x, y), `centre of ${control}`).toBe(control);
    }
  });

  it('the left edge at mid-height on a phone is turn-left', () => {
    expect(hitTest(layoutFor(844, 390), 1, 195)).toBe('turn-left');
  });

  it('the top-left corner above the button is dead', () => {
    expect(hitTest(layoutFor(844, 390), 1, 1)).toBeNull();
  });

  it('the middle of the left half outside the buttons is dead', () => {
    expect(hitTest(layoutFor(844, 390), 0.35 * 844, 0.5 * 390)).toBeNull();
  });

  it('a point outside the viewport is null', () => {
    const layout = layoutFor(844, 390);
    expect(hitTest(layout, -1, 195)).toBeNull();
    expect(hitTest(layout, 900, 195)).toBeNull();
    expect(hitTest(layout, 300, 400)).toBeNull();
  });

  it('the smaller zone wins when two contain the point: the gear over the tap zone, an edge button over the tap zone', () => {
    // Built by hand with zones that overlap on purpose: hitTest judges the layout it is given.
    const layout: Layout = {
      device: 'phone',
      width: 844,
      height: 390,
      zones: {
        'turn-left': { x: 0, y: 78, w: 152, h: 234 },
        'turn-right': { x: 692, y: 78, w: 152, h: 234 },
        tap: { x: 422, y: 58, w: 400, h: 300 },
        gear: { x: 758, y: 304, w: 78, h: 78 },
      },
    };
    expect(hitTest(layout, 790, 340)).toBe('gear');
    expect(hitTest(layout, 700, 100)).toBe('turn-right');
    expect(hitTest(layout, 500, 100)).toBe('tap');
  });
});
