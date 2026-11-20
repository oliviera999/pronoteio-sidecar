import { HttpError } from "../errors.js";
import { downloadUrl } from "../pronote/files.js";
import { isTabClosed } from "./functions.js";
import { rosterEntries } from "./roster.js";
import { pageOf } from "./tolerant.js";
/** Largest picture accepted (bytes). */
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
/** Default downloader: the session-bound URL needs no cookie (docs/pronote-matrice/8-ressources.md). */
export const download = async (url) => {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok)
        return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return { contentType: String(response.headers.get("content-type") ?? ""), bytes };
};
/** Type of a picture from its first bytes (JPEG, PNG, GIF), "" otherwise. */
export const imageType = (bytes) => {
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        return "image/jpeg";
    if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return "image/png";
    if (bytes.length > 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("latin1")))
        return "image/gif";
    return "";
};
/** Photo of one student of the roster (never kept: the caller sends it at once). */
const photoOf = async (session, entry, downloader) => {
    const empty = { available: false, reason: "", validated: false, student: entry.id, mime: "", size: 0, base64: "" };
    let file;
    try {
        file = await downloader(downloadUrl(session, { N: entry.pronoteId, L: "photo.jpg" }));
    }
    catch (error) {
        return { ...empty, reason: String(error?.message ?? error).slice(0, 300) };
    }
    // Without photo Pronote answers an HTML page ("La page demandée n'existe pas") or a 404.
    const mime = file ? imageType(file.bytes) : "";
    if (!file || mime === "")
        return { ...empty, reason: "no_photo" };
    if (file.bytes.length > MAX_PHOTO_BYTES)
        return { ...empty, reason: "photo_too_large" };
    return { ...empty, available: true, mime, size: file.bytes.length, base64: file.bytes.toString("base64") };
};
export const studentPhoto = async (session, resource, student, downloader = download) => {
    const empty = { available: false, reason: "", validated: false, student, mime: "", size: 0, base64: "" };
    if (isTabClosed(session, "studentFile"))
        return { ...empty, reason: "tab_closed:105" };
    const entry = (await rosterEntries(session, resource)).find((item) => item.id === student);
    if (!entry)
        throw new HttpError(404, "student_not_found");
    return photoOf(session, entry, downloader);
};
/* ---- 0.12.0: photos of a page of students ---- */
/** Largest number of photos sent in one answer (each up to MAX_PHOTO_BYTES before base64). */
export const MAX_PHOTOS = 10;
/**
 * Photos of a page of students of a class or group (or of one student), with one roster read for the page. The
 * pictures go straight to the answer: this route is neither cached nor allowed in a job, nothing is kept in memory.
 * Moodle (local_olutionmcp) checks the perimeter before asking and returns the image rights beside each photo.
 */
export const studentPhotos = async (session, resource, page = {}, downloader = download) => {
    const base = { available: false, reason: "", validated: false, total: 0, offset: 0, items: [] };
    if (isTabClosed(session, "studentFile"))
        return { ...base, reason: "tab_closed:105" };
    const { selected, offset, total } = pageOf(await rosterEntries(session, resource), page, MAX_PHOTOS, MAX_PHOTOS);
    const items = [];
    for (const entry of selected) {
        const photo = await photoOf(session, entry, downloader);
        items.push({ student: entry.id, label: entry.label, available: photo.available, reason: photo.reason, mime: photo.mime,
            size: photo.size, base64: photo.base64 });
    }
    return { ...base, available: true, total, offset, items };
};
//# sourceMappingURL=photos.js.map