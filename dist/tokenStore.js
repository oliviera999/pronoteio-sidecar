/**
 * Chain of the single-use Pronote tokens of each linked account, kept by the sidecar so that a lost answer no longer
 * breaks the link.
 *
 * Every token login consumes the token sent and returns a new one, which Moodle must store. 12/11/2026: a login
 * answer never reached Moodle (sidecar unreachable: timeout or restart while the login ran). Pronote had already
 * consumed the token Moodle kept, so every following login failed with bad_credentials and the teacher had to link
 * the account again.
 *
 * The sidecar now records, before answering, the token issued by Pronote and the fingerprints of the tokens it
 * replaces. When Moodle sends a token the sidecar already used, the latest token of the chain is presented to
 * Pronote instead, and returned to Moodle as usual. Tokens are encrypted (AES-256-GCM, key derived from
 * PRONOTEIO_SECRET) in one file written atomically with mode 0600; only SHA-256 fingerprints of the used tokens are
 * kept. An account unused for ENTRY_TTL is forgotten.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
/** Fingerprints of used tokens kept per account (logins whose answer may still be lost). */
export const MAX_SUPERSEDED = 10;
/** An account whose chain has not moved for this long is forgotten (milliseconds). */
export const ENTRY_TTL = 60 * 24 * 3600 * 1000;
const fingerprint = (value) => createHash("sha256").update(value).digest("hex");
/** Key of an account: Pronote address, user name and device (never stored in clear). */
export const accountKey = (url, username, deviceuuid) => fingerprint(`${url}\n${username}\n${deviceuuid}`);
export class TokenStore {
    file;
    now;
    key;
    /** Store kept in memory when no file is configured (tests, PRONOTEIO_TOKEN_STORE=off is handled by the caller). */
    memory = {};
    constructor(file, secret, now = Date.now) {
        this.file = file;
        this.now = now;
        this.key = createHash("sha256").update(`pronoteio-token-store\n${secret}`).digest();
    }
    encrypt(token) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const data = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
    }
    /** Clear token, or null when it cannot be read (other secret, damaged file). */
    decrypt(value) {
        try {
            const raw = Buffer.from(value, "base64");
            const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
            decipher.setAuthTag(raw.subarray(12, 28));
            return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
        }
        catch {
            return null;
        }
    }
    read() {
        if (this.file === null)
            return this.memory;
        if (!existsSync(this.file))
            return {};
        try {
            const parsed = JSON.parse(readFileSync(this.file, "utf8"));
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        }
        catch {
            return {};
        }
    }
    write(store) {
        if (this.file === null) {
            this.memory = store;
            return;
        }
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        const temporary = `${this.file}.${process.pid}.tmp`;
        writeFileSync(temporary, JSON.stringify(store), { mode: 0o600 });
        renameSync(temporary, this.file);
    }
    /**
     * Token to present to Pronote for the token sent by Moodle: the latest token of the chain when the one sent was
     * already used by the sidecar (its answer was lost), otherwise the token sent.
     */
    resolve(account, sent) {
        const entry = this.read()[account];
        if (entry && entry.superseded.includes(fingerprint(sent))) {
            const latest = this.decrypt(entry.latest);
            if (latest !== null)
                return { token: latest, substituted: true };
        }
        return { token: sent, substituted: false };
    }
    /**
     * Records the token issued by Pronote after a login with `used` (null: password login, which starts a new chain).
     * Called before the answer leaves, so that a lost answer can be made up for at the next login.
     */
    record(account, used, issued) {
        const store = this.read();
        const now = this.now();
        for (const [key, entry] of Object.entries(store)) {
            if (now - entry.at > ENTRY_TTL)
                delete store[key];
        }
        const previous = store[account];
        // Same chain when the token used is the latest one recorded; any other token (account linked again) starts anew.
        const continued = used !== null && previous !== undefined && this.decrypt(previous.latest) === used;
        const superseded = used === null ? [] : [fingerprint(used), ...(continued ? previous.superseded : [])];
        store[account] = { latest: this.encrypt(issued), superseded: superseded.slice(0, MAX_SUPERSEDED), at: now };
        this.write(store);
    }
    /** Forgets an account (its link was removed or refused for good). */
    forget(account) {
        const store = this.read();
        if (store[account] === undefined)
            return;
        delete store[account];
        this.write(store);
    }
}
/** Logins of one account run one after the other: two concurrent logins would consume the same token. */
const queues = new Map();
export const serializeLogin = (account, run) => {
    const previous = queues.get(account) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const tail = next.catch(() => undefined);
    queues.set(account, tail);
    void tail.then(() => {
        if (queues.get(account) === tail)
            queues.delete(account);
    });
    return next;
};
/**
 * Token login through the chain: presents the right token, records the new one before returning. `login` performs
 * the Pronote login with the token given and returns the token Pronote issued.
 */
export const chainedTokenLogin = async (store, account, sent, login, onRecordError = () => undefined) => {
    const { token, substituted } = store ? store.resolve(account, sent) : { token: sent, substituted: false };
    const refresh = await login(token);
    if (store) {
        try {
            store.record(account, token, refresh.token);
        }
        catch (error) {
            // A store that cannot be written must not refuse a valid login: the answer still carries the new token.
            onRecordError(error);
        }
    }
    return { ...refresh, substituted };
};
//# sourceMappingURL=tokenStore.js.map