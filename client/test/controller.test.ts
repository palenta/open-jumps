// Plan 1.8, 1.12, 2.3: from a press on a control to a room message. The take-off tap is armed by the server's
// 'approach' event for the own horse, stamped with the device clock and sent once per approach (audit K1 r1 #1:
// a press outside an open approach is nothing — it neither goes out nor spends the next attempt's tap); 'left' /
// 'right' are a turn inside a turn window and a line shift outside it; the pace button cycles the gear. Nothing
// is sent when the rider is not riding.
import { describe, expect, it } from 'vitest';
import { INPUT, InputController, type RiderInputState } from '../src/input/controller.js';
import type { Control } from '../src/input/layout.js';
import type { ClientRoomMessage } from '../src/net/types.js';

/** A controller whose sent messages are collected. */
function controller(): { input: InputController; sent: ClientRoomMessage[] } {
  const sent: ClientRoomMessage[] = [];
  const input = new InputController({ send: (message) => sent.push(message) });
  return { input, sent };
}

const riding = (nextFence: number, attempt: number, round = '1#0'): RiderInputState => ({ riding: true, round, nextFence, attempt });

/** A controller already riding towards fence 1, attempt 1 (no approach open yet). */
function ridingController(): { input: InputController; sent: ClientRoomMessage[] } {
  const c = controller();
  c.input.update(riding(1, 1));
  return c;
}

/** A controller riding with the approach of fence 1, attempt 1 open: the tap is armed. */
function armedController(): { input: InputController; sent: ClientRoomMessage[] } {
  const c = ridingController();
  c.input.approach({ fence: 1, attempt: 1 });
  return c;
}

describe('INPUT', () => {
  it('a 3.5 s turn window and the gear order collected → extended → gallop', () => {
    expect(INPUT).toEqual({ turnWindowMs: 3500, gearOrder: ['collected', 'extended', 'gallop'] });
  });
});

describe('InputController before riding', () => {
  it('ignores every control before the first update(): null and nothing sent', () => {
    const { input, sent } = controller();
    for (const control of ['tap', 'gear', 'turn-left', 'turn-right'] as const) {
      expect(input.press(control, 6000)).toBeNull();
    }
    expect(sent).toEqual([]);
  });

  it('ignores every control while riding is false, even inside a turn window and with an approach open', () => {
    const { input, sent } = controller();
    input.update({ riding: false, round: '1#0', nextFence: 1, attempt: 1 });
    input.approach({ fence: 1, attempt: 1 });
    input.turnAhead(7000);
    for (const control of ['tap', 'gear', 'turn-left', 'turn-right'] as const) {
      expect(input.press(control, 7100)).toBeNull();
    }
    expect(sent).toEqual([]);
    expect(input.requestedGear).toBe('collected');
    expect(input.requestedLine).toBe('center');
  });

  it('starts from the collected gear and the centre line', () => {
    const { input } = controller();
    expect(input.requestedGear).toBe('collected');
    expect(input.requestedLine).toBe('center');
  });
});

