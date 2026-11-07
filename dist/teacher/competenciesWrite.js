import { HttpError } from "../errors.js";
import { listOf, pronoteDate, pronoteNumber } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise } from "../normalise.js";
import { DEFAULT_LEVELS, isAccessDenied, itemFromList, levelsOf, ratingsFromPage } from "./competencies.js";
import { call, loadServices, pickPeriod, ref, resourceOf, serviceKey } from "./grades.js";
import { resolve, stableId } from "./ids.js";
import { rosterEntries } from "./roster.js";
import { sendWrite } from "./write.js";
const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const STATE_DELETED = 3;
const TYPE_HTML = 21;
const TYPE_NUMBER = 10;
const GENRE_STUDENT = 4;
/** Pronote element of a level code ({N, G, L} from the school's list, or {G, L} from the client enumeration). */
export const levelElement = (session, code) => {
    const raw = listOf(userData(session).acquisitionLevels).find((item) => Number(item?.G) === code);
    if (raw && typeof raw.N === "string")
        return { N: raw.N, G: code, L: String(raw.L ?? "") };
    // The school's list may be partial: the client enumeration completes it.
    const known = levelsOf(session).find((item) => item.code === code) ?? DEFAULT_LEVELS.find((item) => item.code === code);
    if (!known)
        throw new HttpError(400, `level_unknown:${code}`);
    return { G: code, L: known.name };
};
const number = (value) => ({ _T: TYPE_NUMBER, V: pronoteNumber(value) });
/** Students of an assessment page (ListeElevesCompetences) or of the roster, by label. */
const studentsOf = (page, roster) => {
    const fromPage = listOf(page?.ListeElevesCompetences)
        .filter((item) => typeof item?.N === "string")
        .map((item) => ({ N: String(item.N), L: String(item?.L ?? item?.eleve?.V?.L ?? "").trim() }));
    return fromPage.length ? fromPage : roster.map((item) => ({ N: item.pronoteId, L: item.label }));
};
/** SaisieEvaluations JSON for one assessment (creation, modification or deletion). */
export const buildCompetencyRequest = (session, service, resource, period, existing, skillIds, students, write) => {
    const skills = listOf(existing?.listeCompetences);
    const byStableId = new Map();
    skills.forEach((skill) => {
        const key = String(skill?.relationESI?.V?.N ?? skill?.N ?? "");
        const id = skillIds.get(key);
        if (id)
            byStableId.set(id, skill);
    });
    const wantedSkills = write.skills ?? [...byStableId.keys()];
    const skillMembers = wantedSkills.map((id, index) => {
        const skill = byStableId.get(id);
        if (skill) {
            return {
                N: skill.N,
                E: STATE_MODIFIED,
                relationESI: skill.relationESI?.V ? ref(skill.relationESI.V) : undefined,
                coefficient: skill.coefficient ?? number(1),
                niveauAcquiDefaut: skill.niveauAcquiDefaut,
                ordre: index,
                palier: skill.palier,
            };
        }
        // Creation from a relation ESI identifier of the school's grid (not a stable id).
        return { N: 0, E: STATE_CREATED, relationESI: { N: id }, coefficient: number(1), ordre: index };
    });
    const relationOf = (skillId) => {
        const skill = byStableId.get(skillId);
        if (skill?.relationESI?.V)
            return ref(skill.relationESI.V);
        if (wantedSkills.includes(skillId))
            return { N: skillId };
        throw new HttpError(404, `skill_not_found:${skillId}`);
    };
    const byStudent = new Map();
    for (const rating of write.ratings ?? []) {
        const key = normalise(rating.student);
        byStudent.set(key, [...(byStudent.get(key) ?? []), rating]);
    }
    const studentMembers = [...byStudent.entries()].map(([key, ratings]) => {
        const student = students.find((item) => normalise(item.L) === key);
        if (!student)
            throw new HttpError(404, `student_not_found:${ratings[0].student}`);
        return {
            N: student.N,
            G: GENRE_STUDENT,
            E: STATE_MODIFIED,
            listeCompetences: ratings.map((rating) => ({
                relationESI: relationOf(rating.skill),
                niveauDAcquisition: levelElement(session, rating.level),
                observation: rating.observation ?? "",
                observationPubliee: rating.published === true,
            })),
        };
    });
    const date = write.date !== undefined ? new Date(write.date * 1000) : null;
    const evaluation = {
        N: existing ? existing.N : 0,
        E: write.delete ? STATE_DELETED : existing ? STATE_MODIFIED : STATE_CREATED,
        L: write.title ?? String(existing?.L ?? ""),
        Service: ref(service),
        ...(resource ? { Ressource: ref(resource) } : {}),
        Periode: ref(period),
        ListeThemes: listOf(existing?.ListeThemes).map(ref),
        DateValidation: date ? pronoteDate(date) : existing?.dateValidation ?? null,
        DatePublication: write.publication === undefined
            ? existing?.datePublication ?? null
            : write.publication === null
                ? null
                : pronoteDate(new Date(write.publication * 1000)),
        Descriptif: { _T: TYPE_HTML, V: write.description ?? String(existing?.descriptif?.V ?? "") },
        coefficient: write.coefficient !== undefined ? number(write.coefficient) : existing?.coefficient ?? number(1),
        priseEnCompteDansBilan: existing?.priseEnCompteDansBilan ?? true,
        listeCompetences: write.delete ? [] : skillMembers,
        listeEleves: write.delete ? [] : studentMembers,
    };
    return { service: ref(service), ...(resource ? { ressource: ref(resource) } : {}), listeEvaluations: [evaluation], listeFichiers: [] };
};
/* non validé sur la démo : onglet 65 fermé au profil de démonstration, écritures ignorées */
export const writeCompetency = async (session, write) => {
    const picked = await pickPeriod(session, write.period);
    const services = await loadServices(session, picked.period);
    const service = resolve("service", write.service, services, serviceKey);
    const resource = resourceOf(service);
    const resourcename = String(resource?.L ?? "");
    const type = userData(session).resources.find((item) => item.label === resourcename)?.genre === 2 ? "group" : "class";
    const resourceRef = resource ? { ...resource, G: type === "group" ? 2 : 1 } : undefined;
    const subject = String(service.matiere?.V?.L ?? service.L ?? "");
    let list;
    try {
        list = await call(session, "competencyList", {
            service: ref(service),
            ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
            periode: ref(picked.period),
        });
    }
    catch (error) {
        if (isAccessDenied(error))
            throw new HttpError(403, "access_denied");
        throw error;
    }
    const evaluations = listOf(list?.listeEvaluations);
    let existing = null;
    let before = null;
    let skillIds = new Map();
    let page = null;
    if (write.assessment) {
        for (const evaluation of evaluations) {
            const parsed = itemFromList(evaluation, subject, resourcename, type);
            if (parsed.item.id === write.assessment) {
                existing = evaluation;
                skillIds = parsed.skillIds;
                page = await call(session, "competencyPage", {
                    evaluation: ref(evaluation),
                    ...(evaluation.devoir?.V?.N ? { devoir: ref(evaluation.devoir.V) } : {}),
                    ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
                    periodeEvaluation: ref(picked.period),
                });
                parsed.item.ratings = ratingsFromPage(page, skillIds);
                before = parsed.item;
                break;
            }
        }
        if (!existing)
            throw new HttpError(404, "assessment_not_found");
    }
    else if (!write.title || write.date === undefined) {
        throw new HttpError(400, "title_and_date_required");
    }
    if (write.delete && !existing)
        throw new HttpError(400, "delete_without_id");
    const roster = resourceRef ? await rosterEntries(session, stableId(type, resourcename)) : [];
    const students = studentsOf(page, roster);
    const request = buildCompetencyRequest(session, service, resourceRef, picked.period, existing, skillIds, students, write);
    const plannedTitle = write.title ?? before?.title ?? "";
    const plannedDate = write.date ?? before?.date ?? null;
    const planned = write.delete
        ? null
        : {
            id: before?.id ?? stableId("competency", `${plannedDate ?? 0}|${resourcename}|${plannedTitle}`),
            title: plannedTitle,
            date: plannedDate,
            publication: write.publication === undefined ? before?.publication ?? null : write.publication,
            subject,
            resourcename,
            type,
            skills: before?.skills.filter((skill) => (write.skills ?? before.skills.map((s) => s.id)).includes(skill.id)) ?? [],
            ratings: mergeRatings(before?.ratings ?? [], write.ratings ?? []),
        };
    if (write.dryRun)
        return { before, after: planned, request, written: false, dryRun: true, validated: false };
    await sendWrite(session, "competencySave", request, write.force === true);
    const reread = listOf((await call(session, "competencyList", {
        service: ref(service),
        ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
        periode: ref(picked.period),
    }))?.listeEvaluations);
    const found = reread.map((item) => itemFromList(item, subject, resourcename, type)).find((parsed) => parsed.item.id === (planned?.id ?? before?.id));
    if (write.delete) {
        if (found)
            throw new HttpError(502, "assessment_not_deleted");
        return { before, after: null, request, written: true, dryRun: false, validated: false };
    }
    if (!found)
        throw new HttpError(502, "assessment_not_saved");
    const evaluation = reread.find((item) => itemFromList(item, subject, resourcename, type).item.id === found.item.id);
    const afterPage = await call(session, "competencyPage", {
        evaluation: ref(evaluation),
        ...(evaluation.devoir?.V?.N ? { devoir: ref(evaluation.devoir.V) } : {}),
        ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
        periodeEvaluation: ref(picked.period),
    });
    found.item.ratings = ratingsFromPage(afterPage, found.skillIds);
    return { before, after: found.item, request, written: true, dryRun: false, validated: false };
};
/** Ratings as they should read after the write: requested levels replace the ones read. */
export const mergeRatings = (before, changes) => {
    const result = before.map((item) => ({ ...item }));
    for (const change of changes) {
        const index = result.findIndex((item) => normalise(item.student) === normalise(change.student) && item.skill === change.skill);
        const next = { student: change.student, skill: change.skill, level: change.level, observation: change.published ? change.observation ?? "" : "" };
        if (index >= 0)
            result[index] = { ...result[index], ...next, student: result[index].student };
        else
            result.push(next);
    }
    return result;
};
//# sourceMappingURL=competenciesWrite.js.map