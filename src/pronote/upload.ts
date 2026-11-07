/**
 * File upload to Pronote, as the web client does before a Saisie* function that carries attachments
 * (docs/pronote-matrice/8-ressources.md, "Téléversement"): one multipart POST per file to
 * <base>/uploadfilesession/<space>/<session>, in chunks of 100 KiB with a content-range header, the same form
 * fields on every chunk (u_no: the next order number encrypted like a function call, u_ns: session, u_idR: the
 * function that will reference the file, u_idF: client file id, u_md5), then {etat, numeroOrdre}. A successful
 * upload consumes two order numbers of the session, like a function call: the answer carries sent + 1.
 *
 * Not validated on a real server (the demo server ignores writes): see the "À valider" list of the PR.
 */
import { createHash } from "node:crypto";
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { cipherKeys, decrypt, encrypt } from "./request.js";

/** Largest file accepted (bytes). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Chunk size of the web client (UploadFileAjax maxChunkSize). */
export const CHUNK_SIZE = 100 * 1024;

/** TypeEtatUpload of the answer: 0 unknown, 1 done, 2 error, 3 in progress. */
const STATE_DONE = 1;

/** Value sent as idFichier for a file already uploaded by a previous request. */
export const FILE_ID_IGNORE = "__idFichierAIgnorer__";

let counter = 0;

export type UploadRequest = {
  name: string;
  bytes: Buffer;
  /** Pronote function that will reference the file (u_idR), e.g. "SaisieCahierDeTextes". */
  functionName: string;
};

export type UploadResult = { fileId: string; name: string; size: number };

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: FormData }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** Client file id, like ObjetRequeteUploadFile: reqUpl_<n>_<timestamp>. */
export const nextFileId = (now = Date.now()): string => `reqUpl_${++counter}_${now}`;

/** Multipart form of one chunk (the same fields on every chunk of a file). */
export const buildForm = (
  fields: { order: string; session: string; functionName: string; fileId: string; md5: string },
  chunk: Buffer,
  name: string,
): FormData => {
  const form = new FormData();
  form.append("u_no", fields.order);
  form.append("u_ns", fields.session);
  form.append("u_idR", fields.functionName);
  form.append("u_idF", fields.fileId);
  form.append("u_md5", fields.md5);
  form.append("files[]", new Blob([new Uint8Array(chunk)]), name);
  return form;
};

/** Chunk boundaries [start, end) of a file, as UploadFileAjax._sendChunk cuts it. */
export const chunksOf = (size: number, chunkSize = CHUNK_SIZE): [number, number][] => {
  if (size <= chunkSize) return [[0, size]];
  const result: [number, number][] = [];
  for (let start = 0; start < size; start += chunkSize) result.push([start, Math.min(start + chunkSize, size)]);
  return result;
};

/**
 * Uploads one file in the session queue (order numbers never interleave with function calls) and returns the
 * client file id to put in the JSON of the next Saisie* call ({ L, G: 1, E: 1, IDFichier }).
 */
export const uploadFile = async (
  session: SessionHandle,
  request: UploadRequest,
  fetchImpl: FetchLike = (url, init) => fetch(url, init as RequestInit),
): Promise<UploadResult> => {
  if (request.bytes.length === 0) throw new HttpError(400, "empty_file");
  if (request.bytes.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "file_too_large");
  return session.queue.push(async () => {
    const info = session.information;
    const sent = info.order + 1;
    const { key, iv } = cipherKeys(session);
    const fields = {
      order: encrypt(String(sent), key, iv),
      session: String(info.id),
      functionName: request.functionName,
      fileId: nextFileId(),
      md5: createHash("md5").update(request.bytes).digest("hex"),
    };
    const url = `${info.url}/uploadfilesession/${info.accountKind}/${info.id}`;
    const size = request.bytes.length;
    const chunks = chunksOf(size);
    let last = "";
    for (const [start, end] of chunks) {
      const headers: Record<string, string> = {
        "content-disposition": `attachment; filename="${encodeURI(request.name)}"`,
      };
      if (chunks.length > 1) headers["content-range"] = `bytes ${start}-${end - 1}/${size}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: buildForm(fields, request.bytes.subarray(start, end), request.name),
      });
      last = await response.text();
      if (response.status < 200 || response.status >= 300) {
        throw new HttpError(502, `upload_failed:http_${response.status}`);
      }
    }
    let answer: { etat?: unknown; numeroOrdre?: unknown; message?: unknown } = {};
    try {
      answer = JSON.parse(last);
    } catch {
      throw new HttpError(502, "upload_failed:invalid_answer");
    }
    if (Number(answer.etat) !== STATE_DONE) {
      throw new HttpError(502, `upload_failed:${String(answer.message ?? `state_${String(answer.etat)}`)}`);
    }
    let received = Number.NaN;
    try {
      received = Number.parseInt(decrypt(String(answer.numeroOrdre ?? ""), key, iv), 10);
    } catch {
      // Handled below: an unreadable order number means the session is out of step.
    }
    if (received !== sent + 1) throw new HttpError(502, "upload_failed:order_mismatch");
    // Two order numbers consumed, as after a function call.
    info.order = sent + 1;
    return { fileId: fields.fileId, name: request.name, size };
  });
};
