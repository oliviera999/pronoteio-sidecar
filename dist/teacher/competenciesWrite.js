import { currentContext } from "../context.js";
import { HttpError } from "../errors.js";
import { listOf, parsePronoteDate, pronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { labelKey, normalise, seconds } from "../normalise.js";
import { epochToWall } from "../time.js";
import { competencyElement, ensureSkillsSpace, evaluationKey, findReferentialItem, levelFromRaw, listEvaluations, loadEvaluationPage, loadReferential, parentsDelayOf, parseEvaluations, ratingsFromPage, rawSchoolLevels, resourceRefOf, studentLabelOf, studentNamesOf, } from "./competencies.js";
import { loadAllServices, pickPeriod, ref, resolveService, resourceOf, resourceType, serviceIdsOf } from "./grades.js";
import { stableId } from "./ids.js";
import { rosterEntries } from "./roster.js";
import { sendWrite } from "./write.js";
const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const STATE_DELETED = 3;
const GENRE_STUDENT = 4;
/** Numbers of the elements created by the client start below -1000 (ObjetElement.getNumeroCreation). */
const FIRST_CREATION_NUMBER = -1001;
/** Member names of an object (never its values), for the access log of an answer not understood. */
const memberNames = (value) => value && typeof value === "object" ? Object.keys(value).filter((key) => /^[\w$]{1,40}$/.test(key)).sort().slice(0, 20).join(",") : "-";
const unwrap = (value) => value !== null && typeof value === "object" && "V" in value ? value.V : value;
/**
 * Pronote element of a level code: {N, G, L} of the school's list. 409 levels_unknown when the list was not read at
 * login (nothing is written with the codes of the client enumeration); 400 level_unknown:<code> for a code the school
 * does not have, level_inactive:<code> for a level it has but does not use in assessments.
 */
export const levelElement = (session, code) => {
    const raw = rawSchoolLevels(session);
    if (raw.length === 0)
        throw new HttpError(409, "levels_unknown");
    const found = raw.find((item) => Number(item.G) === code);
    if (!found)
        throw new HttpError(400, `level_unknown:${code}`);
    if (!levelFromRaw(found).active)
        throw new HttpError(400, `level_inactive:${code}`);
    return { N: found.N, G: code, L: String(found.L ?? "") };
};
/** Wall date at midnight of a timestamp: assessment and publication dates are days. */
export const wallDay = (epochSeconds) => {
    const wall = epochToWall(epochSeconds);
    return new Date(wall.getFullYear(), wall.getMonth(), wall.getDate());
};
/**
 * Default publication date of an assessment, as the client computes it (getProchaineDateOuvreePourPublication): the
 * day of the assessment plus General.NbJDecalageDatePublicationParDefaut days (1 when Pronote does not give it; 0: the
 * same day), then the next working day (General.JoursOuvres, Monday to Friday when not received). Holidays are not
 * known here: Pronote moves the date itself if needed.
 */
export const defaultPublication = (session, day) => {
    const data = userData(session);
    const delay = data.publicationDelayDays ?? 1;
    const date = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    if (delay === 0)
        return date;
    date.setDate(date.getDate() + Math.abs(delay));
    const working = data.workingDays.length ? data.workingDays : [1, 2, 3, 4, 5];
    const step = delay < 0 ? -1 : 1;
    for (let tries = 0; tries < 14 && !working.includes(((date.getDay() + 6) % 7) + 1); tries++)
        date.setDate(date.getDate() + step);
    return date;
};
/** Students of an assessment page (listeEleves, else ListeElevesCompetences) or of the roster, by label. */
export const studentsOf = (page, roster) => {
    const names = studentNamesOf(page);
    const listed = listOf(page?.listeEleves ?? page?.ListeEleves)
        .filter((item) => typeof item?.N === "string" && String(item?.L ?? "").trim() !== "")
        .map((item) => ({ N: String(item.N), L: String(item.L).trim(), ...(typeof item.G === "number" ? { G: item.G } : {}) }));
    if (listed.length)
        return listed;
    const fromPage = listOf(page?.ListeElevesCompetences)
        .filter((item) => typeof item?.N === "string")
        .map((item) => ({ N: String(item.N), L: studentLabelOf(item, names, page ?? undefined) }));
    // 0.11.5: rows without a label are completed from the roster of the same session (same ids), else left out.
    if (fromPage.some((item) => item.L === "")) {
        const byId = new Map(roster.map((item) => [item.pronoteId, item.label]));
        for (const item of fromPage)
            if (item.L === "")
                item.L = byId.get(item.N) ?? "";
    }
    return fromPage.length ? fromPage : roster.map((item) => ({ N: item.pronoteId, L: item.label }));
};
/**
 * Skills wanted in the assessment, resolved against the existing skills of the assessment (stable ids), then the
 * referential of the service (rf: id, code "D2/4.1" or label), then a raw element identifier ("14#…", legacy).
 * HTTP 404 skill_not_found:<value> otherwise.
 */
export const resolveSkills = (wanted, existing, skillIds, referential) => {
    const byStableId = new Map();
    const skills = listOf(existing?.listeCompetences);
    skills.forEach((skill) => {
        const id = skillIds.get(String(skill?.relationESI?.V?.N ?? skill?.N ?? ""));
        if (id)
            byStableId.set(id, skill);
    });
    const relationOf = (skill) => (skill.relationESI?.V ? ref(skill.relationESI.V) : { N: skill.N });
    return wanted.map((key) => {
        const skill = byStableId.get(key);
        if (skill)
            return { key, existing: skill, relation: relationOf(skill), item: null };
        const item = findReferentialItem(key, referential());
        if (item) {
            // The assessment already has this element of the referential: its own relation, nothing is created.
            const same = skills.find((s) => String(s?.N ?? "") === item.node.N || String(s?.relationESI?.V?.N ?? "") === item.relation);
            if (same)
                return { key, existing: same, relation: relationOf(same), item };
            return { key, existing: null, relation: { ...item.node }, item };
        }
        if (/^\d+#/.test(key))
            return { key, existing: null, relation: { N: key }, item: null };
        throw new HttpError(404, `skill_not_found:${key}`);
    });
};
/** Ratings to send: explicit ones, plus the default level for every student and skill they leave out. */
export const expandRatings = (ratings, defaultLevel, students, skills) => {
    if (defaultLevel === undefined || defaultLevel === null)
        return ratings;
    const given = new Set(ratings.map((rating) => `${normalise(rating.student)}|${rating.skill}`));
    const result = [...ratings];
    for (const student of students) {
        for (const skill of skills) {
            if (!given.has(`${normalise(student.L)}|${skill}`))
                result.push({ student: student.L, skill, level: defaultLevel });
        }
    }
    return result;
};
/** Skill of an assessment created with it, or added to it: a copy of the element of the referential, in state E 1. */
const createdSkill = (session, skill, position, number, defaultLevel) => {
    const palier = skill.item?.palier ?? null;
    if (!palier) {
        // The client always sends the cycle of the domain: its absence is worth a line in the access log.
        const context = currentContext();
        if (context && !context.shape)
            context.shape = `skill-without-palier:${memberNames(skill.relation)}`;
    }
    return {
        ...skill.relation,
        E: STATE_CREATED,
        coefficient: 1,
        relationESI: { N: number, E: STATE_CREATED },
        ...(defaultLevel !== undefined ? { niveauAcquiDefaut: levelElement(session, defaultLevel) } : {}),
        ordre: position,
        ...(palier ? { palier: ref(palier) } : {}),
    };
};
/** Members of an assessment that both the creation and the modification send (_serialiseEvaluation of the client). */
const commonMembers = (service, resource, period) => ({
    Service: ref(service),
    ...(resource ? { Ressource: ref(resource) } : {}),
    Periode: ref(period),
});
/** Date and publication of a write, as days: the publication is never before the assessment (as in the client). */
export const plannedDates = (session, write, existing) => {
    const before = { date: parsePronoteDate(existing?.dateValidation?.V), publication: parsePronoteDate(existing?.datePublication?.V) };
    const date = write.date !== undefined ? wallDay(write.date) : before.date;
    let publication = write.publication !== undefined && write.publication !== null ? wallDay(write.publication) : before.publication;
    let publicationDefault = false;
    if (!existing && !publication && date) {
        publication = defaultPublication(session, date);
        publicationDefault = true;
    }
    if (date && publication && publication < date)
        publication = new Date(date.getTime());
    return { date, publication, publicationDefault };
};
/** SaisieEvaluations JSON that creates one assessment, without any student (step 2 of the header). */
export const buildCreationRequest = (session, service, resource, period, write, skills) => {
    const { date, publication } = plannedDates(session, write, null);
    if (!date || !publication)
        throw new HttpError(400, "title_and_date_required");
    const evaluation = {
        N: FIRST_CREATION_NUMBER,
        E: STATE_CREATED,
        L: String(write.title ?? "").trim(),
        ...commonMembers(service, resource, period),
        periodeSecondaire: {},
        DateValidation: pronoteDate(date),
        DatePublication: pronoteDate(publication),
        Descriptif: write.description ?? "",
        coefficient: write.coefficient ?? 1,
        priseEnCompteDansBilan: write.cycleReport ?? true,
        listeCompetences: skills.map((skill, index) => createdSkill(session, skill, index + 1, FIRST_CREATION_NUMBER - 1 - index, write.defaultLevel)),
        listeSujets: [],
        listeCorriges: [],
    };
    return { service: ref(service), ...(resource ? { ressource: ref(resource) } : {}), listeEvaluations: [evaluation], listeFichiers: [] };
};
/** Skill of an existing assessment designated in a rating: its element, by stable id, write key or referential item. */
const skillOfRating = (skillId, existing, skillIds, wanted) => {
    const skills = listOf(existing.listeCompetences);
    const stable = skills.find((skill) => skillIds.get(String(skill?.relationESI?.V?.N ?? skill?.N ?? "")) === skillId);
    if (stable)
        return stable;
    const asked = wanted.find((skill) => skill.key === skillId) ?? wanted.find((skill) => skill.item && findReferentialItem(skillId, [skill.item]));
    if (asked?.existing && skills.includes(asked.existing))
        return asked.existing;
    if (asked) {
        // Skill created by the previous request: found again by the element of the referential, else by its label.
        const elementId = String(asked.item?.node.N ?? asked.relation.N ?? "");
        const label = normalise(String(asked.item?.node.L ?? asked.relation.L ?? ""));
        const found = skills.find((skill) => String(skill?.N ?? "") === elementId)
            ?? (label ? skills.find((skill) => normalise(String(skill?.L ?? "")) === label) : undefined)
            ?? (skills.length === wanted.length ? skills[wanted.indexOf(asked)] : undefined);
        if (found)
            return found;
    }
    throw new HttpError(404, `skill_not_found:${skillId}`);
};
/** Has the write a change of the assessment itself (title, dates, description, coefficient, cycle report)? */
const changesProperties = (session, write, existing) => {
    const sameDay = (a, b) => (a === null || b === null ? a === b : a.getTime() === b.getTime());
    const planned = plannedDates(session, write, existing);
    const read = { date: parsePronoteDate(existing.dateValidation?.V), publication: parsePronoteDate(existing.datePublication?.V) };
    const midnight = (date) => (date ? new Date(date.getFullYear(), date.getMonth(), date.getDate()) : null);
    const coefficient = Number.parseFloat(String(unwrap(existing.coefficient) ?? "").replace(",", "."));
    return (write.title !== undefined && write.title.trim() !== String(existing.L ?? "").trim())
        || (write.date !== undefined && !sameDay(planned.date, midnight(read.date)))
        || (write.publication !== undefined && write.publication !== null && !sameDay(planned.publication, midnight(read.publication)))
        || (write.description !== undefined && write.description !== String(unwrap(existing.descriptif) ?? ""))
        || (write.coefficient !== undefined && write.coefficient !== coefficient)
        || (write.cycleReport !== undefined && write.cycleReport !== (existing.priseEnCompteDansBilan !== false));
};
/**
 * SaisieEvaluations JSON for an existing assessment: deletion (E 3), modification of its properties (E 2), skills
 * added (E 1, without students: their levels follow in a second request), levels of the students (E 2 on the students
 * and on their skills; the assessment has no state when only levels change, as the unit entry of the client).
 */
export const buildUpdateRequest = (session, service, resource, period, existing, skillIds, students, write, wanted, ratings, options = {}) => {
    const withStructure = options.withStructure !== false;
    // Observation already stored for a student and a relation (raw page): sent back untouched when only the level changes.
    const storedObservation = (studentId, relationId) => {
        const row = listOf(options.page?.ListeElevesCompetences).find((item) => String(item?.N ?? "") === studentId);
        const cell = listOf(row?.ListeCompetences).find((item) => String(item?.N ?? "") === relationId);
        const text = unwrap(cell?.Observation);
        return { text: typeof text === "string" ? text : "", published: cell?.ObservationPubliee === true };
    };
    const added = withStructure ? wanted.filter((skill) => !skill.existing) : [];
    const modified = !write.delete && withStructure && (changesProperties(session, write, existing) || added.length > 0);
    const kept = listOf(existing.listeCompetences).length;
    const defaulted = withStructure && write.defaultLevel !== undefined && !write.delete
        ? wanted.filter((skill) => skill.existing).map((skill) => ({
            ...ref(skill.existing),
            E: STATE_MODIFIED,
            coefficient: unwrap(skill.existing.coefficient) ?? 1,
            relationESI: skill.relation,
            niveauAcquiDefaut: levelElement(session, write.defaultLevel),
            ordre: skill.existing.P ?? skill.existing.ordre,
            ...(unwrap(skill.existing.palier) ? { palier: ref(unwrap(skill.existing.palier)) } : {}),
        }))
        : [];
    const skillMembers = [
        ...defaulted,
        ...added.map((skill, index) => createdSkill(session, skill, kept + index + 1, FIRST_CREATION_NUMBER - 1 - index, write.defaultLevel)),
    ];
    const byStudent = new Map();
    for (const rating of write.delete ? [] : ratings) {
        const key = normalise(rating.student);
        byStudent.set(key, [...(byStudent.get(key) ?? []), rating]);
    }
    const studentMembers = [...byStudent.entries()].map(([key, items]) => {
        const student = students.find((item) => normalise(item.L) === key);
        if (!student)
            throw new HttpError(404, `student_not_found:${items[0].student}`);
        return {
            N: student.N,
            G: student.G ?? GENRE_STUDENT,
            L: student.L,
            E: STATE_MODIFIED,
            listeCompetences: items.map((rating) => {
                const skill = skillOfRating(rating.skill, existing, skillIds, wanted);
                const relation = skill.relationESI?.V ? ref(skill.relationESI.V) : { N: skill.N };
                // The client always sends the observation with a level ("" for a skill never rated): the one given, else the
                // one Pronote already holds, so that a level change never erases the teacher's observation.
                const stored = storedObservation(student.N, String(relation.N));
                return {
                    ...ref(skill),
                    E: STATE_MODIFIED,
                    relationESI: relation,
                    niveauDAcquisition: levelElement(session, rating.level),
                    observation: typeof rating.observation === "string" ? rating.observation : stored.text,
                    observationPubliee: typeof rating.observation === "string" ? rating.published === true
                        : rating.published ?? stored.published,
                };
            }),
        };
    });
    const dates = plannedDates(session, write, existing);
    const own = unwrap(existing.periode);
    const secondary = unwrap(existing.periodeSecondaire);
    const evaluation = {
        ...ref(existing),
        ...(write.delete ? { E: STATE_DELETED } : modified ? { E: STATE_MODIFIED } : {}),
        L: withStructure && write.title !== undefined ? write.title.trim() : String(existing.L ?? ""),
        ...commonMembers(service, resource, own && typeof own.N === "string" ? own : period),
        periodeSecondaire: secondary && typeof secondary.N === "string" ? ref(secondary) : {},
        ListeThemes: listOf(existing.ListeThemes).map(ref),
        DateValidation: withStructure && write.date !== undefined && dates.date ? pronoteDate(dates.date) : existing.dateValidation ?? null,
        DatePublication: withStructure && write.publication !== undefined && write.publication !== null && dates.publication
            ? pronoteDate(dates.publication)
            : existing.datePublication ?? null,
        Descriptif: withStructure && write.description !== undefined ? write.description : String(unwrap(existing.descriptif) ?? ""),
        coefficient: withStructure && write.coefficient !== undefined ? write.coefficient : unwrap(existing.coefficient) ?? 1,
        priseEnCompteDansBilan: withStructure ? write.cycleReport ?? existing.priseEnCompteDansBilan ?? true : existing.priseEnCompteDansBilan ?? true,
        ...(skillMembers.length && !write.delete ? { listeCompetences: skillMembers } : {}),
        ...(studentMembers.length ? { listeEleves: studentMembers } : {}),
        listeSujets: [],
        listeCorriges: [],
    };
    return {
        service: ref(service),
        ...(resource ? { ressource: ref(resource) } : {}),
        listeEvaluations: [evaluation],
        // The client sends the files list from the assessment window only, never with the unit entry of the levels.
        ...(write.delete || modified ? { listeFichiers: [] } : {}),
    };
};
/**
 * SaisieEvaluations JSON of the first request of a write (kept for the callers and tests of 0.8.0): the creation when
 * there is no assessment, else the modification with the levels.
 */
export const buildCompetencyRequest = (session, service, resource, period, existing, skillIds, students, write, resolved) => {
    const wanted = resolved ?? resolveSkills(write.skills ?? [...skillIds.values()], existing, skillIds, () => []);
    if (!existing)
        return buildCreationRequest(session, service, resource, period, write, wanted);
    const ratings = write.delete ? [] : expandRatings(write.ratings ?? [], write.defaultLevel, students, wanted.map((skill) => skill.key));
    return buildUpdateRequest(session, service, resource, period, existing, skillIds, students, write, wanted, ratings);
};
/** Identifier of the assessment created by a save: RapportSaisie.listeEvaluationsCreees (also looked for in "data"). */
export const createdNumber = (sent) => {
    for (const holder of [sent.report, sent.data, sent.data?.RapportSaisie]) {
        const first = listOf(holder?.listeEvaluationsCreees)[0];
        if (first && typeof first.N === "string")
            return first.N;
    }
    return null;
};
/** Levels of "wanted" found in the ratings read (same student, same skill, same level). */
export const countSaved = (wanted, read, skillOf) => wanted.filter((rating) => read.some((item) => normalise(item.student) === normalise(rating.student)
    && item.skill === skillOf(rating.skill) && item.level === rating.level)).length;
/* non validé sur la démo : onglets 56 et 65 fermés au profil de démonstration, écritures ignorées */
export const writeCompetency = async (session, write) => {
    // 0.10.0: on a mobile session lacking the skills tabs, the request is replayed on the web session before any call.
    ensureSkillsSpace(session);
    const picked = await pickPeriod(session, write.period);
    const all = await loadAllServices(session, picked.period);
    const entry = resolveService(write.service, all);
    const serviceid = serviceIdsOf(all)[all.indexOf(entry)];
    const service = competencyElement(entry);
    const resourcename = String(resourceOf(service)?.L ?? "");
    const type = entry.grade
        ? userData(session).resources.find((item) => item.label === resourcename)?.genre === 2 ? "group" : "class"
        : resourceType(session, resourcename, true);
    const resourceRef = resourceRefOf(service, type);
    const subject = String(service.matiere?.V?.L ?? service.L ?? "");
    const parentsDelay = parentsDelayOf(session);
    const parse = (evaluations) => parseEvaluations(evaluations, subject, resourcename, type, serviceid, parentsDelay);
    const readList = async () => {
        const listed = await listEvaluations(session, service, resourceRef, resourcename, picked.period);
        if (!listed)
            throw new HttpError(403, "access_denied");
        return listed;
    };
    const listed = await readList();
    const before = parse(listed.evaluations);
    let current = null;
    let page = null;
    let beforeItem = null;
    if (write.assessment) {
        current = before.find((parsed) => parsed.item.id === write.assessment) ?? null;
        if (!current)
            throw new HttpError(404, "assessment_not_found");
        page = await loadEvaluationPage(session, current.evaluation, resourceRef, picked.period);
        current.item.ratings = ratingsFromPage(page, current.skillIds);
        beforeItem = current.item;
        if (current.evaluation.avecSaisie === false && !write.delete) {
            throw new HttpError(409, `pronote_refused:${String(listed.list.strInfoCloture ?? "").trim() || "Cette évaluation n'est pas modifiable"}`);
        }
    }
    else {
        if (write.delete)
            throw new HttpError(400, "delete_without_id");
        if (!write.title || write.date === undefined)
            throw new HttpError(400, "title_and_date_required");
        // The client offers the creation only when the list allows the entry; Pronote says why it does not.
        const impossible = String(unwrap(listed.list.messageCreationImpossible) ?? "").trim();
        if (impossible)
            throw new HttpError(409, `pronote_refused:${impossible}`);
        if (listed.list.avecSaisie === false) {
            throw new HttpError(409, `pronote_refused:${String(listed.list.strInfoCloture ?? "").trim() || "La saisie des évaluations est fermée pour ce service"}`);
        }
    }
    const creating = current === null;
    const skillIds = current?.skillIds ?? new Map();
    const roster = resourceRef && (page === null || write.defaultLevel !== undefined)
        ? await rosterEntries(session, stableId(type, resourcename))
        : [];
    let students = studentsOf(page, roster);
    let referential = null;
    const wantedKeys = write.skills ?? [...skillIds.values()];
    const needsReferential = !write.delete && wantedKeys.some((key) => ![...skillIds.values()].includes(key) && !/^\d+#/.test(key));
    if (needsReferential)
        referential = await loadReferential(session, service, resourceRef, listed.list);
    const resolved = write.delete ? [] : resolveSkills(wantedKeys, current?.evaluation ?? null, skillIds, () => referential ?? []);
    if (creating && resolved.length === 0)
        throw new HttpError(400, "skills_required");
    const ratings = write.delete ? [] : expandRatings(write.ratings ?? [], write.defaultLevel, students, resolved.map((skill) => skill.key));
    // Levels and students are checked before anything is sent (and in a simulation): a refusal here writes nothing.
    for (const rating of ratings) {
        levelElement(session, rating.level);
        if (!students.some((student) => normalise(student.L) === normalise(rating.student))) {
            throw new HttpError(404, `student_not_found:${rating.student}`);
        }
        if (!resolved.some((skill) => skill.key === rating.skill || (skill.item && findReferentialItem(rating.skill, [skill.item])))
            && ![...skillIds.values()].includes(rating.skill)) {
            throw new HttpError(404, `skill_not_found:${rating.skill}`);
        }
    }
    if (write.defaultLevel !== undefined && !write.delete)
        levelElement(session, write.defaultLevel);
    const added = resolved.filter((skill) => !skill.existing);
    const structural = creating || added.length > 0;
    const dates = plannedDates(session, write, current?.evaluation ?? null);
    const firstRequest = creating
        ? buildCreationRequest(session, service, resourceRef, picked.period, write, resolved)
        : buildUpdateRequest(session, service, resourceRef, picked.period, current.evaluation, skillIds, students, write, resolved, structural ? [] : ratings, { page });
    const plannedTitle = (write.title ?? beforeItem?.title ?? "").trim();
    const plannedDate = dates.date ? seconds(dates.date) : beforeItem?.date ?? null;
    const plannedPublication = dates.publication ? seconds(dates.publication) : beforeItem?.publication ?? null;
    const plannedSkills = resolved.map((skill) => {
        const kept = beforeItem?.skills.find((s) => s.id === skill.key || (skill.existing && s.name === String(skill.existing?.L ?? "").trim()));
        if (kept)
            return kept;
        const item = skill.item;
        return {
            id: skill.key,
            name: item?.name ?? skill.key,
            domain: item?.domain ?? "",
            domainCode: item?.domainCode ?? "",
            number: item?.number ?? "",
            code: item?.code ?? "",
            cycle: item?.cycle ?? "",
        };
    });
    const plannedId = beforeItem?.id ?? stableId("competency", evaluationKey({ N: "", L: plannedTitle, dateValidation: dates.date ? { V: pronoteDate(dates.date).V } : undefined }, resourcename));
    const planned = write.delete
        ? null
        : {
            id: plannedId,
            title: plannedTitle,
            date: plannedDate,
            publication: plannedPublication,
            publicationParents: plannedPublication !== null && parentsDelay !== null
                ? plannedPublication + Math.round(parentsDelay * 86400)
                : beforeItem?.publicationParents ?? null,
            coefficient: write.coefficient ?? beforeItem?.coefficient ?? (creating ? 1 : null),
            cycleReport: write.cycleReport ?? beforeItem?.cycleReport ?? true,
            subject,
            resourcename,
            type,
            serviceid,
            skills: plannedSkills,
            ratings: mergeRatings(beforeItem?.ratings ?? [], ratings),
        };
    const common = { validated: false, parentsDelayDays: parentsDelay, created: false, publicationDefault: dates.publicationDefault,
        ratingsSent: ratings.length, ratingsSaved: 0, warnings: [] };
    if (write.dryRun) {
        return { before: beforeItem, after: planned, request: firstRequest, requests: [firstRequest], written: false, dryRun: true, ...common };
    }
    const requests = [firstRequest];
    const notSaved = (code, sent, after = null) => {
        // Shape of Pronote's answer (member names only) in the access log: the only trace of a save that created nothing.
        const context = currentContext();
        const shape = `save:${memberNames(sent.data)};report:${memberNames(sent.report)}`;
        if (context)
            context.shape = shape;
        return new HttpError(502, code, { after, detail: shape });
    };
    const sent = await sendWrite(session, "competencySave", firstRequest, write.force === true);
    if (write.delete) {
        const still = parse((await readList()).evaluations).find((parsed) => parsed.evaluation.N === current.evaluation.N || parsed.item.id === beforeItem.id);
        if (still)
            throw notSaved("assessment_not_deleted", sent, still.item);
        return { before: beforeItem, after: null, request: firstRequest, requests, written: true, dryRun: false, ...common };
    }
    // The assessment as Pronote now lists it: by the identifier of the save answer, else the same identifier as before,
    // else (creation) the only new assessment with the planned title and day.
    const known = new Set(before.map((parsed) => String(parsed.evaluation.N)));
    const created = creating ? createdNumber(sent) : null;
    const find = (parsedList) => {
        if (!creating) {
            return parsedList.find((parsed) => parsed.evaluation.N === current.evaluation.N) ?? parsedList.find((parsed) => parsed.item.id === beforeItem.id) ?? null;
        }
        const sameDay = (parsed) => parsed.item.date !== null && plannedDate !== null && wallDay(parsed.item.date).getTime() === wallDay(plannedDate).getTime();
        const sameTitle = (parsed) => labelKey(parsed.item.title) === labelKey(plannedTitle);
        return (created ? parsedList.find((parsed) => parsed.evaluation.N === created) : undefined)
            ?? parsedList.find((parsed) => !known.has(String(parsed.evaluation.N)) && sameTitle(parsed) && sameDay(parsed))
            ?? parsedList.find((parsed) => !known.has(String(parsed.evaluation.N)) && sameTitle(parsed))
            ?? null;
    };
    let found = find(parse((await readList()).evaluations));
    if (!found)
        throw notSaved("assessment_not_saved", sent);
    let afterPage = await loadEvaluationPage(session, found.evaluation, resourceRef, picked.period);
    if (structural && ratings.length) {
        // Levels of an assessment that now exists, with the students and the relations Pronote gave it.
        students = studentsOf(afterPage, roster);
        const levels = buildUpdateRequest(session, service, resourceRef, picked.period, found.evaluation, found.skillIds, students, write, resolved, ratings, { withStructure: false, page: afterPage });
        requests.push(levels);
        await sendWrite(session, "competencySave", levels, write.force === true);
        found = find(parse((await readList()).evaluations)) ?? found;
        afterPage = await loadEvaluationPage(session, found.evaluation, resourceRef, picked.period);
    }
    found.item.ratings = ratingsFromPage(afterPage, found.skillIds);
    // Levels really stored: a rating designates its skill by a stable id or by the key given in "skills".
    const final = found;
    const skillIdOf = (key) => {
        try {
            const skill = skillOfRating(key, final.evaluation, final.skillIds, resolved);
            return final.skillIds.get(String(skill?.relationESI?.V?.N ?? skill?.N ?? "")) ?? key;
        }
        catch {
            return key;
        }
    };
    const saved = countSaved(ratings, final.item.ratings, skillIdOf);
    const warnings = [];
    if (ratings.length > 0 && saved === 0) {
        // Nothing of an existing assessment changed: a plain failure. A created assessment stays: said, not hidden.
        if (!structural)
            throw notSaved("ratings_not_saved", sent, final.item);
        warnings.push("ratings_not_saved");
    }
    else if (saved < ratings.length) {
        warnings.push(`ratings_partly_saved:${saved}/${ratings.length}`);
    }
    return { before: beforeItem, after: final.item, request: firstRequest, requests, written: true, dryRun: false, ...common,
        created: creating, ratingsSaved: saved, warnings };
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