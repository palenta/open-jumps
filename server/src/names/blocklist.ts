// Words that may not appear in any visible name (rider, pony, club), English and Spanish.
// 'word' entries match only as a whole normalised word (short words would otherwise hit innocent names);
// 'substring' entries match anywhere after normalisation. Kept deliberately modest: false positives on a
// child's real name are a worse failure than a missed insult, which the owner can still hide by admin key.

export interface BlockedTerm {
  term: string;
  mode: 'word' | 'substring';
}

export const BLOCKED_TERMS: readonly BlockedTerm[] = [
  // English
  { term: 'fuck', mode: 'substring' },
  { term: 'shit', mode: 'substring' },
  { term: 'bitch', mode: 'substring' },
  { term: 'cunt', mode: 'substring' },
  { term: 'dick', mode: 'word' },
  { term: 'cock', mode: 'word' },
  { term: 'pussy', mode: 'substring' },
  { term: 'asshole', mode: 'substring' },
  { term: 'ass', mode: 'word' },
  { term: 'slut', mode: 'substring' },
  { term: 'whore', mode: 'substring' },
  { term: 'nigger', mode: 'substring' },
  { term: 'nigga', mode: 'substring' },
  { term: 'faggot', mode: 'substring' },
  { term: 'retard', mode: 'substring' },
  { term: 'nazi', mode: 'word' },
  { term: 'hitler', mode: 'substring' },
  { term: 'porn', mode: 'substring' },
  { term: 'sex', mode: 'word' },
  { term: 'rape', mode: 'word' },
  // Spanish
  { term: 'puta', mode: 'substring' },
  { term: 'puto', mode: 'substring' },
  { term: 'mierda', mode: 'substring' },
  { term: 'joder', mode: 'substring' },
  { term: 'cabron', mode: 'substring' },
  { term: 'cabrona', mode: 'substring' },
  { term: 'gilipollas', mode: 'substring' },
  { term: 'polla', mode: 'word' },
  { term: 'coño', mode: 'substring' },
  { term: 'cono', mode: 'word' },
  { term: 'maricon', mode: 'substring' },
  { term: 'maricona', mode: 'substring' },
  { term: 'zorra', mode: 'word' },
  { term: 'pendejo', mode: 'substring' },
  { term: 'pendeja', mode: 'substring' },
  { term: 'culo', mode: 'word' },
  { term: 'verga', mode: 'word' },
  { term: 'chinga', mode: 'substring' },
  { term: 'hijoputa', mode: 'substring' },
  { term: 'hijodeputa', mode: 'substring' },
  { term: 'subnormal', mode: 'substring' },
  { term: 'folla', mode: 'substring' },
];
