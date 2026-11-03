// Matrix rows 1 and 21: the club code only creates a request; the admin confirms; admin rights are enforced.
import { describe, expect, it } from 'vitest';
import { CLUB_CODE } from '../src/clubs/clubs.js';
import { createMemoryRepositories } from '../src/storage/memory.js';
import type { Repositories } from '../src/storage/repositories.js';
import { createSqliteRepositories } from '../src/storage/sqlite.js';
import { buildServices, registerRider } from './helpers.js';

async function setup() {
  const s = buildServices();
  const admin = (await registerRider(s, 'Papá')).account;
  const kid = (await registerRider(s, 'María')).account;
  const friend = (await registerRider(s, 'Sofía')).account;
  const created = await s.clubs.createClub(admin.id, 'Open Sports Barcelona');
  if (!created.ok) throw new Error(created.error);
  return { s, admin, kid, friend, club: created.value };
}

describe('createClub', () => {
  it('the creator becomes admin and a confirmed member; the code is 8 unambiguous characters', async () => {
    const { s, admin, club } = await setup();
    expect(club.adminAccountId).toBe(admin.id);
    expect(club.code).toMatch(new RegExp(`^[${CLUB_CODE.alphabet}]{${CLUB_CODE.length}}$`));
    expect(await s.clubs.isConfirmedMember(club.id, admin.id)).toBe(true);
    expect((await s.repos.accounts.getById(admin.id))?.clubId).toBe(club.id);
  });

  it('club names pass the filter and are unique', async () => {
    const { s, admin } = await setup();
    expect(await s.clubs.createClub(admin.id, 'open sports barcelona')).toEqual({ ok: false, error: 'name-taken' });
    expect(await s.clubs.createClub(admin.id, 'puta')).toEqual({ ok: false, error: 'name-not-allowed' });
  });
});

describe('requestJoin and confirm', () => {
  it('entering the code creates a pending request only; membership comes from the admin', async () => {
    const { s, admin, kid, club } = await setup();
    const request = await s.clubs.requestJoin(kid.id, club.code);
    expect(request.ok && request.value.status).toBe('pending');
    expect(await s.clubs.isConfirmedMember(club.id, kid.id)).toBe(false);
    const confirmed = await s.clubs.confirm(admin.id, club.id, kid.id);
    expect(confirmed.ok && confirmed.value.status).toBe('member');
    expect(await s.clubs.isConfirmedMember(club.id, kid.id)).toBe(true);
    expect((await s.repos.accounts.getById(kid.id))?.clubId).toBe(club.id);
  });

  it('an unknown code is refused; repeated requests and already-members are reported', async () => {
    const { s, admin, kid, club } = await setup();
    expect(await s.clubs.requestJoin(kid.id, 'ZZZZZZZZ')).toEqual({ ok: false, error: 'unknown-code' });
    await s.clubs.requestJoin(kid.id, club.code);
    expect(await s.clubs.requestJoin(kid.id, club.code)).toEqual({ ok: false, error: 'already-pending' });
    await s.clubs.confirm(admin.id, club.id, kid.id);
    expect(await s.clubs.requestJoin(kid.id, club.code)).toEqual({ ok: false, error: 'already-member' });
  });

  it('only the admin confirms, rejects, lists requests, removes members or transfers the role (row 21)', async () => {
    const { s, admin, kid, friend, club } = await setup();
    await s.clubs.requestJoin(kid.id, club.code);
    await s.clubs.requestJoin(friend.id, club.code);
    expect(await s.clubs.confirm(friend.id, club.id, kid.id)).toEqual({ ok: false, error: 'forbidden' });
    expect(await s.clubs.listPending(friend.id, club.id)).toEqual({ ok: false, error: 'forbidden' });
    const pending = await s.clubs.listPending(admin.id, club.id);
    expect(pending.ok && pending.value.map((m) => m.accountId).sort()).toEqual([friend.id, kid.id].sort());
    expect(await s.clubs.reject(kid.id, club.id, friend.id)).toEqual({ ok: false, error: 'forbidden' });
    expect(await s.clubs.reject(admin.id, club.id, friend.id)).toEqual({ ok: true, value: undefined });
    expect(await s.repos.clubs.getMembership(club.id, friend.id)).toBeNull();
    expect(await s.clubs.confirm(admin.id, club.id, friend.id)).toEqual({ ok: false, error: 'no-request' });
    await s.clubs.confirm(admin.id, club.id, kid.id);
    expect(await s.clubs.removeMember(kid.id, club.id, admin.id)).toEqual({ ok: false, error: 'forbidden' });
    expect(await s.clubs.removeMember(admin.id, club.id, admin.id)).toEqual({ ok: false, error: 'cannot-remove-admin' });
    expect(await s.clubs.transferAdmin(kid.id, club.id, kid.id)).toEqual({ ok: false, error: 'forbidden' });
    expect(await s.clubs.transferAdmin(admin.id, club.id, friend.id)).toEqual({ ok: false, error: 'not-member' });
    const transferred = await s.clubs.transferAdmin(admin.id, club.id, kid.id);
    expect(transferred.ok && transferred.value.adminAccountId).toBe(kid.id);
    expect(await s.clubs.removeMember(kid.id, club.id, admin.id)).toEqual({ ok: true, value: undefined });
    expect(await s.clubs.isConfirmedMember(club.id, admin.id)).toBe(false);
    expect((await s.repos.accounts.getById(admin.id))?.clubId).toBeNull();
  });

  it('actions on an unknown club are refused', async () => {
    const { s, admin, kid } = await setup();
    expect(await s.clubs.confirm(admin.id, 'missing', kid.id)).toEqual({ ok: false, error: 'unknown-club' });
  });
});

