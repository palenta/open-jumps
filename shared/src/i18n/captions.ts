// Event captions in rider vocabulary (plan 1.5): mixed English/Spanish or Spanish, the pony's name first, the
// equestrian term from terms.ts — "Dakota: rehúse at fence 3 — she's fine". The server's judge emits term ids
// as labels (TakeoffOutcome.label, TurnOutcome.label); the client renders them through here.
import type { EliminationReason } from '../rules/attempts.js';
import { isMessageKey, translate, translateKey, type Params } from './index.js';
import type { Locale } from './locale.js';
import { isTermId, term } from './terms.js';

export interface CaptionNames {
  rider: string;
  pony: string;
  ponyGender: 'yegua' | 'macho';
}

export type CaptionEvent =
  | { type: 'takeoff'; label: string; fence: number }
  | { type: 'turn'; label: string }
  | { type: 'finish'; elapsedMs: number }
  | { type: 'eliminated'; reason: EliminationReason }
  | { type: 'autopilot'; on: boolean }
  | { type: 'restart'; fence: number }
  | { type: 'refused'; error: string };

/**
 * The caption for a round event. Take-off and turn labels that are term ids use `caption.takeoff.<label>` /
 * `caption.turn.<label>` when the key exists, otherwise the `…other` key with `{label}`; eliminations use the
 * reason; `{she}` is the pronoun for the pony's gender; `{time}` is formatRoundTime(elapsedMs).
 */
export function caption(locale: Locale, event: CaptionEvent, names: CaptionNames): string {
  const base: Params = {
    rider: names.rider,
    pony: names.pony,
    she: translateKey(locale, `pronoun.${names.ponyGender}`),
  };
  switch (event.type) {
    case 'takeoff':
      return labelled(locale, 'caption.takeoff', event.label, { ...base, fence: event.fence });
    case 'turn':
      return labelled(locale, 'caption.turn', event.label, base);
    case 'finish':
      return translate(locale, 'caption.finish', { ...base, time: formatRoundTime(event.elapsedMs) });
    case 'eliminated':
      return translateKey(locale, `caption.eliminated.${event.reason}`, base);
    case 'autopilot':
      return translate(locale, event.on ? 'caption.autopilot.on' : 'caption.autopilot.off', base);
    case 'restart':
      return translate(locale, 'caption.restart', { ...base, fence: event.fence });
    case 'refused': {
      const key = `caption.refused.${event.error}`;
      return isMessageKey(key)
        ? translate(locale, key, base)
        : translate(locale, 'caption.refused.other', { ...base, error: event.error });
    }
  }
}

/**
 * `<prefix>.<label>` when the dictionary has it, else `<prefix>.other` with `{label}`: the Spanish term for a
 * term id the dictionary has no caption for, anything else as written (plan 1.5: labels from the judge are
 * term ids; the rest is shown as-is).
 */
function labelled(locale: Locale, prefix: 'caption.takeoff' | 'caption.turn', label: string, params: Params): string {
  const key = `${prefix}.${label}`;
  const text = isTermId(label) ? term(label) : label;
  return isMessageKey(key)
    ? translate(locale, key, { ...params, label: text })
    : translate(locale, `${prefix}.other`, { ...params, label: text });
}

/**
 * Round time for the HUD and the tables, tenths of a second: below a minute "42.3"; from a minute "1:02.3"
 * (seconds always two digits); negative or non-finite input reads "0.0". Truncated, not rounded (a clock
 * never shows a tenth that has not passed).
 */
export function formatRoundTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0.0';
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;
  const seconds = Math.floor(rest / 10);
  const tenth = rest % 10;
  if (minutes === 0) return `${String(seconds)}.${String(tenth)}`;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}.${String(tenth)}`;
}
