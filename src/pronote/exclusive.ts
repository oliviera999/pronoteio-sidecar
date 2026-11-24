/**
 * 0.16.4: "mode exclusif" of the Pronote server. Every answer may carry `ModeExclusif: true|false` in its signature
 * (client: ObjetRequeteJSON.declarerModules → _deserialisationSignatureRequeteConsultSaisie). While it is true, the
 * web client treats every write as cancelled (ObjetRequeteSaisie.traiterReponseSaisie: avecControleModeExclusif and
 * getModeExclusif() → EGenreReponseSaisie.annulation, "Saisie impossible, consultation seulement") and does not even
 * send a new one (appelAsynchrone). The server answers HTTP 200 without any RapportSaisie message: until 0.16.3 the
 * sidecar could only see that the write was not found when reading again.
 *
 * Kept per process (the last value seen, from any call), without personal data, for the health report and the logs.
 */
export type ExclusiveState = {
  /** Last value seen in an answer; null while no answer carried the member. */
  value: boolean | null;
  /** When it was last seen (ISO date). */
  seenAt: string | null;
  /** Pronote function of that answer. */
  function: string | null;
  /** When the value last switched to true (ISO date), null if never seen true. */
  lastTrueAt: string | null;
  /** Number of writes refused by the sidecar because the answer said exclusive mode. */
  refusedWrites: number;
};

const state: ExclusiveState = { value: null, seenAt: null, function: null, lastTrueAt: null, refusedWrites: 0 };

/** Reads the member of a decoded signature, if present. */
export const exclusiveOf = (signature: unknown): boolean | null => {
  const value = (signature as { ModeExclusif?: unknown } | null | undefined)?.ModeExclusif;
  return typeof value === "boolean" ? value : null;
};

/** Records the value carried by an answer's signature (no-op when absent). */
export const noteExclusive = (signature: unknown, name: string, now = Date.now()): boolean | null => {
  const value = exclusiveOf(signature);
  if (value === null) return null;
  const at = new Date(now).toISOString();
  if (value && state.value !== true) state.lastTrueAt = at;
  state.value = value;
  state.seenAt = at;
  state.function = name;
  return value;
};

export const countRefusedWrite = (): void => {
  state.refusedWrites++;
};

export const exclusiveStats = (): ExclusiveState => ({ ...state });

/** Tests only. */
export const resetExclusive = (): void => {
  Object.assign(state, { value: null, seenAt: null, function: null, lastTrueAt: null, refusedWrites: 0 });
};
