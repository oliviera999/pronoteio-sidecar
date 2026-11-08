/**
 * Download URL of a file attached to a Pronote element, valid for the current session only (the same scheme
 * as the web client and Pawnote): FichiersExternes/<AES({N, Actif: true})>/<name>?Session=<id>.
 */
import type { SessionHandle } from "pawnote";
import { cipherKeys, encrypt } from "./request.js";

export const downloadUrl = (session: SessionHandle, file: { N: string; L?: string }): string => {
  const { key, iv } = cipherKeys(session);
  const token = encrypt(JSON.stringify({ N: file.N, Actif: true }), key, iv);
  return `${session.information.url}/FichiersExternes/${token}/${encodeURIComponent(String(file.L ?? ""))}?Session=${session.information.id}`;
};
