const state = { value: null, seenAt: null, function: null, lastTrueAt: null, refusedWrites: 0 };
/** Reads the member of a decoded signature, if present. */
export const exclusiveOf = (signature) => {
    const value = signature?.ModeExclusif;
    return typeof value === "boolean" ? value : null;
};
/** Records the value carried by an answer's signature (no-op when absent). */
export const noteExclusive = (signature, name, now = Date.now()) => {
    const value = exclusiveOf(signature);
    if (value === null)
        return null;
    const at = new Date(now).toISOString();
    if (value && state.value !== true)
        state.lastTrueAt = at;
    state.value = value;
    state.seenAt = at;
    state.function = name;
    return value;
};
export const countRefusedWrite = () => {
    state.refusedWrites++;
};
export const exclusiveStats = () => ({ ...state });
/** Tests only. */
export const resetExclusive = () => {
    Object.assign(state, { value: null, seenAt: null, function: null, lastTrueAt: null, refusedWrites: 0 });
};
//# sourceMappingURL=exclusive.js.map