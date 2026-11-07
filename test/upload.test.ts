import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionHandle } from "pawnote";
import { cipherKeys, decrypt, encrypt } from "../src/pronote/request.js";
import { CHUNK_SIZE, buildForm, chunksOf, uploadFile } from "../src/pronote/upload.js";

const session = () =>
  ({
    information: { url: "https://demo.example/pronote", id: "sess1", accountKind: 3, order: 10, aesKey: "0123456789abcdef", aesIV: "fedcba9876543210" },
    queue: { push: <T>(fn: () => Promise<T>) => fn() },
  }) as unknown as SessionHandle;

test("a file is cut in chunks of 100 KiB like the web client", () => {
  assert.deepEqual(chunksOf(10), [[0, 10]]);
  assert.deepEqual(chunksOf(CHUNK_SIZE), [[0, CHUNK_SIZE]]);
  assert.deepEqual(chunksOf(CHUNK_SIZE * 2 + 5), [[0, CHUNK_SIZE], [CHUNK_SIZE, CHUNK_SIZE * 2], [CHUNK_SIZE * 2, CHUNK_SIZE * 2 + 5]]);
});

test("the multipart form carries the Pronote fields and the file", async () => {
  const form = buildForm({ order: "abc", session: "sess1", functionName: "SaisieCahierDeTextes", fileId: "reqUpl_1_2", md5: "d41d" }, Buffer.from("hello"), "a.txt");
  assert.equal(form.get("u_no"), "abc");
  assert.equal(form.get("u_ns"), "sess1");
  assert.equal(form.get("u_idR"), "SaisieCahierDeTextes");
  assert.equal(form.get("u_idF"), "reqUpl_1_2");
  assert.equal(form.get("u_md5"), "d41d");
  const file = form.get("files[]") as File;
  assert.equal(file.name, "a.txt");
  assert.equal(await file.text(), "hello");
});

test("an upload sends the encrypted order, checks the answer and consumes two order numbers", async () => {
  const handle = session();
  const { key, iv } = cipherKeys(handle);
  const calls: { url: string; headers: Record<string, string>; order: string; size: number }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: FormData }) => {
    const file = init.body.get("files[]") as File;
    calls.push({ url, headers: init.headers, order: String(init.body.get("u_no")), size: file.size });
    return { status: 200, text: async () => JSON.stringify({ etat: 1, numeroOrdre: encrypt("12", key, iv) }) };
  };
  const bytes = Buffer.alloc(CHUNK_SIZE + 10, 1);
  const result = await uploadFile(handle, { name: "sujet é.pdf", bytes, functionName: "SaisieCahierDeTextes" }, fetchImpl);
  assert.match(result.fileId, /^reqUpl_\d+_\d+$/);
  assert.equal(result.size, bytes.length);
  assert.equal(calls.length, 2, "two chunks");
  assert.equal(calls[0].url, "https://demo.example/pronote/uploadfilesession/3/sess1");
  assert.equal(decrypt(calls[0].order, key, iv), "11", "the next order number is sent");
  assert.equal(calls[0].order, calls[1].order, "the same fields on every chunk");
  assert.equal(calls[0].headers["content-range"], `bytes 0-${CHUNK_SIZE - 1}/${bytes.length}`);
  assert.equal(calls[1].headers["content-range"], `bytes ${CHUNK_SIZE}-${bytes.length - 1}/${bytes.length}`);
  assert.equal(calls[0].headers["content-disposition"], 'attachment; filename="sujet%20%C3%A9.pdf"');
  assert.equal(calls[1].size, 10);
  assert.equal(handle.information.order, 12, "two order numbers consumed");
});

test("a wrong order number or a failed state is an error and leaves the order untouched", async () => {
  const handle = session();
  const { key, iv } = cipherKeys(handle);
  const bad = async () => ({ status: 200, text: async () => JSON.stringify({ etat: 1, numeroOrdre: encrypt("15", key, iv) }) });
  await assert.rejects(uploadFile(handle, { name: "a.txt", bytes: Buffer.from("x"), functionName: "SaisieCasier" }, bad), /order_mismatch/);
  const failed = async () => ({ status: 200, text: async () => JSON.stringify({ etat: 2, message: "Fichier refusé" }) });
  await assert.rejects(uploadFile(handle, { name: "a.txt", bytes: Buffer.from("x"), functionName: "SaisieCasier" }, failed), /upload_failed:Fichier refusé/);
  assert.equal(handle.information.order, 10);
  await assert.rejects(uploadFile(handle, { name: "a.txt", bytes: Buffer.alloc(0), functionName: "SaisieCasier" }, failed), /empty_file/);
});