describe('one club per rider (plan 1.5)', () => {
  it('a confirmed member cannot request, be confirmed into, or create another club until they leave', async () => {
    const { s, admin, kid, friend, club } = await setup();
    const other = (await registerRider(s, 'Lucas')).account;
    const created = await s.clubs.createClub(other.id, 'Otro Club');
    if (!created.ok) throw new Error(created.error);
    const otherClub = created.value;
    await s.clubs.requestJoin(kid.id, club.code);
    await s.clubs.confirm(admin.id, club.id, kid.id);
    expect(await s.clubs.requestJoin(kid.id, otherClub.code)).toEqual({ ok: false, error: 'in-another-club' });
    expect(await s.clubs.createClub(kid.id, 'Club de María')).toEqual({ ok: false, error: 'in-another-club' });
    expect(await s.clubs.createClub(admin.id, 'Segundo Club')).toEqual({ ok: false, error: 'in-another-club' });
    expect(await s.repos.clubs.getMembership(otherClub.id, kid.id)).toBeNull();
    // Two pending requests are fine; the first confirmation wins, the second is refused: no hidden rights remain.
    await s.clubs.requestJoin(friend.id, club.code);
    await s.clubs.requestJoin(friend.id, otherClub.code);
    expect((await s.clubs.confirm(other.id, otherClub.id, friend.id)).ok).toBe(true);
    expect(await s.clubs.confirm(admin.id, club.id, friend.id)).toEqual({ ok: false, error: 'in-another-club' });
    expect(await s.clubs.isConfirmedMember(club.id, friend.id)).toBe(false);
    expect((await s.repos.clubs.getMembership(club.id, friend.id))?.status).toBe('pending');
    expect(await s.clubs.confirmedClubOf(friend.id)).toEqual({ id: otherClub.id, name: 'Otro Club' });
    expect((await s.repos.accounts.getById(friend.id))?.clubId).toBe(otherClub.id);
    // Leaving the other club makes the pending request confirmable.
    await s.clubs.removeMember(other.id, otherClub.id, friend.id);
    expect((await s.clubs.confirm(admin.id, club.id, friend.id)).ok).toBe(true);
    expect(await s.clubs.confirmedClubOf(friend.id)).toEqual({ id: club.id, name: 'Open Sports Barcelona' });
    expect(await s.clubs.isConfirmedMember(otherClub.id, friend.id)).toBe(false);
  });

  it('overview: the admin sees role, code, members and pending count; a member sees no code; outsiders have no club', async () => {
    const { s, admin, kid, friend, club } = await setup();
    await s.clubs.requestJoin(kid.id, club.code);
    await s.clubs.confirm(admin.id, club.id, kid.id);
    await s.clubs.requestJoin(friend.id, club.code);
    const asAdmin = await s.clubs.overview(admin.id);
    expect(asAdmin.ok).toBe(true);
    if (!asAdmin.ok) return;
    expect(Object.keys(asAdmin.value).sort()).toEqual(['code', 'id', 'memberIds', 'name', 'pendingCount', 'role']);
    expect(asAdmin.value).toMatchObject({ id: club.id, name: 'Open Sports Barcelona', role: 'admin', code: club.code, pendingCount: 1 });
    expect([...asAdmin.value.memberIds].sort()).toEqual([admin.id, kid.id].sort());
    const asMember = await s.clubs.overview(kid.id);
    expect(asMember.ok && asMember.value).toMatchObject({ id: club.id, role: 'member', code: null, pendingCount: 1 });
    expect(await s.clubs.overview(friend.id)).toEqual({ ok: false, error: 'no-club' }); // pending is not a club
    await s.clubs.transferAdmin(admin.id, club.id, kid.id);
    const newAdmin = await s.clubs.overview(kid.id);
    expect(newAdmin.ok && newAdmin.value).toMatchObject({ role: 'admin', code: club.code });
    const oldAdmin = await s.clubs.overview(admin.id);
    expect(oldAdmin.ok && oldAdmin.value).toMatchObject({ role: 'member', code: null });
  });
});

