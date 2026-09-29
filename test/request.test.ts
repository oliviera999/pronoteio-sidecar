import assert from "node:assert/strict";
import { test } from "node:test";
import forge from "node-forge";
import { deflateRaw, inflateRaw } from "pako";
import type { SessionHandle } from "pawnote";
import { decodePayload, decrypt, encodePayload, encrypt, propertyKeys } from "../src/pronote/request.js";

const fakeSession = (version: number[], options: { skipCompression?: boolean; skipEncryption?: boolean } = {}) =>
  ({
    instance: { version },
    information: {
      aesKey: "0123456789abcdef",
      aesIV: forge.random.getBytesSync(16),
      skipCompression: options.skipCompression ?? false,
      skipEncryption: options.skipEncryption ?? false,
      order: 0,
    },
  }) as unknown as SessionHandle;

test("encrypt and decrypt are symmetric", () => {
  const key = forge.random.getBytesSync(16);
  const iv = forge.random.getBytesSync(16);
  const hex = encrypt("numéro 3", key, iv);
  assert.match(hex, /^[0-9a-f]+$/);
  assert.equal(decrypt(hex, key, iv), "numéro 3");
});

const payload = { data: { devoir: { L: "Contrôle n°2", bareme: "20" }, notes: [{ N: "1", V: "|1" }] } };
const toBytes = (array: Uint8Array) => Array.from(array, (byte) => String.fromCharCode(byte)).join("");
const toArray = (bytes: string) => Uint8Array.from(bytes, (char) => char.charCodeAt(0));
const cipher = (session: SessionHandle) => ({
  key: forge.md.md5.create().update(session.information.aesKey).digest().bytes(),
  iv: forge.md.md5.create().update(session.information.aesIV).digest().bytes(),
});

test("requests are encoded as AES(deflateRaw(hex(utf8 JSON)))", () => {
  const session = fakeSession([2025, 2, 0]);
  const { key, iv } = cipher(session);
  const encoded = encodePayload(session, payload) as string;
  const hex = new TextDecoder().decode(inflateRaw(toArray(decrypt(encoded, key, iv))));
  assert.deepEqual(JSON.parse(forge.util.decodeUtf8(forge.util.hexToBytes(hex))), payload);
});

test("requests are sent in clear when compression and encryption are disabled", () => {
  const session = fakeSession([2025, 2, 0], { skipCompression: true, skipEncryption: true });
  assert.deepEqual(encodePayload(session, payload), payload);
});

test("answers are decoded from AES(deflateRaw(utf8 JSON))", () => {
  const session = fakeSession([2025, 2, 0]);
  const { key, iv } = cipher(session);
  const answer = encrypt(toBytes(deflateRaw(new TextEncoder().encode(JSON.stringify(payload)))), key, iv);
  assert.deepEqual(decodePayload(session, answer), payload);
});

test("answers without encryption are hex encoded", () => {
  const session = fakeSession([2025, 2, 0], { skipEncryption: true });
  const answer = forge.util.bytesToHex(toBytes(deflateRaw(new TextEncoder().encode(JSON.stringify(payload)))));
  assert.deepEqual(decodePayload(session, answer), payload);
});

test("property names follow the Pronote version", () => {
  assert.equal(propertyKeys(fakeSession([2025, 1, 3])).secureData, "dataSec");
  assert.equal(propertyKeys(fakeSession([2025, 1, 2])).secureData, "donneesSec");
  assert.equal(propertyKeys(fakeSession([2024, 3, 9])).data, "data");
  assert.equal(propertyKeys(fakeSession([2024, 3, 8])).data, "donnees");
  assert.equal(propertyKeys(fakeSession([2024, 3, 8])).signature, "_Signature_");
});
