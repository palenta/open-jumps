// The course walk (reconocimiento, plan 1.7): every fence in order with its type as a term, the class height,
// the distance from the previous take-off point (from the start line for fence 1), the turn before it, and the
// time allowed and limit from the shared course rules; the fly-over focuses on one fence after another.
import { courseTimes, type CourseSpec } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { walkFocus, walkModel } from '../src/walk/walkModel.js';

const course: CourseSpec = {
  id: 'walk',
  version: 1,
  lengthM: 120,
  speedMPerMin: 300,
  fences: [
    { number: 1, distanceM: 30, type: 'vertical' },
    { number: 2, distanceM: 60, type: 'oxer' },
    { number: 3, distanceM: 100, type: 'vertical' },
  ],
  turns: [{ distanceM: 45, direction: 'left' }],
};

describe('walkModel', () => {
  it('is titled with the term in both locales', () => {
    expect(walkModel(course, 70, 'en').title).toBe('reconocimiento');
    expect(walkModel(course, 70, 'es').title).toBe('reconocimiento');
  });

  it('lists the fences in course order', () => {
    expect(walkModel(course, 70, 'en').fences.map((fence) => fence.number)).toEqual([1, 2, 3]);
  });

  it('fence 1: type, the class height, the distance from the start, no turn', () => {
    const [first] = walkModel(course, 70, 'en').fences;
    expect(first).toEqual({
      number: 1,
      typeText: 'vertical',
      heightCm: 70,
      distanceFromPreviousM: 30,
      turnBefore: null,
      text: 'Fence 1: vertical, 70 cm',
      detail: '30 m from the previous',
    });
  });

  it('fence 2: an oxer as a term, the distance from fence 1, the turn that lies between them', () => {
    const [, second] = walkModel(course, 70, 'en').fences;
    expect(second).toEqual({
      number: 2,
      typeText: 'óxer',
      heightCm: 70,
      distanceFromPreviousM: 30,
      turnBefore: 'left',
      text: 'Fence 2: óxer, 70 cm',
      detail: '30 m from the previous · turn left before it',
    });
  });

  it('fence 3: the distance from fence 2, no turn', () => {
    const [, , third] = walkModel(course, 70, 'en').fences;
    expect(third?.distanceFromPreviousM).toBe(40);
    expect(third?.turnBefore).toBeNull();
    expect(third?.text).toBe('Fence 3: vertical, 70 cm');
    expect(third?.detail).toBe('40 m from the previous');
  });

  it('a right turn is named as such', () => {
    const rightTurn: CourseSpec = { ...course, turns: [{ distanceM: 45, direction: 'right' }] };
    const [, second] = walkModel(rightTurn, 70, 'en').fences;
    expect(second?.turnBefore).toBe('right');
    expect(second?.detail).toBe('30 m from the previous · turn right before it');
    expect(walkModel(rightTurn, 70, 'es').fences[1]?.detail).toBe('a 30 m del anterior · gira a la derecha antes');
  });

  it('every fence stands at the class height', () => {
    for (const fence of walkModel(course, 80, 'en').fences) expect(fence.heightCm).toBe(80);
    expect(walkModel(course, 80, 'en').fences[0]?.text).toBe('Fence 1: vertical, 80 cm');
  });

  it('length, time allowed and limit come from the shared course rules', () => {
    const model = walkModel(course, 70, 'en');
    expect(model.lengthM).toBe(120);
    expect(model.allowedSec).toBe(24);
    expect(model.limitSec).toBe(48);
    expect({ allowedSec: model.allowedSec, limitSec: model.limitSec }).toEqual(courseTimes(course));
    expect(model.timeText).toBe('Time allowed 24 s · limit 48 s');
  });

  it('Spanish: the terms stay, the rest is translated', () => {
    const model = walkModel(course, 70, 'es');
    expect(model.fences[1]?.text).toBe('Salto 2: óxer, 70 cm');
    expect(model.fences[1]?.detail).toBe('a 30 m del anterior · gira a la izquierda antes');
    expect(model.fences[0]?.detail).toBe('a 30 m del anterior');
    expect(model.timeText).toBe('Tiempo concedido 24 s · límite 48 s');
  });
});

describe('walkFocus', () => {
  it('gives each fence an equal share of the walk', () => {
    expect(walkFocus(10_000, 3, 0)).toBe(1);
    expect(walkFocus(10_000, 3, 3_400)).toBe(2);
    expect(walkFocus(10_000, 3, 9_999)).toBe(3);
  });

  it('stays on the last fence from the end of the walk onwards', () => {
    expect(walkFocus(10_000, 3, 10_000)).toBe(3);
    expect(walkFocus(10_000, 3, 25_000)).toBe(3);
  });

  it('stays on the first fence before the walk starts', () => {
    expect(walkFocus(10_000, 3, -1)).toBe(1);
  });

  it('a single fence is the focus throughout', () => {
    expect(walkFocus(10_000, 1, 5_000)).toBe(1);
  });
});
