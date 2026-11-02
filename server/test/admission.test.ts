// Matrix row 1: the doorbell, host decisions, kicks with immediate revocation, unblocking, club auto-admit, capacity.
import { describe, expect, it } from 'vitest';
import { ROOM_CAPACITY, RoomAdmission } from '../src/rooms/admission.js';

const member = { confirmedClubMember: true };
const stranger = { confirmedClubMember: false };

describe('a new room', () => {
  it('admits the host at once, is open, auto-admit off, capacity 16', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1' });
    expect(ROOM_CAPACITY).toBe(16);
    expect(room.hostId).toBe('host');
    expect(room.participants).toEqual(['host']);
    expect(room.entryOpen).toBe(true);
    expect(room.autoAdmitClub).toBe(false);
    expect(room.statusOf('host')).toBe('host');
    expect(room.canAccessState('host')).toBe(true);
  });
});

describe('the doorbell: requestJoin', () => {
  it('a code without the host\'s decision gives pending: no state, no voice', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1' });
    expect(room.requestJoin('kid', stranger)).toEqual({ status: 'pending' });
    expect(room.pending).toEqual(['kid']);
    expect(room.statusOf('kid')).toBe('pending');
    expect(room.canAccessState('kid')).toBe(false);
    expect(room.canGetVoiceToken('kid')).toBe(false);
  });

  it('with auto-admit off even a confirmed club member waits for the host', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1' });
    expect(room.requestJoin('member', member)).toEqual({ status: 'pending' });
  });

  it('with auto-admit on, a confirmed member enters at once; a stranger still waits', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1', autoAdmitClub: true });
    expect(room.requestJoin('member', member)).toEqual({ status: 'admitted' });
    expect(room.canAccessState('member')).toBe(true);
    expect(room.requestJoin('stranger', stranger)).toEqual({ status: 'pending' });
  });

  it('a room without a club never auto-admits', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null, autoAdmitClub: true });
    expect(room.requestJoin('member', member)).toEqual({ status: 'pending' });
  });

  it('closed entry refuses; reopening lets people ring again', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1' });
    expect(room.setEntryOpen('host', false)).toEqual({ ok: true, value: undefined });
    expect(room.requestJoin('kid', stranger)).toEqual({ status: 'rejected', reason: 'closed' });
    room.setEntryOpen('host', true);
    expect(room.requestJoin('kid', stranger)).toEqual({ status: 'pending' });
  });

  it('a full room refuses even confirmed members', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1', autoAdmitClub: true, capacity: 3 });
    expect(room.requestJoin('m1', member)).toEqual({ status: 'admitted' });
    expect(room.requestJoin('m2', member)).toEqual({ status: 'admitted' });
    expect(room.requestJoin('m3', member)).toEqual({ status: 'rejected', reason: 'full' });
    expect(room.requestJoin('s1', stranger)).toEqual({ status: 'rejected', reason: 'full' });
  });

  it('ringing twice is idempotent; an admitted participant is told so', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1' });
    room.requestJoin('kid', stranger);
    expect(room.requestJoin('kid', stranger)).toEqual({ status: 'pending' });
    room.admit('host', 'kid');
    expect(room.requestJoin('kid', stranger)).toEqual({ status: 'rejected', reason: 'already-in' });
    expect(room.requestJoin('host', stranger)).toEqual({ status: 'rejected', reason: 'already-in' });
  });
});

describe('host decisions', () => {
  it('admit and deny are host-only and need a pending request', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null });
    room.requestJoin('kid', stranger);
    room.requestJoin('other', stranger);
    room.admit('host', 'other');
    expect(room.admit('other', 'kid')).toEqual({ ok: false, error: 'forbidden' });
    expect(room.admit('host', 'nobody')).toEqual({ ok: false, error: 'no-request' });
    expect(room.deny('other', 'kid')).toEqual({ ok: false, error: 'forbidden' });
    expect(room.admit('host', 'kid')).toEqual({ ok: true, value: undefined });
    expect(room.participants).toEqual(['host', 'other', 'kid']);
    expect(room.pending).toEqual([]);
  });

  it('deny removes the request; the person may ring again', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null });
    room.requestJoin('kid', stranger);
    expect(room.deny('host', 'kid')).toEqual({ ok: true, value: undefined });
    expect(room.statusOf('kid')).toBe('none');
    expect(room.requestJoin('kid', stranger)).toEqual({ status: 'pending' });
  });

  it('admitting into a full room fails', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null, capacity: 2 });
    room.requestJoin('a', stranger);
    room.requestJoin('b', stranger);
    expect(room.admit('host', 'a')).toEqual({ ok: true, value: undefined });
    expect(room.admit('host', 'b')).toEqual({ ok: false, error: 'full' });
  });

  it('entry and auto-admit toggles are host-only', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1' });
    room.requestJoin('kid', stranger);
    room.admit('host', 'kid');
    expect(room.setEntryOpen('kid', false)).toEqual({ ok: false, error: 'forbidden' });
    expect(room.setAutoAdmitClub('kid', true)).toEqual({ ok: false, error: 'forbidden' });
    expect(room.setAutoAdmitClub('host', true)).toEqual({ ok: true, value: undefined });
    expect(room.autoAdmitClub).toBe(true);
  });
});

