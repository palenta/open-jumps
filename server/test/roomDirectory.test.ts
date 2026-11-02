// Matrix row 1 through the real services: club auto-admit only for confirmed members of the room's club,
// the kick → unblock → explicit decision path, the host's lobby view, retired codes after the room empties.
import { createRng } from '@open-jumps/shared';
import { describe, expect, it } from 'vitest';
import { RoomDirectory } from '../src/http/rooms.js';
import { JoinRateLimiter, RoomCodeRegistry } from '../src/rooms/codes.js';
import { buildServices, registerRider } from './helpers.js';

async function setup() {
  const s = buildServices();
  const papa = (await registerRider(s, 'Papá')).account;
  const maria = (await registerRider(s, 'María')).account;
  const sofia = (await registerRider(s, 'Sofía')).account;
  const outsider = (await registerRider(s, 'Lucas')).account;
  const created = await s.clubs.createClub(papa.id, 'Open Sports Barcelona');
  if (!created.ok) throw new Error(created.error);
  const club = created.value;
  const otherClub = await s.clubs.createClub(outsider.id, 'Otro Club');
  if (!otherClub.ok) throw new Error(otherClub.error);
  await s.clubs.requestJoin(maria.id, club.code);
  await s.clubs.requestJoin(sofia.id, club.code);
  await s.clubs.confirm(papa.id, club.id, maria.id); // María confirmed; Sofía still pending
  return { s, papa, maria, sofia, outsider, club };
}

describe('auto-admit through ClubService + RoomDirectory', () => {
  it('only a confirmed member of the room\'s club is auto-admitted; pending requesters and other clubs wait', async () => {
    const { s, papa, maria, sofia, outsider, club } = await setup();
    const room = s.rooms.createRoom(papa.id, { clubId: club.id, autoAdmitClub: true });
    expect(await s.rooms.requestJoin(room.code, maria.id)).toEqual({ ok: true, value: { status: 'admitted' } });
    expect(await s.rooms.requestJoin(room.code, sofia.id)).toEqual({ ok: true, value: { status: 'pending' } });
    expect(await s.rooms.requestJoin(room.code, outsider.id)).toEqual({ ok: true, value: { status: 'pending' } });
    expect(s.rooms.statusOf(room.code, maria.id)).toBe('admitted');
    expect(s.rooms.statusOf(room.code, sofia.id)).toBe('pending');
  });

  it('after the admin confirms, the member enters automatically; a removed member no longer does', async () => {
    const { s, papa, sofia, club } = await setup();
    const room = s.rooms.createRoom(papa.id, { clubId: club.id, autoAdmitClub: true });
    expect(await s.rooms.requestJoin(room.code, sofia.id)).toEqual({ ok: true, value: { status: 'pending' } });
    s.rooms.hostAction(room.code, papa.id, { type: 'deny', accountId: sofia.id });
    await s.clubs.confirm(papa.id, club.id, sofia.id);
    expect(await s.rooms.requestJoin(room.code, sofia.id)).toEqual({ ok: true, value: { status: 'admitted' } });
    s.rooms.leave(room.code, sofia.id);
    await s.clubs.removeMember(papa.id, club.id, sofia.id);
    expect(await s.rooms.requestJoin(room.code, sofia.id)).toEqual({ ok: true, value: { status: 'pending' } });
  });

  it('a room created without auto-admit keeps every member at the door', async () => {
    const { s, papa, maria, club } = await setup();
    const room = s.rooms.createRoom(papa.id, { clubId: club.id });
    expect(await s.rooms.requestJoin(room.code, maria.id)).toEqual({ ok: true, value: { status: 'pending' } });
    s.rooms.hostAction(room.code, papa.id, { type: 'auto-admit', on: true });
    s.rooms.hostAction(room.code, papa.id, { type: 'deny', accountId: maria.id });
    expect(await s.rooms.requestJoin(room.code, maria.id)).toEqual({ ok: true, value: { status: 'admitted' } });
  });

  it('kick → rejected; unblock → pending even for a confirmed member with auto-admit on; host decides', async () => {
    const { s, papa, maria, club } = await setup();
    const room = s.rooms.createRoom(papa.id, { clubId: club.id, autoAdmitClub: true });
    await s.rooms.requestJoin(room.code, maria.id);
    const revoked: string[] = [];
    s.rooms.onRevoke((_roomId, revocation) => revoked.push(revocation.accountId));
    expect(s.rooms.hostAction(room.code, papa.id, { type: 'kick', accountId: maria.id })).toEqual({ ok: true, value: undefined });
    expect(revoked).toEqual([maria.id]);
    expect(await s.rooms.requestJoin(room.code, maria.id)).toEqual({ ok: true, value: { status: 'rejected', reason: 'kicked' } });
    expect(s.rooms.hostAction(room.code, papa.id, { type: 'unblock', accountId: maria.id })).toEqual({ ok: true, value: undefined });
    expect(await s.rooms.requestJoin(room.code, maria.id)).toEqual({ ok: true, value: { status: 'pending' } });
    expect(s.rooms.hostAction(room.code, papa.id, { type: 'admit', accountId: maria.id })).toEqual({ ok: true, value: undefined });
    expect(s.rooms.statusOf(room.code, maria.id)).toBe('admitted');
  });
});

