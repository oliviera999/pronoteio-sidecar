import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveTokenStoreFile } from "../src/config.js";
import { accountKey, chainedTokenLogin, ENTRY_TTL, MAX_SUPERSEDED, serializeLogin, TokenStore } from "../src/tokenStore.js";

/**
 * 12/11/2026: a login answer never reached Moodle (sidecar unreachable while the login ran). Pronote had consumed the
 * token Moodle kept, every following login failed with bad_credentials and the account had to be linked again.
 * Fictitious tokens only.
 */
const SECRET = "test-secret-0123456789abcdef";
const account = accountKey("https://demo.example/pronote/", "prof.fictif", "device-fictif");
const fileIn = () => join(mkdtempSync(join(tmpdir(), "pronoteio-tokens-")), "var", "tokens.json");

/** Fake Pronote: each token is valid once and replaced by the next one. */
const fakePronote = () => {
  let n = 1;
  const valid = new Set(["T1"]);
  const seen: string[] = [];
  return {
    seen,
    login: async (token: string) => {
      seen.push(token);
      if (!valid.delete(token)) throw new Error("bad_credentials");
      const next = `T${++n}`;
      valid.add(next);
      return { token: next };
    },
  };
};

test("a login answer lost on the way: the next login with the old token uses the latest one", async () => {
  const store = new TokenStore(fileIn(), SECRET);
  const pronote = fakePronote();
  // Normal login: Moodle receives T2.
  assert.equal((await chainedTokenLogin(store, account, "T1", pronote.login)).token, "T2");
  // Login with T2 whose answer (T3) is lost: Moodle still holds T2.
  await chainedTokenLogin(store, account, "T2", pronote.login);
  // Next login with T2 (already consumed by Pronote): T3 is presented, Moodle receives T4.
  const recovered = await chainedTokenLogin(store, account, "T2", pronote.login);
  assert.equal(recovered.token, "T4");
  assert.equal(recovered.substituted, true);
  assert.deepEqual(pronote.seen, ["T1", "T2", "T3"]);
  // Two answers lost in a row are made up for too.
  await chainedTokenLogin(store, account, "T4", pronote.login);
  await chainedTokenLogin(store, account, "T5", pronote.login);
  assert.equal((await chainedTokenLogin(store, account, "T4", pronote.login)).token, "T7");
});

test("the chain survives a restart, encrypted, file mode 0600", async () => {
  const file = fileIn();
  const pronote = fakePronote();
  await chainedTokenLogin(new TokenStore(file, SECRET), account, "T1", pronote.login);
  // Restart: a new store reads the same file.
  assert.deepEqual(new TokenStore(file, SECRET).resolve(account, "T1"), { token: "T2", substituted: true });
  const content = readFileSync(file, "utf8");
  assert.equal(content.includes("T2"), false);
  assert.equal(content.includes("prof.fictif"), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // Another secret cannot read it: the token sent is used as is, nothing breaks.
  assert.deepEqual(new TokenStore(file, "another-secret-0123456789").resolve(account, "T1"), { token: "T1", substituted: false });
});

test("the latest token and an unknown token are used as sent; a password login starts a new chain", () => {
  const store = new TokenStore(null, SECRET);
  store.record(account, "T1", "T2");
  assert.deepEqual(store.resolve(account, "T2"), { token: "T2", substituted: false });
  assert.deepEqual(store.resolve(account, "Q1"), { token: "Q1", substituted: false });
  // Account linked again with a password: the old chain no longer applies.
  store.record(account, null, "P1");
  assert.deepEqual(store.resolve(account, "T1"), { token: "T1", substituted: false });
  // Linked again with another token (not the latest): new chain.
  store.record(account, "Q1", "Q2");
  assert.deepEqual(store.resolve(account, "P1"), { token: "P1", substituted: false });
  assert.deepEqual(store.resolve(account, "Q1"), { token: "Q2", substituted: true });
  // Other account: never confused.
  assert.deepEqual(store.resolve(accountKey("https://demo.example/pronote/", "autre.prof", "device-fictif"), "Q1"),
    { token: "Q1", substituted: false });
});

test("bounded chain and forgotten accounts", () => {
  let now = 1_000;
  const store = new TokenStore(null, SECRET, () => now);
  for (let i = 1; i <= MAX_SUPERSEDED + 5; i++) store.record(account, `T${i}`, `T${i + 1}`);
  assert.equal(store.resolve(account, "T1").substituted, false);
  assert.equal(store.resolve(account, `T${MAX_SUPERSEDED + 5}`).token, `T${MAX_SUPERSEDED + 6}`);
  const other = accountKey("https://demo.example/pronote/", "autre.prof", "device-fictif");
  now += ENTRY_TTL + 1;
  store.record(other, "A1", "A2");
  assert.equal(store.resolve(account, `T${MAX_SUPERSEDED + 5}`).substituted, false);
  store.forget(other);
  assert.equal(store.resolve(other, "A1").substituted, false);
});

test("a store that cannot be written never refuses a valid login", async () => {
  // A regular file where the folder should be: the store cannot be written.
  const blocker = join(mkdtempSync(join(tmpdir(), "pronoteio-tokens-")), "not-a-folder");
  writeFileSync(blocker, "");
  const store = new TokenStore(join(blocker, "tokens.json"), SECRET);
  const errors: unknown[] = [];
  const result = await chainedTokenLogin(store, account, "T1", fakePronote().login, (error) => errors.push(error));
  assert.equal(result.token, "T2");
  assert.equal(errors.length, 1);
});

test("logins of one account run one after the other", async () => {
  const order: string[] = [];
  const slow = (name: string, ms: number) => async () => {
    order.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push(`${name}:end`);
    return name;
  };
  const results = await Promise.all([serializeLogin(account, slow("a", 50)), serializeLogin(account, slow("b", 1))]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  // A failed login does not block the next one.
  await assert.rejects(serializeLogin(account, async () => { throw new Error("bad_credentials"); }));
  assert.equal(await serializeLogin(account, async () => "c"), "c");
});

test("token store file: default in var/, configurable, can be turned off", () => {
  assert.equal(resolveTokenStoreFile({}, "/app"), "/app/var/tokens.json");
  assert.equal(resolveTokenStoreFile({ PRONOTEIO_TOKEN_STORE: "/data/t.json" }, "/app"), "/data/t.json");
  assert.equal(resolveTokenStoreFile({ PRONOTEIO_TOKEN_STORE: "off" }, "/app"), null);
});
