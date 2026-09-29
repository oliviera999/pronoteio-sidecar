/**
 * Encrypted Pronote request layer, reusing a session opened by Pawnote.
 *
 * Pawnote keeps its request class private, so this module reproduces the same wire format
 * (pawnote 1.6.x): AES-CBC with MD5-derived key/IV, raw-deflate compression, and an order number
 * incremented once for the request and once for the response. Every call goes through the
 * Pawnote session queue so that order numbers never interleave with Pawnote's own calls.
 */
import forge from "node-forge";
import { deflateRaw, inflateRaw } from "pako";
import { ServerSideError, SessionExpiredError, type SessionHandle } from "pawnote";

type Keys = {
  data: string;
  orderNumber: string;
  secureData: string;
  requestId: string;
  signature: string;
  session: string;
};

const atLeast = (version: number[], wanted: [number, number, number]): boolean => {
  for (let i = 0; i < 3; i++) {
    const part = version[i] ?? 0;
    if (part !== wanted[i]) return part > wanted[i];
  }
  return true;
};

/** Field names changed with PRONOTE 2024.3.9 and 2025.1.3. */
export const propertyKeys = (session: SessionHandle): Keys => {
  const version = session.instance.version;
  if (atLeast(version, [2025, 1, 3])) {
    return { data: "data", orderNumber: "no", secureData: "dataSec", requestId: "id", signature: "Signature", session: "session" };
  }
  const base = { orderNumber: "numeroOrdre", secureData: "donneesSec", requestId: "nom", session: "session" };
  return atLeast(version, [2024, 3, 9])
    ? { ...base, data: "data", signature: "Signature" }
    : { ...base, data: "donnees", signature: "_Signature_" };
};

const md5 = (bytes: string): string => forge.md.md5.create().update(bytes).digest().bytes();

const cipherKeys = (session: SessionHandle, firstRequest = false): { key: string; iv: string } => {
  const iv = firstRequest ? "" : session.information.aesIV;
  return {
    key: md5(session.information.aesKey),
    iv: iv.length ? md5(iv) : forge.util.createBuffer().fillWithByte(0, 16).bytes(),
  };
};

export const encrypt = (bytes: string, key: string, iv: string): string => {
  const cipher = forge.cipher.createCipher("AES-CBC", key);
  cipher.start({ iv });
  cipher.update(forge.util.createBuffer(bytes));
  cipher.finish();
  return cipher.output.toHex();
};

export const decrypt = (hex: string, key: string, iv: string): string => {
  const decipher = forge.cipher.createDecipher("AES-CBC", key);
  decipher.start({ iv });
  decipher.update(forge.util.createBuffer(forge.util.hexToBytes(hex)));
  decipher.finish();
  return decipher.output.bytes();
};

const bytesToUint8 = (bytes: string): Uint8Array => Uint8Array.from(bytes, (char) => char.charCodeAt(0));
const uint8ToBytes = (array: Uint8Array): string => Array.from(array, (byte) => String.fromCharCode(byte)).join("");

/** Encodes the payload exactly like Pawnote: utf8 -> hex -> deflateRaw -> AES. */
export const encodePayload = (session: SessionHandle, payload: unknown): unknown => {
  const { skipCompression, skipEncryption } = session.information;
  if (skipCompression && skipEncryption) return payload;

  let bytes = forge.util.encodeUtf8(JSON.stringify(payload) ?? "");
  if (!skipCompression) {
    bytes = uint8ToBytes(deflateRaw(forge.util.bytesToHex(bytes), { level: 6 }));
  }
  if (skipEncryption) return forge.util.bytesToHex(bytes);

  const { key, iv } = cipherKeys(session);
  return encrypt(bytes, key, iv);
};

export const decodePayload = (session: SessionHandle, secure: unknown): unknown => {
  const { skipCompression, skipEncryption } = session.information;
  if (typeof secure !== "string") return secure;
  if (skipCompression && skipEncryption) return JSON.parse(secure);

  let bytes: string;
  if (!skipEncryption) {
    const { key, iv } = cipherKeys(session);
    bytes = decrypt(secure, key, iv);
  } else {
    bytes = forge.util.hexToBytes(secure);
  }
  const text = skipCompression
    ? forge.util.decodeUtf8(bytes)
    : new TextDecoder().decode(inflateRaw(bytesToUint8(bytes)));
  return JSON.parse(text);
};

export type PronoteCall = {
  /** Pronote function name, e.g. "PageSaisieNotes". */
  name: string;
  /** Content of the "data"/"donnees" member. */
  data?: Record<string, unknown>;
  /** Content of the "Signature" member (usually { onglet: number }). */
  signature?: Record<string, unknown>;
};

/**
 * Sends one Pronote function call and returns the decoded answer (the "dataSec" content).
 * Throws SessionExpiredError / ServerSideError like Pawnote does.
 */
export const callPronote = async (session: SessionHandle, call: PronoteCall): Promise<Record<string, any>> => {
  return session.queue.push(async () => {
    const keys = propertyKeys(session);
    const payload: Record<string, unknown> = {};
    if (call.signature) payload[keys.signature] = call.signature;
    if (call.data) payload[keys.data] = call.data;

    session.information.order++;
    const { key, iv } = cipherKeys(session, session.information.order === 1);
    const order = encrypt(session.information.order.toString(), key, iv);
    const url = new URL(
      `${session.information.url}/appelfonction/${session.information.accountKind}/${session.information.id}/${order}`,
    );

    const response = await session.fetcher({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      content: JSON.stringify({
        [keys.session]: session.information.id,
        [keys.orderNumber]: order,
        [keys.requestId]: call.name,
        [keys.secureData]: encodePayload(session, payload),
      }),
    });

    session.information.order++;
    const raw = response.content;
    if (raw.includes("La page a expir")) throw new SessionExpiredError();

    const envelope = JSON.parse(raw);
    if (envelope.Erreur) throw new ServerSideError(envelope.Erreur.Titre || "Server Error");

    const decoded = decodePayload(session, envelope[keys.secureData]) as Record<string, any>;
    if (decoded?.[keys.signature]?.Erreur !== undefined) {
      throw new ServerSideError(String(decoded[keys.signature].MessageErreur ?? "Server Error"));
    }
    return decoded;
  });
};

/** "data" member of a decoded answer, whatever the Pronote version. */
export const answerData = (session: SessionHandle, answer: Record<string, any>): Record<string, any> =>
  answer[propertyKeys(session).data] ?? {};