// The invariant must hold against concurrent calls too: two confirmations (or a creation and a confirmation)
// for the same rider may both read "no club yet" before either writes, unless the service serialises them.
describe('one club per rider under concurrency (both storage adapters)', () => {
  const adapters: [string, () => Repositories][] = [
    ['memory', () => createMemoryRepositories()],
    ['sqlite', () => createSqliteRepositories(':memory:')],
  ];

  async function twoClubs(repos: Repositories) {
    const s = buildServices(repos);
    const adminA = (await registerRider(s, 'Papá')).account;
    const adminB = (await registerRider(s, 'Lucas')).account;
    const rider = (await registerRider(s, 'María')).account;
    const a = await s.clubs.createClub(adminA.id, 'Open Sports Barcelona');
    const b = await s.clubs.createClub(adminB.id, 'Otro Club');
    if (!a.ok || !b.ok) throw new Error('setup');
    return { s, adminA, adminB, rider, a: a.value, b: b.value };
  }

  for (const [name, open] of adapters) {
    it(`${name}: two simultaneous confirmations in different clubs → exactly one wins, the other stays pending without rights`, async () => {
      const { s, adminA, adminB, rider, a, b } = await twoClubs(open());
      try {
        await s.clubs.requestJoin(rider.id, a.code);
        await s.clubs.requestJoin(rider.id, b.code);
        const [ra, rb] = await Promise.all([s.clubs.confirm(adminA.id, a.id, rider.id), s.clubs.confirm(adminB.id, b.id, rider.id)]);
        expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
        expect(ra.ok ? rb : ra).toEqual({ ok: false, error: 'in-another-club' });
        const winner = ra.ok ? a : b;
        const loser = ra.ok ? b : a;
        expect(await s.clubs.isConfirmedMember(winner.id, rider.id)).toBe(true);
        expect(await s.clubs.isConfirmedMember(loser.id, rider.id)).toBe(false);
        expect((await s.repos.clubs.getMembership(loser.id, rider.id))?.status).toBe('pending');
        expect((await s.repos.accounts.getById(rider.id))?.clubId).toBe(winner.id);
        expect(await s.clubs.confirmedClubOf(rider.id)).toEqual({ id: winner.id, name: winner.name });
      } finally {
        await s.repos.close();
      }
    });

    it(`${name}: removing a member while handing them the admin role → exactly one succeeds; the admin is always a member`, async () => {
      const { s, adminA, rider, a } = await twoClubs(open());
      try {
        await s.clubs.requestJoin(rider.id, a.code);
        await s.clubs.confirm(adminA.id, a.id, rider.id);
        const [removed, transferred] = await Promise.all([s.clubs.removeMember(adminA.id, a.id, rider.id), s.clubs.transferAdmin(adminA.id, a.id, rider.id)]);
        expect([removed.ok, transferred.ok].filter(Boolean)).toHaveLength(1);
        const club = await s.repos.clubs.getById(a.id);
        if (removed.ok) {
          expect(transferred).toEqual({ ok: false, error: 'not-member' });
          expect(club?.adminAccountId).toBe(adminA.id);
          expect(await s.clubs.isConfirmedMember(a.id, rider.id)).toBe(false);
          expect((await s.repos.accounts.getById(rider.id))?.clubId).toBeNull();
        } else {
          expect(removed).toEqual({ ok: false, error: 'forbidden' }); // A is no longer the admin
          expect(club?.adminAccountId).toBe(rider.id);
          expect(await s.clubs.isConfirmedMember(a.id, rider.id)).toBe(true);
          expect((await s.repos.accounts.getById(rider.id))?.clubId).toBe(a.id);
        }
        // Whoever administers the club is one of its confirmed members, with profile and overview agreeing.
        const admin = club!.adminAccountId;
        expect(await s.clubs.isConfirmedMember(a.id, admin)).toBe(true);
        expect(await s.clubs.confirmedClubOf(admin)).toEqual({ id: a.id, name: a.name });
        const overview = await s.clubs.overview(admin);
        expect(overview.ok && overview.value).toMatchObject({ id: a.id, role: 'admin', code: a.code });
      } finally {
        await s.repos.close();
      }
    });

    // Codex P3 regression, the mirror of the case above: the per-club lock queues calls in arrival order, so
    // starting the transfer first must deterministically make it win; the removal then runs after A has
    // stopped being the admin and is refused as forbidden — the new admin is never removed from their own club.
    it(`${name}: handing a member the admin role while removing them (transfer started first) → the transfer wins; the removal is forbidden`, async () => {
      const { s, adminA, rider, a } = await twoClubs(open());
      try {
        await s.clubs.requestJoin(rider.id, a.code);
        await s.clubs.confirm(adminA.id, a.id, rider.id);
        const [transferred, removed] = await Promise.all([s.clubs.transferAdmin(adminA.id, a.id, rider.id), s.clubs.removeMember(adminA.id, a.id, rider.id)]);
        expect(transferred.ok && transferred.value.adminAccountId).toBe(rider.id);
        expect(removed).toEqual({ ok: false, error: 'forbidden' });
        expect((await s.repos.clubs.getById(a.id))?.adminAccountId).toBe(rider.id);
        // The new admin is a confirmed member whose profile points at the club; the old admin stays a member.
        expect(await s.clubs.isConfirmedMember(a.id, rider.id)).toBe(true);
        expect((await s.repos.accounts.getById(rider.id))?.clubId).toBe(a.id);
        expect(await s.clubs.confirmedClubOf(rider.id)).toEqual({ id: a.id, name: a.name });
        expect(await s.clubs.isConfirmedMember(a.id, adminA.id)).toBe(true);
        expect((await s.repos.accounts.getById(adminA.id))?.clubId).toBe(a.id);
        const asNewAdmin = await s.clubs.overview(rider.id);
        expect(asNewAdmin.ok && asNewAdmin.value).toMatchObject({ id: a.id, role: 'admin', code: a.code });
        const asOldAdmin = await s.clubs.overview(adminA.id);
        expect(asOldAdmin.ok && asOldAdmin.value).toMatchObject({ id: a.id, role: 'member', code: null });
      } finally {
        await s.repos.close();
      }
    });

    it(`${name}: two simultaneous transfers to different members → exactly one new admin`, async () => {
      const { s, adminA, adminB, rider, a } = await twoClubs(open());
      try {
        // B leaves their own club first so they can join A (one club per rider).
        const third = (await registerRider(s, 'Sofía')).account;
        await s.clubs.requestJoin(rider.id, a.code);
        await s.clubs.requestJoin(third.id, a.code);
        await s.clubs.confirm(adminA.id, a.id, rider.id);
        await s.clubs.confirm(adminA.id, a.id, third.id);
        const [toRider, toThird] = await Promise.all([s.clubs.transferAdmin(adminA.id, a.id, rider.id), s.clubs.transferAdmin(adminA.id, a.id, third.id)]);
        expect([toRider.ok, toThird.ok].filter(Boolean)).toHaveLength(1);
        expect(toRider.ok ? toThird : toRider).toEqual({ ok: false, error: 'forbidden' });
        const club = await s.repos.clubs.getById(a.id);
        expect(club?.adminAccountId).toBe(toRider.ok ? rider.id : third.id);
        expect(adminB.id).not.toBe(club?.adminAccountId);
      } finally {
        await s.repos.close();
      }
    });

    it(`${name}: creating a club while being confirmed elsewhere → exactly one succeeds, memberships stay consistent`, async () => {
      const { s, adminA, rider, a } = await twoClubs(open());
      try {
        await s.clubs.requestJoin(rider.id, a.code);
        const [created, confirmed] = await Promise.all([s.clubs.createClub(rider.id, 'Club Nuevo'), s.clubs.confirm(adminA.id, a.id, rider.id)]);
        expect([created.ok, confirmed.ok].filter(Boolean)).toHaveLength(1);
        if (created.ok) {
          expect(confirmed).toEqual({ ok: false, error: 'in-another-club' });
          expect(await s.clubs.isConfirmedMember(created.value.id, rider.id)).toBe(true);
          expect((await s.repos.clubs.getMembership(a.id, rider.id))?.status).toBe('pending');
          expect((await s.repos.accounts.getById(rider.id))?.clubId).toBe(created.value.id);
        } else {
          expect(created).toEqual({ ok: false, error: 'in-another-club' });
          expect(await s.repos.clubs.getByNameKey('clubnuevo')).toBeNull();
          expect(await s.clubs.isConfirmedMember(a.id, rider.id)).toBe(true);
          expect((await s.repos.accounts.getById(rider.id))?.clubId).toBe(a.id);
        }
      } finally {
        await s.repos.close();
      }
    });
  }
});
