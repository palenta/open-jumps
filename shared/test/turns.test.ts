// Turns with timing (plan 1.8 item 0): the turn constants and judgeTurn's four qualities for both directions.
import { describe, expect, it } from 'vitest';
import type { TurnDirection } from '../src/rules/course.js';
import type { Gear } from '../src/rules/takeoff.js';
import { TURN, judgeTurn, type TurnOutcome } from '../src/rules/turns.js';

const gears: Gear[] = ['collected', 'extended', 'gallop'];
const directions: TurnDirection[] = ['left', 'right'];
const otherWay = (direction: TurnDirection): TurnDirection => (direction === 'left' ? 'right' : 'left');

const wrong: TurnOutcome = { quality: 'wrong', stopSec: 6, hardTurn: true, label: 'recorrido_equivocado' };
const missed: TurnOutcome = { quality: 'missed', stopSec: 4, hardTurn: true, label: 'recto' };
const tight = (hardTurn: boolean): TurnOutcome => ({ quality: 'tight', stopSec: 0, hardTurn, label: 'giro_cerrado' });
const wide: TurnOutcome = { quality: 'wide', stopSec: 0, hardTurn: true, label: 'giro_abierto' };

describe('TURN', () => {
  it('±400 ms tight window, 900 ms late cut-off, 4 s missed stop, 6 s wrong-way stop', () => {
    expect(TURN).toEqual({ windowMs: 400, lateMs: 900, missedStopSec: 4, wrongStopSec: 6 });
  });
});

describe('judgeTurn', () => {
  describe.each(directions)('expected %s', (expected) => {
    it.each(gears)('the other direction is wrong whatever the timing: 6 s stop, hard turn, "recorrido_equivocado" (%s)', (gear) => {
      for (const offset of [-300, 0, 400, 900]) {
        expect(judgeTurn(expected, otherWay(expected), offset, gear)).toEqual(wrong);
      }
    });

    it.each(gears)('no press, "straight", no press in time or a press after +900 ms is missed: 4 s stop, hard turn, "recto" (%s)', (gear) => {
      expect(judgeTurn(expected, null, null, gear)).toEqual(missed);
      expect(judgeTurn(expected, 'straight', 0, gear)).toEqual(missed);
      expect(judgeTurn(expected, 'straight', null, gear)).toEqual(missed);
      expect(judgeTurn(expected, expected, null, gear)).toEqual(missed);
      expect(judgeTurn(expected, expected, 901, gear)).toEqual(missed);
    });

    it.each([-400, 0, 400])('within ±400 ms (%d ms) is tight: no stop, hard turn only at gallop, "giro_cerrado"', (offset) => {
      expect(judgeTurn(expected, expected, offset, 'collected')).toEqual(tight(false));
      expect(judgeTurn(expected, expected, offset, 'extended')).toEqual(tight(false));
      expect(judgeTurn(expected, expected, offset, 'gallop')).toEqual(tight(true));
    });

    it.each([-401, 401, 900])('outside the window but not late (%d ms) is wide: no stop, hard turn, "giro_abierto"', (offset) => {
      for (const gear of gears) {
        expect(judgeTurn(expected, expected, offset, gear)).toEqual(wide);
      }
    });
  });

  it('the outcome has exactly the keys quality, stopSec, hardTurn and label', () => {
    const outcomes = [
      judgeTurn('left', 'left', 0, 'collected'),
      judgeTurn('left', 'left', 600, 'gallop'),
      judgeTurn('left', 'right', 0, 'extended'),
      judgeTurn('right', null, null, 'collected'),
    ];
    for (const outcome of outcomes) {
      expect(Object.keys(outcome).sort()).toEqual(['hardTurn', 'label', 'quality', 'stopSec']);
    }
  });
});