describe('InputController tap', () => {
  it('sends the tap stamped with the device clock and keyed by the fence and attempt of the open approach', () => {
    const { input, sent } = armedController();
    const message: ClientRoomMessage = { type: 'tap', clientTime: 6010, fence: 1, attempt: 1 };
    expect(input.press('tap', 6010)).toEqual(message);
    expect(sent).toEqual([message]);
  });

  it('sends only the first tap of an approach: the second is null and not sent', () => {
    const { input, sent } = armedController();
    input.press('tap', 6010);
    expect(input.press('tap', 6020)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('a repeated update with the same fence and attempt does not re-arm the tap', () => {
    const { input, sent } = armedController();
    input.press('tap', 6010);
    input.update(riding(1, 1));
    expect(input.press('tap', 6020)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('a new attempt of the same fence (after a refusal) is armed by its own approach', () => {
    const { input, sent } = armedController();
    input.press('tap', 6010);
    input.approachClosed();
    input.update(riding(1, 2));
    expect(input.press('tap', 8000)).toBeNull(); // the horse stands after the refusal: no approach is open
    input.approach({ fence: 1, attempt: 2 });
    expect(input.press('tap', 9000)).toEqual({ type: 'tap', clientTime: 9000, fence: 1, attempt: 2 });
    expect(sent).toHaveLength(2);
  });

  it('the next fence is armed by its own approach', () => {
    const { input, sent } = armedController();
    input.press('tap', 6010);
    input.approachClosed();
    input.update(riding(2, 1));
    input.approach({ fence: 2, attempt: 1 });
    expect(input.press('tap', 12_000)).toEqual({ type: 'tap', clientTime: 12_000, fence: 2, attempt: 1 });
    expect(sent).toHaveLength(2);
  });
});

describe('InputController tap outside an open approach (audit K1 r1 #1)', () => {
  it('before the first approach a press is null, nothing is sent, and the approach that follows still gets its tap', () => {
    const { input, sent } = ridingController();
    expect(input.press('tap', 5000)).toBeNull();
    expect(input.press('tap', 5500)).toBeNull();
    expect(sent).toEqual([]);
    input.approach({ fence: 1, attempt: 1 });
    expect(input.press('tap', 6010)).toEqual({ type: 'tap', clientTime: 6010, fence: 1, attempt: 1 });
    expect(sent).toHaveLength(1);
  });

  it('a fence cleared → an early press during the flight (the state already says fence 2) is nothing → the approach of fence 2 arms the tap and it goes out', () => {
    const { input, sent } = armedController();
    expect(input.press('tap', 6000)).toMatchObject({ type: 'tap', fence: 1, attempt: 1 });
    input.approachClosed(); // the verdict: cleared; the horse is in flight for 600 ms
    input.update(riding(2, 1)); // the state advanced to fence 2 at the decision
    expect(input.press('tap', 6200)).toBeNull();
    expect(input.press('tap', 6400)).toBeNull();
    expect(sent).toHaveLength(1);
    input.approach({ fence: 2, attempt: 1 });
    expect(input.press('tap', 12_000)).toEqual({ type: 'tap', clientTime: 12_000, fence: 2, attempt: 1 });
    expect(sent.map((m) => m.type)).toEqual(['tap', 'tap']);
  });

  it('the tap carries the fence and attempt of the approach, not of a state patch that lags behind it', () => {
    const { input } = ridingController(); // the state still says fence 1, attempt 1
    input.approach({ fence: 1, attempt: 2 });
    expect(input.press('tap', 9000)).toEqual({ type: 'tap', clientTime: 9000, fence: 1, attempt: 2 });
  });

  it('after the verdict closed the approach a press is nothing until the next approach, whatever the state says', () => {
    const { input, sent } = armedController();
    input.approachClosed(); // no tap in time: the server decided by itself
    expect(input.press('tap', 6800)).toBeNull();
    input.update(riding(1, 2));
    expect(input.press('tap', 7000)).toBeNull();
    expect(sent).toEqual([]);
  });

  it('the other controls do not need an approach: the pace button and the line still work between fences', () => {
    const { input, sent } = ridingController();
    expect(input.press('gear', 6000)).toEqual({ type: 'gear', gear: 'extended' });
    expect(input.press('turn-left', 6100)).toEqual({ type: 'line', line: 'angle' });
    expect(sent).toHaveLength(2);
  });
});

describe('InputController gear', () => {
  it('cycles collected → extended → gallop → collected, sending each and tracking requestedGear', () => {
    const { input, sent } = ridingController();
    expect(input.requestedGear).toBe('collected');
    expect(input.press('gear', 6000)).toEqual({ type: 'gear', gear: 'extended' });
    expect(input.requestedGear).toBe('extended');
    expect(input.press('gear', 6100)).toEqual({ type: 'gear', gear: 'gallop' });
    expect(input.requestedGear).toBe('gallop');
    expect(input.press('gear', 6200)).toEqual({ type: 'gear', gear: 'collected' });
    expect(input.requestedGear).toBe('collected');
    expect(sent).toEqual([
      { type: 'gear', gear: 'extended' },
      { type: 'gear', gear: 'gallop' },
      { type: 'gear', gear: 'collected' },
    ]);
  });

  it('an ignored gear press (not riding) leaves requestedGear unchanged', () => {
    const { input } = controller();
    input.update({ riding: false, round: '1#0', nextFence: 1, attempt: 1 });
    expect(input.press('gear', 6000)).toBeNull();
    expect(input.requestedGear).toBe('collected');
  });
});

describe('InputController direction buttons outside a turn window', () => {
  it('turn-left toggles the line: angle, then centre again', () => {
    const { input, sent } = ridingController();
    expect(input.press('turn-left', 6000)).toEqual({ type: 'line', line: 'angle' });
    expect(input.requestedLine).toBe('angle');
    expect(input.press('turn-left', 6100)).toEqual({ type: 'line', line: 'center' });
    expect(input.requestedLine).toBe('center');
    expect(sent).toEqual([
      { type: 'line', line: 'angle' },
      { type: 'line', line: 'center' },
    ]);
  });

  it('turn-right toggles the same line: both buttons share one centre ↔ angle state', () => {
    const { input } = ridingController();
    expect(input.press('turn-right', 6000)).toEqual({ type: 'line', line: 'angle' });
    expect(input.press('turn-left', 6100)).toEqual({ type: 'line', line: 'center' });
    expect(input.press('turn-right', 6200)).toEqual({ type: 'line', line: 'angle' });
    expect(input.requestedLine).toBe('angle');
  });
});

describe('InputController direction buttons inside a turn window', () => {
  it('a press after turnAhead sends the turn with the device time and closes the window', () => {
    const { input, sent } = ridingController();
    input.turnAhead(7000);
    expect(input.press('turn-left', 7100)).toEqual({ type: 'turn', choice: 'left', clientTime: 7100 });
    expect(input.press('turn-right', 7200)).toEqual({ type: 'line', line: 'angle' });
    expect(sent).toEqual([
      { type: 'turn', choice: 'left', clientTime: 7100 },
      { type: 'line', line: 'angle' },
    ]);
  });

  it('turn-right inside the window is a right turn', () => {
    const { input } = ridingController();
    input.turnAhead(7000);
    expect(input.press('turn-right', 7050)).toEqual({ type: 'turn', choice: 'right', clientTime: 7050 });
  });

  it('a turn press does not change the requested line', () => {
    const { input } = ridingController();
    input.turnAhead(7000);
    input.press('turn-left', 7100);
    expect(input.requestedLine).toBe('center');
  });

  it('the window is open strictly before now + turnWindowMs: a press at 3499 ms is a turn, at 3500 ms a line toggle', () => {
    const early = ridingController();
    early.input.turnAhead(7000);
    expect(early.input.press('turn-right', 7000 + INPUT.turnWindowMs - 1)).toEqual({ type: 'turn', choice: 'right', clientTime: 7000 + INPUT.turnWindowMs - 1 });

    const late = ridingController();
    late.input.turnAhead(7000);
    expect(late.input.press('turn-right', 7000 + INPUT.turnWindowMs)).toEqual({ type: 'line', line: 'angle' });
  });

  it('turnTaken() closes the window early: the next press is a line toggle', () => {
    const { input } = ridingController();
    input.turnAhead(7000);
    input.turnTaken();
    expect(input.press('turn-left', 7100)).toEqual({ type: 'line', line: 'angle' });
  });

  it('a new turnAhead reopens the window after it closed', () => {
    const { input } = ridingController();
    input.turnAhead(7000);
    input.turnTaken();
    input.turnAhead(20_000);
    expect(input.press('turn-left', 20_100)).toEqual({ type: 'turn', choice: 'left', clientTime: 20_100 });
  });
});

describe('InputController unknown control', () => {
  it('a press on an unknown control is null and sends nothing', () => {
    const { input, sent } = ridingController();
    expect(input.press('nope' as Control, 6000)).toBeNull();
    expect(sent).toEqual([]);
  });
});

describe('InputController across classes', () => {
  it('a new round key drops the open approach: the next class starts at fence 1 again, armed by its own approach', () => {
    const { input, sent } = armedController();
    expect(input.press('tap', 6010)).toEqual({ type: 'tap', clientTime: 6010, fence: 1, attempt: 1 });
    input.update(riding(1, 1)); // the same round again: still armed against a second tap
    expect(input.press('tap', 6020)).toBeNull();
    input.update(riding(1, 1, '2#0')); // the next class, its first heat
    expect(input.press('tap', 90_000)).toBeNull(); // no approach of the new class yet
    input.approach({ fence: 1, attempt: 1 });
    expect(input.press('tap', 90_010)).toEqual({ type: 'tap', clientTime: 90_010, fence: 1, attempt: 1 });
    expect(sent.map((m) => m.type)).toEqual(['tap', 'tap']);
  });

  it('a new heat of the same class is a new round too', () => {
    const { input } = armedController();
    input.press('tap', 6010);
    input.update(riding(1, 1, '1#1'));
    input.approach({ fence: 1, attempt: 1 });
    expect(input.press('tap', 60_010)).toMatchObject({ type: 'tap', fence: 1, attempt: 1 });
  });

  it('an approach of the old round is not carried into the new one', () => {
    const { input, sent } = armedController();
    input.update(riding(1, 1, '1#1'));
    expect(input.press('tap', 60_000)).toBeNull();
    expect(sent).toEqual([]);
  });
});
