import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { GRADE_STATUS, gradeValue, listOf, parsePronoteDate, pronoteDate, pronoteNumber } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { matchesLabels, seconds, } from "../normalise.js";
import { requireFunction } from "./functions.js";
import { resolve, stableId, stableIds } from "./ids.js";
const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const TYPE_NUMBER = 10;
/** Genre of a teacher resource. */
const GENRE_TEACHER = 3;
export const ref = (item) => ({ N: item.N, ...(item.G !== undefined ? { G: item.G } : {}), ...(item.L ? { L: item.L } : {}) });
const number = (value) => ({ _T: TYPE_NUMBER, V: pronoteNumber(value) });
export const call = async (session, key, data) => {
    const fn = requireFunction(key);
    const answer = await callPronote(session, {
        name: fn.name,
        data,
        signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
    });
    return answerData(session, answer);
};
const pad = (value) => String(value).padStart(2, "0");
/** "dd/mm/yyyy" as Pronote displays assessment dates. */
const dayOf = (date) => `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
const normaliseDay = (value) => {
    const match = String(value ?? "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return match ? `${pad(Number(match[1]))}/${pad(Number(match[2]))}/${match[3]}` : "";
};
export const periodKey = (period) => String(period.L ?? "");
export const resourceOf = (service) => service.classe?.V ?? service.groupe?.V;
export const serviceKey = (service) => `${service.matiere?.V?.L ?? service.L ?? ""}|${resourceOf(service)?.L ?? ""}`;
const studentKey = (student) => String(student.L ?? "");
const assessmentKey = (assessment) => `${normaliseDay(assessment.date?.V)}|${assessment.commentaire ?? ""}`;
export const assessmentIdFor = (date, title) => stableId("assessment", `${dayOf(date)}|${title.trim()}`);
export const loadPeriods = async (session) => {
    const data = await call(session, "periodsList");
    const periods = listOf(data.listePeriodes);
    const byDefault = data.periodeParDefaut?.V;
    const current = periods.find((p) => p.N === byDefault?.N) ?? periods.find((p) => p.L === byDefault?.L) ?? null;
    return { periods, current };
};
export const loadServices = async (session, period) => {
    const me = session.user.resources[0];
    const data = await call(session, "servicesList", {
        Professeur: { N: me.id, G: GENRE_TEACHER, L: me.name },
        ...(period ? { Periode: ref(period) } : {}),
    });
    return listOf(data.services);
};
const resourceType = (session, label) => {
    const found = userData(session).resources.find((item) => item.label === label);
    return found?.genre === 2 ? "group" : "class";
};
/**
 * Services of every period, each with the periods it is graded in. ListeServices only returns the
 * services of the requested period: a group graded by semester is missing from the trimesters.
 */
export const servicesByPeriod = (periodServices) => {
    const byKey = new Map();
    for (const { periodId, services } of periodServices) {
        for (const service of services) {
            const key = serviceKey(service);
            const entry = byKey.get(key);
            if (entry) {
                if (!entry.periods.includes(periodId))
                    entry.periods.push(periodId);
            }
            else {
                byKey.set(key, { service, periods: [periodId] });
            }
        }
    }
    return [...byKey.values()];
};
export const context = async (session) => {
    const { periods, current } = await loadPeriods(session);
    const periodIds = stableIds("period", periods, periodKey);
    // Current period first, so that its services keep their order at the top of the list.
    const ordered = periods.map((period, index) => ({ period, periodId: periodIds[index] }))
        .sort((a, b) => Number(b.period === current) - Number(a.period === current));
    const periodServices = [];
    for (const { period, periodId } of ordered) {
        periodServices.push({ periodId, services: await loadServices(session, period) });
    }
    if (periods.length === 0)
        periodServices.push({ periodId: "", services: await loadServices(session, null) });
    const entries = servicesByPeriod(periodServices);
    const services = entries.map((entry) => entry.service);
    const serviceIds = stableIds("service", services, serviceKey);
    return {
        periods: periods.map((period, index) => ({
            id: periodIds[index],
            name: String(period.L ?? ""),
            current: period === current,
        })),
        services: services.map((service, index) => {
            const subject = String(service.matiere?.V?.L ?? service.L ?? "");
            const resourcename = String(resourceOf(service)?.L ?? "");
            const type = resourceType(session, resourcename);
            return {
                id: serviceIds[index],
                name: [subject, resourcename].filter(Boolean).join(" - "),
                subject,
                resourceid: stableId(type, resourcename),
                resourcename,
                type,
                periods: periodIds.filter((id) => entries[index].periods.includes(id)),
            };
        }),
        maxScale: userData(session).maxScale,
    };
};
/** Checks the grades against the assessment, without calling Pronote. */
export const validate = (assessment, grades, maxScale = null) => {
    if (maxScale !== null && assessment.max > maxScale)
        throw new HttpError(400, "scale_too_large");
    const rejected = [];
    const seen = new Set();
    for (const grade of grades) {
        if (seen.has(grade.studentid))
            rejected.push({ studentid: grade.studentid, reason: "duplicate" });
        seen.add(grade.studentid);
        if (grade.status === "" && grade.value !== null && (grade.value < 0 || grade.value > assessment.max)) {
            rejected.push({ studentid: grade.studentid, reason: "out_of_scale" });
        }
    }
    return rejected;
};
/** Service member of SaisieNotes: the service reference plus its settings for the period, as read. */
const serviceMember = (service, page) => {
    const full = page.service?.V ?? {};
    const settings = listOf(full.listePeriodes)[0] ?? {};
    const member = { ...ref(service) };
    if (full.estUnService === false) {
        if (settings.coefficient !== undefined)
            member.coefficient = settings.coefficient;
    }
    else if (full.coefficientGeneral !== undefined) {
        member.coefficientGeneral = full.coefficientGeneral;
    }
    member.facultatif = Boolean(full.facultatif);
    for (const key of [
        "moyenneParSousMatiere",
        "moyenneBulletinSurClasse",
        "avecDevoirSupMoy",
        "avecBonusMalus",
        "ponderationNotePlusHaute",
        "ponderationNotePlusBasse",
        "arrondiEleve",
        "arrondiClasse",
    ]) {
        if (settings[key] !== undefined)
            member[key] = settings[key];
    }
    return member;
};
const classesMember = (period, page, existing) => {
    if (existing) {
        return listOf(existing.listeClasses).map((classe) => {
            const periods = listOf(classe.listePeriodes);
            return {
                ...ref(classe),
                service: classe.service?.V ? ref(classe.service.V) : undefined,
                ...(periods[0] ? { periodePrincipale: ref(periods[0]) } : {}),
                ...(periods[1] ? { periodeSecondaire: ref(periods[1]) } : {}),
            };
        });
    }
    return listOf(page.listeClasses).map((classe) => ({
        ...ref(classe),
        service: classe.service?.V ? ref(classe.service.V) : undefined,
        periodePrincipale: ref(period),
    }));
};
const assessmentMember = (period, page, assessment, existing, notes) => {
    const date = new Date(assessment.date * 1000);
    const publication = new Date((assessment.publication ?? assessment.date) * 1000);
    return {
        N: existing ? existing.N : -1,
        E: existing ? STATE_MODIFIED : STATE_CREATED,
        date: pronoteDate(date),
        coefficient: number(assessment.coefficient),
        verrouille: false,
        commeUnBonus: assessment.bonus,
        commeUneNote: assessment.optional && !assessment.bonus,
        commentaire: assessment.title.trim(),
        bareme: number(assessment.max),
        recalculerNotesDevoirSelonBareme: false,
        ramenerSur20: assessment.scaleTo20,
        datePublication: pronoteDate(publication),
        avecCommentaireSurNoteEleve: Boolean(existing?.avecCommentaireSurNoteEleve),
        ListeThemes: listOf(existing?.ListeThemes).map(ref),
        listeClasses: classesMember(period, page, existing),
        listeEleves: notes.map((item) => ({ N: item.N, E: STATE_MODIFIED, note: { _T: TYPE_NUMBER, V: item.note } })),
    };
};
/** Same grade? Pronote may write "12,50" for "12,5". */
const sameNote = (stored, sent) => {
    const a = String(stored ?? "");
    if (a === sent)
        return true;
    if (a.startsWith("|") || sent.startsWith("|") || a === "" || sent === "")
        return false;
    return Number.parseFloat(a.replace(",", ".")) === Number.parseFloat(sent.replace(",", "."));
};
export const push = async (session, serviceId, periodId, assessment, grades, dryRun) => {
    const rejected = validate(assessment, grades, userData(session).maxScale);
    const { periods } = await loadPeriods(session);
    const period = resolve("period", periodId, periods, periodKey);
    const periodServices = await loadServices(session, period);
    if (!stableIds("service", periodServices, serviceKey).includes(serviceId)) {
        const anyPeriod = await loadServices(session, null);
        if (stableIds("service", anyPeriod, serviceKey).includes(serviceId)) {
            throw new HttpError(409, "service_not_in_period");
        }
    }
    const service = resolve("service", serviceId, periodServices, serviceKey);
    const pageRequest = { service: ref(service), periode: ref(period) };
    const page = await call(session, "gradesPage", pageRequest);
    const students = listOf(page.listeEleves);
    const studentIds = stableIds("student", students, studentKey);
    const byId = new Map(studentIds.map((id, index) => [id, students[index]]));
    const invalid = new Set(rejected.map((item) => item.studentid));
    const notes = [];
    for (const grade of grades) {
        if (invalid.has(grade.studentid))
            continue;
        const student = byId.get(grade.studentid);
        if (!student) {
            rejected.push({ studentid: grade.studentid, reason: "unknown_student" });
            continue;
        }
        notes.push({ studentid: grade.studentid, N: student.N, note: gradeValue(grade.value, grade.status) });
    }
    // The previous push (stable id) first, then an assessment with the same date and title, so that a
    // lost Moodle record does not create a duplicate.
    const assessments = listOf(page.listeDevoirs);
    const assessmentIds = stableIds("assessment", assessments, assessmentKey);
    const newId = assessmentIdFor(new Date(assessment.date * 1000), assessment.title);
    const find = (id) => (id === null ? -1 : assessmentIds.indexOf(id));
    const index = find(assessment.id) >= 0 ? find(assessment.id) : find(newId);
    const existing = index >= 0 ? assessments[index] : null;
    if (existing?.verrouille)
        throw new HttpError(409, "assessment_locked");
    if (dryRun || notes.length === 0) {
        return { assessmentid: existing ? assessmentIds[index] : assessment.id, written: 0, rejected, dryRun };
    }
    await call(session, "gradesSave", {
        periode: ref(period),
        service: serviceMember(service, page),
        listeDevoirs: [assessmentMember(period, page, assessment, existing, notes)],
    });
    // Read back: the assessment under its new date/title, and the grades really stored.
    const after = await call(session, "gradesPage", pageRequest);
    const saved = listOf(after.listeDevoirs);
    const savedIndex = stableIds("assessment", saved, assessmentKey).indexOf(newId);
    if (savedIndex < 0)
        throw new HttpError(502, "assessment_not_saved");
    const stored = new Map(listOf(saved[savedIndex].listeEleves).map((item) => [item.N, item.Note?.V]));
    const storedByLabel = new Map(listOf(saved[savedIndex].listeEleves).map((item) => [item.L, item.Note?.V]));
    let written = 0;
    for (const item of notes) {
        const label = byId.get(item.studentid)?.L;
        const value = stored.has(item.N) ? stored.get(item.N) : storedByLabel.get(label);
        if (sameNote(value, item.note))
            written++;
        else
            rejected.push({ studentid: item.studentid, reason: "not_saved" });
    }
    return { assessmentid: newId, written, rejected, dryRun: false };
};
/* ---- Lot 2 (0.7.0): overview of a period (every assessment and grade of the teacher's services) ---- */
/** Status of a grade cell ("|1" → "abs"), "" for a value or an empty cell. */
export const statusOf = (raw) => {
    if (!raw.startsWith("|"))
        return "";
    const code = Number(raw.slice(1));
    const found = Object.entries(GRADE_STATUS).find(([, value]) => value === code);
    return found ? found[0] : "";
};
/** Value of a grade cell ("12,5" → 12.5), null for a status or an empty cell. */
export const valueOf = (raw) => {
    if (raw === "" || raw.startsWith("|"))
        return null;
    const parsed = Number.parseFloat(raw.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
};
const cell = (value) => {
    const raw = value !== null && typeof value === "object" && "V" in value ? value.V : value;
    return typeof raw === "string" ? raw.trim() : raw === undefined || raw === null ? "" : String(raw);
};
const numberOf = (value) => valueOf(cell(value));
/** Period of the grade entry: the one asked (stable id), else the current one, else the first. */
export const pickPeriod = async (session, periodId) => {
    const { periods, current } = await loadPeriods(session);
    const ids = stableIds("period", periods, periodKey);
    const period = periodId ? resolve("period", periodId, periods, periodKey) : (current ?? periods[0] ?? null);
    if (!period)
        throw new HttpError(404, "period_not_found");
    return {
        period,
        periodId: ids[periods.indexOf(period)],
        periods: periods.map((item, index) => ({ id: ids[index], name: String(item.L ?? ""), current: item === current })),
    };
};
/** Assessments of a PageNotes answer ("data" member), with the grades of every student. */
export const assessmentsFromPage = (page) => {
    const subservices = new Map(listOf(page.service?.V?.listeServices).map((item) => [item.N, String(item.L ?? "")]));
    const result = [];
    for (const devoir of listOf(page.listeDevoirs)) {
        const date = parsePronoteDate(devoir.date?.V);
        if (!date)
            continue;
        const publication = parsePronoteDate(devoir.datePublication?.V);
        const title = String(devoir.commentaire ?? "").trim();
        result.push({
            id: assessmentIdFor(date, title),
            title,
            date: seconds(date),
            publication: publication ? seconds(publication) : null,
            max: numberOf(devoir.bareme),
            coefficient: numberOf(devoir.coefficient),
            optional: devoir.commeUneNote === true,
            bonus: devoir.commeUnBonus === true,
            locked: devoir.verrouille === true,
            hasGrades: devoir.existesDesNotes === true,
            classAverage: numberOf(devoir.moyenneClasse ?? devoir.moyenne),
            subservice: subservices.get(String(devoir.service?.V?.N ?? "")) ?? "",
            grades: listOf(devoir.listeEleves).map((student) => {
                const raw = cell(student.Note ?? student.note);
                return {
                    student: String(student.L ?? "").trim(),
                    value: valueOf(raw),
                    status: statusOf(raw),
                    comment: cell(student.commentaire),
                };
            }),
        });
    }
    return result.sort((a, b) => a.date - b.date || a.title.localeCompare(b.title));
};
/** Services, assessments and grades of a period for the teacher's classes (one PageNotes per service). */
export const overview = async (session, periodId = "", classes = []) => {
    const picked = await pickPeriod(session, periodId);
    const all = await loadServices(session, picked.period);
    const serviceIds = stableIds("service", all, serviceKey);
    const services = [];
    for (const [index, service] of all.entries()) {
        const resourcename = String(resourceOf(service)?.L ?? "");
        if (!matchesLabels([resourcename], classes))
            continue;
        const page = await call(session, "gradesPage", { service: ref(service), periode: ref(picked.period) });
        const subject = String(service.matiere?.V?.L ?? service.L ?? "");
        const type = resourceType(session, resourcename);
        services.push({
            id: serviceIds[index],
            name: [subject, resourcename].filter(Boolean).join(" - "),
            subject,
            resourceid: stableId(type, resourcename),
            resourcename,
            type,
            periods: [picked.periodId],
            assessments: assessmentsFromPage(page),
        });
    }
    return { periods: picked.periods, period: { id: picked.periodId, name: String(picked.period.L ?? "") }, services };
};
//# sourceMappingURL=grades.js.map