describe('lobby view (host only) and public data', () => {
  it('the host sees participants, pending and kicked as public profiles plus the confirmed club by name; others are refused', async () => {
    const { s, papa, maria, sofia, outsider, club } = await setup();
    const room = s.rooms.createRoom(papa.id, { clubId: club.id });
    await s.rooms.requestJoin(room.code, maria.id); // confirmed member of Open Sports Barcelona
    await s.rooms.requestJoin(room.code, sofia.id); // only a pending request in that club → no club
    await s.rooms.requestJoin(room.code, outsider.id); // admin, hence confirmed member, of "Otro Club"
    s.rooms.hostAction(room.code, papa.id, { type: 'admit', accountId: sofia.id });
    s.rooms.hostAction(room.code, papa.id, { type: 'kick', accountId: sofia.id });
    const view = await s.rooms.lobbyView(room.code, papa.id);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.participants.map((p) => p.riderName)).toEqual(['Papá']);
    expect(view.value.pending.map((p) => p.riderName)).toEqual(['María', 'Lucas']);
    expect(view.value.kicked.map((p) => p.riderName)).toEqual(['Sofía']);
    for (const person of [...view.value.participants, ...view.value.pending, ...view.value.kicked]) {
      expect(Object.keys(person).sort()).toEqual(['club', 'clubId', 'id', 'ponyCategory', 'ponyGender', 'ponyName', 'riderGender', 'riderName']);
    }
    expect(view.value.participants[0]!.club).toEqual({ id: club.id, name: 'Open Sports Barcelona' });
    expect(view.value.pending[0]!.club).toEqual({ id: club.id, name: 'Open Sports Barcelona' });
    expect(view.value.pending[1]!.club).toEqual({ id: expect.any(String), name: 'Otro Club' });
    expect(view.value.pending[1]!.club?.id).not.toBe(club.id);
    expect(view.value.kicked[0]!.club).toBeNull();
    expect(JSON.stringify(view.value)).not.toContain(club.code);
    expect(await s.rooms.lobbyView(room.code, maria.id)).toEqual({ ok: false, error: 'forbidden' });
    expect(await s.rooms.lobbyView('ZZZZZZ', papa.id)).toEqual({ ok: false, error: 'unknown-code' });
  });

  it('club summaries expose id and name only; confirmedClubOf is null for pending requests', async () => {
    const { s, maria, sofia, outsider, club } = await setup();
    expect(await s.clubs.getClubSummary(club.id)).toEqual({ id: club.id, name: 'Open Sports Barcelona' });
    expect(await s.clubs.getClubSummary('missing')).toBeNull();
    expect(await s.clubs.confirmedClubOf(maria.id)).toEqual({ id: club.id, name: 'Open Sports Barcelona' });
    expect(await s.clubs.confirmedClubOf(sofia.id)).toBeNull();
    expect((await s.clubs.confirmedClubOf(outsider.id))?.name).toBe('Otro Club');
  });
});

describe('rate limit keyed by account and retired codes', () => {
  it('five doorbell attempts per account per minute, then rate-limited; another account is independent', async () => {
    const { s, maria, sofia } = await setup();
    for (let i = 0; i < 5; i += 1) expect(await s.rooms.requestJoin('ZZZZZZ', maria.id)).toEqual({ ok: false, error: 'unknown-code' });
    expect(await s.rooms.requestJoin('ZZZZZZ', maria.id)).toEqual({ ok: false, error: 'rate-limited' });
    expect(await s.rooms.requestJoin('ZZZZZZ', sofia.id)).toEqual({ ok: false, error: 'unknown-code' });
    s.clock.advance(60_001);
    expect(await s.rooms.requestJoin('ZZZZZZ', maria.id)).toEqual({ ok: false, error: 'unknown-code' });
  });

  it('when the last participant leaves, the room closes and its code never resolves again', async () => {
    const { s, papa, maria } = await setup();
    const codes = new RoomCodeRegistry(createRng('dir'));
    const dir = new RoomDirectory({ clock: s.clock.now, rng: createRng('dir'), clubs: s.clubs, accounts: s.accounts, codes, limiter: new JoinRateLimiter(s.clock.now) });
    const room = dir.createRoom(papa.id, { clubId: null });
    await dir.requestJoin(room.code, maria.id);
    dir.hostAction(room.code, papa.id, { type: 'admit', accountId: maria.id });
    dir.leave(room.code, papa.id);
    expect(dir.getByCode(room.code)?.admission.hostId).toBe(maria.id);
    dir.leave(room.code, maria.id);
    expect(dir.getByCode(room.code)).toBeUndefined();
    expect(dir.statusOf(room.code, papa.id)).toBe('unknown-code');
    expect(await dir.requestJoin(room.code, papa.id)).toEqual({ ok: false, error: 'unknown-code' });
    for (let i = 0; i < 20; i += 1) expect(dir.createRoom(papa.id, { clubId: null }).code).not.toBe(room.code);
  });
});

