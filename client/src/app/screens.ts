// Which screen is on (plan 1.7 cycle): sign-in → home → lobby → course walk → round → results → lobby again.
import type { RoomPhase } from '../net/types.js';

export type Screen = 'signin' | 'home' | 'lobby' | 'walk' | 'round' | 'results';

export interface ScreenInput {
  signedIn: boolean;
  /** 'none' outside a room, 'joining' while the doorbell flow runs, 'joined' once the room session is connected. */
  room: 'none' | 'joining' | 'joined';
  phase: RoomPhase | null;
}

/**
 * signin until signed in; home with no room; lobby while joining and while the room is in 'lobby';
 * walk / round (riding) / results (results AND done — the table stays up until the host starts again).
 */
export function screenFor(input: ScreenInput): Screen {
  if (!input.signedIn) return 'signin';
  if (input.room === 'none') return 'home';
  if (input.room === 'joining') return 'lobby';
  switch (input.phase) {
    case 'walk':
      return 'walk';
    case 'riding':
      return 'round';
    case 'results':
    case 'done':
      return 'results';
    case 'lobby':
    case null:
      return 'lobby';
  }
}
