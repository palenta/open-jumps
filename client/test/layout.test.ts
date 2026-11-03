// Plan 1.12: landscape touch layouts. Phone — one right-hand thumb: direction buttons at the two edges, the
// pace button at least 2×2 cm in the bottom-right corner, the take-off tap in the middle of the right half.
// Tablet — two thumbs: both direction buttons under the left thumb. Portrait asks to rotate the phone.
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
  it('2 cm minimum button, 600 px tablet threshold, 18% phone edges, 25% tablet column, the tap zone in the right half', () => {
    expect(LAYOUT).toEqual({
      minButtonPx: 76,
      tabletMinShortSidePx: 600,
      phoneEdgeFraction: 0.18,
      tabletColumnFraction: 0.25,
      tapZone: { x: 0.5, y: 0.15, w: 0.32, h: 0.6 },
      buttonHeightFraction: 0.5,
      gearMarginPx: 8,
    });
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

describe('layoutFor on a phone (844×390)', () => {
  it('reports the device and echoes the viewport', () => {
    const layout = layoutFor(844, 390);
    expect(layout.device).toBe('phone');
    expect(layout.width).toBe(844);
    expect(layout.height).toBe(390);
  });

  it('turn-left is the left edge, 18% wide, 50% high and vertically centred', () => {
    expectRect(layoutFor(844, 390).zones['turn-left'], 0, 0.25 * 390, 0.18 * 844, 0.5 * 390);
  });

  it('turn-right is the right edge, 18% wide, the same height and centring as turn-left', () => {
    const { zones } = layoutFor(844, 390);
    expectRect(zones['turn-right'], 844 - 0.18 * 844, 0.25 * 390, 0.18 * 844, 0.5 * 390);
    expectPx(zones['turn-right'].x + zones['turn-right'].w, 844);
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

  it('the turn-right button stops above the gear square so that the corner belongs to the gear alone', () => {
    const { zones } = layoutFor(844, 390);
    expect(zones['turn-right'].y + zones['turn-right'].h).toBeLessThanOrEqual(zones.gear.y);
  });

  it('on a short viewport (667×320, the Safari bars showing) the pace square keeps its 2 cm and both direction buttons end at its top', () => {
    const { zones } = layoutFor(667, 320);
    expectRect(zones.gear, 667 - 76 - 8, 320 - 76 - 8, 76, 76); // y = 236, above 75% of the height (240)
    for (const control of ['turn-left', 'turn-right'] as const) {
      expectPx(zones[control].y, 0.25 * 320);
      expectPx(zones[control].y + zones[control].h, zones.gear.y);
    }
  });

  it('the buttons end at the lower of 75% of the height and the pace square top: 335 px takes the square (251), 336 px either (252), 340 px the 75% (255)', () => {
    const bottom = (height: number) => {
      const { zones } = layoutFor(667, height);
      return zones['turn-right'].y + zones['turn-right'].h;
    };
    expectPx(bottom(335), 335 - 76 - 8);
    expectPx(bottom(336), 0.75 * 336);
    expectPx(bottom(340), 0.75 * 340);
    expect(bottom(335)).toBeLessThanOrEqual(layoutFor(667, 335).zones.gear.y);
  });

  it('the tap zone is the central part of the right half: x 50%, y 15%, w 32%, h 60%', () => {
    expectRect(layoutFor(844, 390).zones.tap, 0.5 * 844, 0.15 * 390, 0.32 * 844, 0.6 * 390);
  });

  it('an explicit device overrides the detection: the tablet layout on a phone viewport puts both direction buttons on the left', () => {
    const { device, zones } = layoutFor(844, 390, 'tablet');
    expect(device).toBe('tablet');
    expectPx(zones['turn-left'].x, 0);
    expectPx(zones['turn-right'].x, zones['turn-left'].w);
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