describe('code discovery is limited on every route, not only the doorbell (plan 1.5)', () => {
  it('status, lobby view and host actions on a room you have no relation to look like an unknown code and spend the budget', async () => {
    const { s, papa, maria, sofia, club } = await setup();
    const room = s.rooms.createRoom(papa.id, { clubId: club.id });
    await s.rooms.requestJoin(room.code, maria.id); // María is pending: related to the room
    expect(s.rooms.statusOf(room.code, sofia.id)).toBe('unknown-code'); // probe 1
    expect(await s.rooms.lobbyView(room.code, sofia.id)).toEqual({ ok: false, error: 'unknown-code' }); // probe 2
    expect(s.rooms.hostAction(room.code, sofia.id, { type: 'admit', accountId: maria.id })).toEqual({ ok: false, error: 'unknown-code' }); // probe 3
    expect(s.rooms.statusOf('ZZZZZZ', sofia.id)).toBe('unknown-code'); // probe 4
    expect(s.rooms.hostAction(room.code, sofia.id, { type: 'entry', open: false })).toEqual({ ok: false, error: 'unknown-code' }); // probe 5
    expect(s.rooms.statusOf(room.code, sofia.id)).toBe('rate-limited');
    expect(await s.rooms.lobbyView(room.code, sofia.id)).toEqual({ ok: false, error: 'rate-limited' });
    expect(await s.rooms.requestJoin(room.code, sofia.id)).toEqual({ ok: false, error: 'rate-limited' });
    expect(s.rooms.hostAction(room.code, sofia.id, { type: 'admit', accountId: maria.id })).toEqual({ ok: false, error: 'rate-limited' });
    expect(room.admission.entryOpen).toBe(true);
    // Related accounts are never charged: María polls her pending request freely; the host works freely.
    for (let i = 0; i < 20; i += 1) expect(s.rooms.statusOf(room.code, maria.id)).toBe('pending');
    expect(await s.rooms.lobbyView(room.code, maria.id)).toEqual({ ok: false, error: 'forbidden' });
    expect(s.rooms.hostAction(room.code, maria.id, { type: 'admit', accountId: maria.id })).toEqual({ ok: false, error: 'forbidden' });
    for (let i = 0; i < 20; i += 1) expect(s.rooms.statusOf(room.code, papa.id)).toBe('host');
    expect((await s.rooms.lobbyView(room.code, papa.id)).ok).toBe(true);
    s.clock.advance(60_001);
    expect(await s.rooms.requestJoin(room.code, sofia.id)).toEqual({ ok: true, value: { status: 'pending' } });
    for (let i = 0; i < 20; i += 1) expect(s.rooms.statusOf(room.code, sofia.id)).toBe('pending');
  });

  it('a known code never refills the budget: four misses, own room, four misses still trips the limit', async () => {
    const { s, papa, club } = await setup();
    const room = s.rooms.createRoom(papa.id, { clubId: club.id });
    for (let i = 0; i < 4; i += 1) expect(await s.rooms.requestJoin('ZZZZZZ', papa.id)).toEqual({ ok: false, error: 'unknown-code' });
    expect(await s.rooms.requestJoin(room.code, papa.id)).toEqual({ ok: true, value: { status: 'rejected', reason: 'already-in' } });
    expect(await s.rooms.requestJoin('ZZZZZZ', papa.id)).toEqual({ ok: false, error: 'unknown-code' });
    for (let i = 0; i < 3; i += 1) expect(await s.rooms.requestJoin('ZZZZZZ', papa.id)).toEqual({ ok: false, error: 'rate-limited' });
    expect(s.rooms.statusOf(room.code, papa.id)).toBe('host'); // the host's own room stays free of charge
    expect((await s.rooms.lobbyView(room.code, papa.id)).ok).toBe(true);
  });
});