describe('kick: immediate revocation, no return by this code', () => {
  it('the kicked person loses state and voice at once and is told to be revoked', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1', autoAdmitClub: true });
    room.requestJoin('member', member);
    const kicked = room.kick('host', 'member');
    expect(kicked).toEqual({ ok: true, value: { accountId: 'member', revoke: ['state', 'voice'] } });
    expect(room.canAccessState('member')).toBe(false);
    expect(room.canGetVoiceToken('member')).toBe(false);
    expect(room.participants).toEqual(['host']);
    expect(room.kicked).toEqual(['member']);
    expect(room.statusOf('member')).toBe('kicked');
  });

  it('a kicked person cannot come back, not even as a confirmed member with auto-admit on', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1', autoAdmitClub: true });
    room.requestJoin('member', member);
    room.kick('host', 'member');
    expect(room.requestJoin('member', member)).toEqual({ status: 'rejected', reason: 'kicked' });
    expect(room.admit('host', 'member')).toEqual({ ok: false, error: 'no-request' });
  });

  it('only the host kicks, only participants can be kicked, the host cannot kick themselves', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null });
    room.requestJoin('a', stranger);
    room.admit('host', 'a');
    expect(room.kick('a', 'host')).toEqual({ ok: false, error: 'forbidden' });
    expect(room.kick('host', 'nobody')).toEqual({ ok: false, error: 'not-participant' });
    expect(room.kick('host', 'host')).toEqual({ ok: false, error: 'cannot-kick-self' });
  });
});

describe('unblock (owner\'s rule: an accidental kick is not a dead end)', () => {
  it('after unblock the person may ring again and needs the host\'s explicit decision, even as a club member with auto-admit', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: 'club-1', autoAdmitClub: true });
    room.requestJoin('member', member);
    room.kick('host', 'member');
    expect(room.unblock('kid', 'member')).toEqual({ ok: false, error: 'forbidden' });
    expect(room.unblock('host', 'nobody')).toEqual({ ok: false, error: 'not-kicked' });
    expect(room.unblock('host', 'member')).toEqual({ ok: true, value: undefined });
    expect(room.kicked).toEqual([]);
    expect(room.requestJoin('member', member)).toEqual({ status: 'pending' });
    expect(room.canAccessState('member')).toBe(false);
    expect(room.admit('host', 'member')).toEqual({ ok: true, value: undefined });
    expect(room.canAccessState('member')).toBe(true);
  });

  it('a second kick after an unblock blocks again', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null });
    room.requestJoin('a', stranger);
    room.admit('host', 'a');
    room.kick('host', 'a');
    room.unblock('host', 'a');
    room.requestJoin('a', stranger);
    room.admit('host', 'a');
    room.kick('host', 'a');
    expect(room.requestJoin('a', stranger)).toEqual({ status: 'rejected', reason: 'kicked' });
  });
});

describe('leaving and host transfer', () => {
  it('when the host leaves, the next participant by join order becomes host', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null });
    for (const id of ['b', 'a', 'c']) {
      room.requestJoin(id, stranger);
      room.admit('host', id);
    }
    room.leave('host');
    expect(room.hostId).toBe('b');
    expect(room.statusOf('b')).toBe('host');
    expect(room.statusOf('host')).toBe('none');
    expect(room.participants).toEqual(['b', 'a', 'c']);
    expect(room.kick('b', 'c')).toEqual({ ok: true, value: { accountId: 'c', revoke: ['state', 'voice'] } });
  });

  it('a person who left may ring again (leaving is not a kick)', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null });
    room.requestJoin('a', stranger);
    room.admit('host', 'a');
    room.leave('a');
    expect(room.statusOf('a')).toBe('none');
    expect(room.requestJoin('a', stranger)).toEqual({ status: 'pending' });
  });

  it('the last participant leaving empties the room', () => {
    const room = new RoomAdmission({ hostId: 'host', clubId: null });
    room.leave('host');
    expect(room.participants).toEqual([]);
    expect(room.hostId).toBe('');
  });
});
