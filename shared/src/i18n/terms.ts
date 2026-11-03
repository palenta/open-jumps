// Equestrian terms exactly as the kids hear them from their trainer (plan 1.5): Spanish in BOTH locales, in
// this one file and nowhere else — not in code, not in the locale dictionaries (they reference a term as
// `{term:id}`) — so the girls' corrections after the first game change this file only (plan 2.2).
// The first build's terms are provisional; the final ones come from the girls.
export const TERMS = {
  derribo: 'derribo',
  rehuse: 'rehúse',
  desvio: 'desvío',
  caida: 'caída',
  tranco: 'tranco',
  batida: 'batida',
  recepcion: 'recepción',
  batida_corta: 'batida corta',
  batida_larga: 'batida larga',
  galope_reunido: 'galope reunido',
  galope_largo: 'galope largo',
  a_toda_carrera: 'a toda carrera',
  reconocimiento: 'reconocimiento',
  desempate: 'desempate',
  cero_faltas: 'cero faltas',
  perfecta: 'perfecta',
  ria: 'ría',
  oxer: 'óxer',
  vertical: 'vertical',
  combinacion: 'combinación',
  manga: 'manga',
  sin_conexion: 'sin conexión',
  con_autopiloto: 'con autopiloto',
  entrenamiento: 'entrenamiento',
  eliminada: 'eliminada',
  recorrido_equivocado: 'recorrido equivocado',
  recto: '¡Recto!',
  giro_cerrado: 'giro cerrado',
  giro_abierto: 'giro abierto',
  yegua: 'yegua',
  macho: 'macho',
} as const;

export type TermId = keyof typeof TERMS;

/** The Spanish term for an id. */
export function term(id: TermId): string {
  return TERMS[id];
}

/** True only for a known term id (labels from the judge are term ids; anything else is shown as-is). */
export function isTermId(value: unknown): value is TermId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TERMS, value);
}
