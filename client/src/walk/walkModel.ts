// The course walk (reconocimiento, plan 1.7): fences in order with type, the class height, the distance from
// the previous take-off point and the turn before it; the fly-over shows one fence after another over the
// walk's duration.
import { courseTimes, translate, translateKey, type CourseSpec, type HeightClass, type Locale, type TurnSpec } from '@open-jumps/shared';

export interface WalkFence {
  number: number;
  /** "vertical" / "óxer" (terms). */
  typeText: string;
  heightCm: number;
  /** From the start line for fence 1. */
  distanceFromPreviousM: number;
  turnBefore: 'left' | 'right' | null;
  /** "Fence 3: óxer, 70 cm" in the locale. */
  text: string;
  /** "12 m from the previous · turn left before it" in the locale. */
  detail: string;
}

export interface WalkModel {
  title: string;
  fences: WalkFence[];
  lengthM: number;
  allowedSec: number;
  limitSec: number;
  timeText: string;
}

export function walkModel(course: CourseSpec, heightClass: HeightClass, locale: Locale): WalkModel {
  const { allowedSec, limitSec } = courseTimes(course);
  const fences: WalkFence[] = course.fences.map((fence, index) => {
    // The previous take-off point; the start line (0 m) for fence 1.
    const previousM = index === 0 ? 0 : (course.fences[index - 1]?.distanceM ?? 0);
    const turn = turnBetween(course.turns, previousM, fence.distanceM);
    const typeText = translateKey(locale, `walk.fenceType.${fence.type}`);
    const distanceFromPreviousM = fence.distanceM - previousM;
    const distanceText = translate(locale, 'walk.distance', { m: distanceFromPreviousM });
    return {
      number: fence.number,
      typeText,
      heightCm: heightClass,
      distanceFromPreviousM,
      turnBefore: turn === null ? null : turn.direction,
      text: translate(locale, 'walk.fence', { number: fence.number, type: typeText, cm: heightClass }),
      detail: turn === null ? distanceText : `${distanceText} · ${translateKey(locale, `walk.turn.${turn.direction}`)}`,
    };
  });
  return {
    title: translate(locale, 'walk.title'),
    fences,
    lengthM: course.lengthM,
    allowedSec,
    limitSec,
    timeText: translate(locale, 'walk.time', { allowed: allowedSec, limit: limitSec }),
  };
}

/** The turn that lies between the previous take-off point and this one (the nearest to the fence if several). */
function turnBetween(turns: readonly TurnSpec[], previousM: number, fenceM: number): TurnSpec | null {
  let found: TurnSpec | null = null;
  for (const turn of turns) {
    if (turn.distanceM < previousM || turn.distanceM >= fenceM) continue;
    if (found === null || turn.distanceM > found.distanceM) found = turn;
  }
  return found;
}

/** The fence (1-based) the fly-over focuses on at elapsedMs of a walkMs walk: equal shares, the last fence until the end. */
export function walkFocus(walkMs: number, fenceCount: number, elapsedMs: number): number {
  const count = Math.max(1, Math.floor(fenceCount));
  if (!(walkMs > 0) || !(elapsedMs > 0)) return 1;
  if (elapsedMs >= walkMs) return count;
  return Math.min(count, Math.floor((elapsedMs / walkMs) * count) + 1);
}
