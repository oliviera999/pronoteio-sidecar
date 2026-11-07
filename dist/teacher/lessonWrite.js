import { HttpError } from "../errors.js";
import { answerData, callPronote, entryReport, propertyKeys } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { findLesson } from "./notebookWrite.js";
import { lessons } from "./timetable.js";
/** TypeHttpRessource of a room and of the "Salles" group of RessourceEDT. */
const GENRE_ROOM = 17;
const RESOURCES_ROOMS = 81;
/** Rooms of the school from a RessourceEDT answer ("data" member). */
export const roomsOf = (data) => listOf(data?.listeRessources)
    .filter((group) => Number(group?.G) === RESOURCES_ROOMS)
    .flatMap((group) => listOf(group?.liste))
    .filter((item) => typeof item?.N === "string" && Number(item?.G ?? GENRE_ROOM) === GENRE_ROOM)
    .map((item) => ({ N: String(item.N), L: String(item.L ?? "").trim() }));
export const resolveRooms = (rooms, labels) => labels.map((label) => {
    const found = rooms.find((item) => normalise(item.L) === normalise(label));
    if (!found)
        throw new HttpError(404, `room_not_found:${label}`);
    return found;
});
/** Refuses a lesson the profile may not modify (flags of the lesson, then the explicit right when known). */
export const assertEditable = (ref, rights, forRooms) => {
    if (!ref.lesson.editable)
        throw new HttpError(409, "lesson_not_editable");
    if (!forRooms)
        return;
    if (!ref.lesson.roomsEditable)
        throw new HttpError(409, "lesson_rooms_not_editable");
    const cours = rights?.cours;
    if (cours && typeof cours === "object" && cours.modifierSalles === false)
        throw new HttpError(409, "lesson_rooms_not_editable");
};
/** SaisieCours JSON for a room change or a memo (exactly one of them). */
export const buildLessonRequest = (ref, change, rooms) => {
    const base = {
        cours: { N: ref.pronoteId, G: 0, ...(ref.label ? { L: ref.label } : {}) },
        numeroSemaine: ref.week,
        estEDTAnnuel: false,
        suppressionCours: false,
        deplacementCours: false,
        forcerSaisie: change.force === true,
    };
    if (rooms !== null) {
        return {
            ...base,
            genreRessource: GENRE_ROOM,
            listeRessources: rooms.map((item) => ({ N: item.N, G: GENRE_ROOM, L: item.L })),
            ressourcesRemplacees: ref.rooms.map((item) => ({ N: item.N, G: GENRE_ROOM, L: item.L })),
        };
    }
    return { ...base, modificationMemo: String(change.memo ?? "") };
};
export const changeLesson = async (session, lessonId, change) => {
    const wantsRooms = Array.isArray(change.rooms);
    const wantsMemo = typeof change.memo === "string";
    if (wantsRooms === wantsMemo)
        throw new HttpError(400, "one_change_per_request");
    const ref = await findLesson(session, lessonId);
    assertEditable(ref, userData(session).rights, wantsRooms);
    let rooms = null;
    if (wantsRooms) {
        const fn = requireFunction("timetableResources");
        const answer = await callPronote(session, { name: fn.name, data: {}, signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined });
        rooms = resolveRooms(roomsOf(answerData(session, answer)), change.rooms ?? []);
    }
    const request = buildLessonRequest(ref, change, rooms);
    const before = { rooms: ref.lesson.rooms };
    const planned = { rooms: rooms ? rooms.map((item) => item.L) : ref.lesson.rooms, ...(wantsMemo ? { memo: change.memo } : {}) };
    if (change.dryRun)
        return { lesson: ref.lesson, before, after: planned, request, written: false, dryRun: true };
    const fn = requireFunction("lessonSave");
    const answer = await callPronote(session, {
        name: fn.name,
        data: request,
        signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
        keepRefusal: true,
    });
    const report = entryReport(answer, propertyKeys(session).data);
    if (report?.refusSaisie) {
        const messages = listOf(report._messagesErreur_).map((item) => (typeof item === "string" ? item : String(item?.L ?? ""))).filter(Boolean);
        throw new HttpError(409, `pronote_refused:${[report.titre_Messages_Erreur, ...messages].filter(Boolean).join(" : ")}`);
    }
    if (report?.demandeConfirmationSaisie && !change.force) {
        const confirmation = report.demandeConfirmationSaisie;
        throw new HttpError(409, `confirmation_required:${[confirmation?.titre, confirmation?.message].filter(Boolean).join(" : ")}`);
    }
    if (report?._erreurSaisie_ === true) {
        throw new HttpError(409, `pronote_refused:${String(report.titre_Messages_Erreur ?? "")}`);
    }
    const day = new Date(ref.lesson.start * 1000);
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const reread = (await lessons(session, start, new Date(start.getTime() + 24 * 3600 * 1000))).find((item) => item.lesson.id === lessonId);
    if (!reread)
        throw new HttpError(502, "lesson_not_found_after_write");
    if (rooms && rooms.some((room) => !reread.lesson.rooms.some((label) => normalise(label) === normalise(room.L)))) {
        throw new HttpError(502, "lesson_not_saved");
    }
    return { lesson: reread.lesson, before, after: { rooms: reread.lesson.rooms, ...(wantsMemo ? { memo: change.memo } : {}) }, request, written: true, dryRun: false };
};
//# sourceMappingURL=lessonWrite.js.map