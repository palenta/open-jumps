// Which screen is on (plan 1.7 cycle): sign-in → home → lobby → course walk → round → results → lobby again.
// The results table stays up through 'done' until the host starts again.
import { describe, expect, it } from 'vitest';
import { screenFor, type ScreenInput } from '../src/app/screens.js';

const signedIn = (over: Partial<ScreenInput> = {}): ScreenInput => ({ signedIn: true, room: 'none', phase: null, ...over });

describe('screenFor', () => {
  it('sign-in until signed in, whatever the room says', () => {
    expect(screenFor({ signedIn: false, room: 'none', phase: null })).toBe('signin');
    expect(screenFor({ signedIn: false, room: 'joining', phase: null })).toBe('signin');
    expect(screenFor({ signedIn: false, room: 'joined', phase: 'riding' })).toBe('signin');
  });

  it('home when signed in and outside a room', () => {
    expect(screenFor(signedIn())).toBe('home');
    expect(screenFor(signedIn({ phase: 'riding' }))).toBe('home');
  });

  it('lobby while the doorbell flow runs', () => {
    expect(screenFor(signedIn({ room: 'joining' }))).toBe('lobby');
  });

  it('lobby once joined while the room is in lobby or before the phase is known', () => {
    expect(screenFor(signedIn({ room: 'joined', phase: 'lobby' }))).toBe('lobby');
    expect(screenFor(signedIn({ room: 'joined', phase: null }))).toBe('lobby');
  });

  it('the course walk, then the round while riding', () => {
    expect(screenFor(signedIn({ room: 'joined', phase: 'walk' }))).toBe('walk');
    expect(screenFor(signedIn({ room: 'joined', phase: 'riding' }))).toBe('round');
  });

  it('results both while the class shows its table and once the class is done', () => {
    expect(screenFor(signedIn({ room: 'joined', phase: 'results' }))).toBe('results');
    expect(screenFor(signedIn({ room: 'joined', phase: 'done' }))).toBe('results');
  });
});
