/**
 * Report cards ("bulletins") of a class, read in the teacher space (read only).
 *
 * PageBulletins (tab 13) answers for one student, one class and one period. The request and its
 * answer are decoded by the same client modules in the teacher and student spaces
 * (objetrequetepagebulletins.js, utilitairedeserialiserpiedbulletin.js, identical in PRONOTE 2026.2.8),
 * so the answer has the shape Pawnote decodes for students: ListeServices, ObjetListeAppreciations,
 * General and ListeAbsences. Only a teacher whose profile opens the tab can read them, usually the
 * main teacher ("professeur principal") of the class: the others get "Vos droits sont insuffisants".
 *
 * 0.12.0 (docs/pronoteio/vue-pp.md in mood_prod): pages of students with partial answers, the transcript of a student
 * (PageReleve, tab 12: same shape, with the assessments of each subject) and the results of the class
 * (ResultatsClasses, tab 64: answer shape unknown, read tolerantly). NOT VALIDATED on a real server.
 */
import { ServerSideError } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf } from "../pronote/encoding.js";
import { tabClosed, userData } from "../pronote/userdata.js";
import { splitDisplayName } from "../normalise.js";
import { callFunction, functions, requireFunction } from "./functions.js";
import { loadPeriods, periodKey } from "./grades.js";
import { kindOf, resolve, stableId, stableIds } from "./ids.js";
import { rosterEntries } from "./roster.js";
import { shapeOf } from "./students.js";
import { dateOf, dayString, deniedWhere, isPlain, member, pageOf, readEach, textOf, unwrap } from "./tolerant.js";
/** Genres of Pronote entities. */
const GENRE_CLASS = 1;
const GENRE_STUDENT = 4;
/** Annotations written instead of a value ("|n"), as in the grade entry. */
const ANNOTATIONS = {
    "1": "Abs",
    "2": "Disp",
    "3": "N.Not",
    "4": "Inap",
    "5": "N.Rdu",
    "6": "Abs0",
    "7": "N.Rdu0",
};
const valueOf = (value) => value !== null && typeof value === "object" && "V" in value ? value.V : value;
/** Number of a Pronote cell ("12,50", { _T: 10, V: "12,5" }), null for an annotation or nothing. */
export const reportNumber = (value) => {
    const raw = valueOf(value);
    if (typeof raw === "number")
        return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== "string")
        return null;
    const text = raw.trim().replace(/\s/g, "").replace(",", ".");
    if (text === "" || text.startsWith("|"))
        return null;
    const number = Number.parseFloat(text);
    return Number.isFinite(number) ? number : null;
};
/** Annotation of a Pronote cell ("|1" -> "Abs"), "" when the cell holds a value or nothing. */
export const reportStatus = (value) => {
    const raw = valueOf(value);
    if (typeof raw !== "string" || !raw.startsWith("|"))
        return "";
    return ANNOTATIONS[raw.slice(1)] ?? raw.slice(1);
};
const text = (value) => {
    const raw = valueOf(value);
    return typeof raw === "string" ? raw.trim() : "";
};
const commentKind = (genre) => {
    if (genre === 0)
        return "general";
    if (genre === 1 || genre === 2 || genre === 3 || genre === 8)
        return "council";
    if (genre === 4 || genre === 5 || genre === 6)
        return "comment";
    if (genre === 7)
        return "cpe";
    return "other";
};
const teachersOf = (item) => listOf(member(item, ["ListeProfesseurs", "listeProfesseurs", "professeurs"]))
    .map((teacher) => String(teacher?.L ?? "").trim())
    .filter(Boolean);
const averagesOf = (item) => ({
    coefficient: reportNumber(member(item, ["Coefficient"])),
    average: reportNumber(member(item, ["MoyenneEleve"])),
    classAverage: reportNumber(member(item, ["MoyenneClasse"])),
    min: reportNumber(member(item, ["MoyenneInf", "MoyenneMin"])),
    max: reportNumber(member(item, ["MoyenneSup", "MoyenneMax"])),
    status: reportStatus(member(item, ["MoyenneEleve"])),
});
const subjectLabel = (item) => String(valueOf(member(item, ["Matiere"]))?.L ?? item?.L ?? "").trim();
/** Assessments of a transcript subject (PageReleve; member names are candidates, never captured). */
const assessmentsOf = (service) => listOf(member(service, ["ListeDevoirs", "listeDevoirs", "devoirs"])).map((item) => {
    const grade = member(item, ["Note", "note"]);
    return {
        date: dayString(dateOf(member(item, ["Date", "date", "DateDevoir"]))),
        title: textOf(member(item, ["Commentaire", "commentaire", "Libelle", "L"])),
        grade: reportNumber(grade),
        status: reportStatus(grade),
        scale: reportNumber(member(item, ["Bareme", "bareme"])),
        coefficient: reportNumber(member(item, ["Coefficient", "coefficient"])),
        classAverage: reportNumber(member(item, ["Moyenne", "moyenne", "MoyenneClasse"])),
    };
});
const subjectOf = (service) => {
    const elements = listOf(member(service, ["ListeElements", "listeElements"]));
    const fromElements = elements.flatMap(teachersOf);
    const teachers = fromElements.length ? fromElements : teachersOf(service);
    // A service always carries one element (itself, with its teachers): sub-services only when there are several.
    const subservices = elements.length > 1
        ? elements.map((element) => ({ subject: subjectLabel(element), teachers: [...new Set(teachersOf(element))], ...averagesOf(element) }))
            .filter((item) => item.subject !== "")
        : [];
    return {
        subject: subjectLabel(service),
        teachers: [...new Set(teachers)],
        ...averagesOf(service),
        comments: listOf(member(service, ["ListeAppreciations", "listeAppreciations"])).map((item) => String(item?.L ?? "").trim()).filter(Boolean),
        rank: reportNumber(member(service, ["Rang", "RangEleve", "rang"])),
        group: textOf(member(service, ["groupe", "strGroupe", "libelleGroupe", "nomGroupe"])),
        subservices,
        assessments: assessmentsOf(service),
    };
};
/** Report card of a PageBulletins answer, or transcript of a PageReleve answer (same shape; "data" member). */
export const reportFromAnswer = (data, student, period) => {
    const name = splitDisplayName(student.label);
    const general = valueOf(member(data, ["General"]));
    const appreciations = valueOf(member(data, ["ObjetListeAppreciations"]));
    const footer = (valueOf(member(data, ["ListeAbsences"])) ?? {});
    const subjects = listOf(member(data, ["ListeServices", "listeServices"])).map(subjectOf).filter((item) => item.subject !== "");
    const message = text(member(data, ["Message"]));
    return {
        studentid: student.id,
        lastname: name.lastname,
        firstname: name.firstname,
        period,
        state: subjects.length > 0 ? "published" : message !== "" ? "unpublished" : "empty",
        average: reportNumber(member(general, ["MoyenneEleve"])),
        classAverage: reportNumber(member(general, ["MoyenneClasse"])),
        rank: reportNumber(member(general, ["RangEleve", "Rang", "rang"])),
        classSize: reportNumber(member(general, ["NbrEleves", "NombreEleves", "Effectif", "nbEleves"])),
        subjects,
        comments: listOf(member(appreciations, ["ListeAppreciations", "listeAppreciations"]))
            .map((item) => ({ kind: commentKind(item?.G), title: String(item?.Intitule ?? "").trim(), text: String(item?.L ?? "").trim() }))
            .filter((item) => item.text !== ""),
        attendance: {
            absences: text(footer.strAbsences),
            lates: text(footer.strRetards),
            punishments: text(footer.strPunitions),
            sanctions: text(footer.strSanctions),
        },
        publication: text(member(data, ["strInfoDatePublication"])),
        message,
    };
};
const reportTab = () => requireFunction("reportCard").onglet;
/** Classes (main teacher first) and periods for which report cards may be read. */
export const reportContext = async (session) => {
    const { tabs, resources } = userData(session);
    const tab = reportTab();
    // 0.10.0: tab missing from the mobile session: the web session decides (space.ts), not the mobile list.
    const closed = tabs === null || tab === null ? null : tabClosed(session, tab, requireFunction("reportCard").name);
    const { periods, current } = await loadPeriods(session);
    const periodIds = stableIds("period", periods, periodKey);
    return {
        allowed: closed === null ? null : !closed,
        classes: resources
            .filter((item) => item.genre === GENRE_CLASS)
            .map((item) => ({ id: stableId("class", item.label), name: item.label, principal: item.principal, taught: item.taught }))
            .sort((a, b) => Number(b.principal) - Number(a.principal) || a.name.localeCompare(b.name, "fr", { numeric: true })),
        periods: periods.map((period, index) => ({ id: periodIds[index], name: String(period.L ?? ""), current: period === current })),
    };
};
const isAccessDenied = (error) => error instanceof ServerSideError && /droits/i.test(error.message);
export const reports = async (session, resourceId, periodId) => {
    const fn = requireFunction("reportCard");
    const { resources } = userData(session);
    // 0.10.0: a tab missing from the mobile session asks for the web session (space.ts) before concluding to a refusal.
    if (tabClosed(session, fn.onglet, fn.name))
        throw new HttpError(403, "access_denied");
    if (kindOf(resourceId) !== "class")
        throw new HttpError(409, "resource_not_class");
    const classe = resolve("class", resourceId, resources.filter((item) => item.genre === GENRE_CLASS), (item) => item.label);
    const { periods } = await loadPeriods(session);
    const period = resolve("period", periodId, periods, periodKey);
    const students = await rosterEntries(session, resourceId);
    const result = [];
    for (const student of students) {
        let answer;
        try {
            answer = await callPronote(session, {
                name: fn.name,
                data: {
                    eleve: { N: student.pronoteId, G: GENRE_STUDENT, L: student.label },
                    classe: { N: classe.id, G: GENRE_CLASS, L: classe.label },
                    periode: { N: period.N, G: period.G, L: period.L },
                },
                signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
            });
        }
        catch (error) {
            if (isAccessDenied(error))
                throw new HttpError(403, "access_denied");
            throw error;
        }
        result.push(reportFromAnswer(answerData(session, answer), student, String(period.L ?? "")));
    }
    return result;
};
/* ---- 0.12.0: pages of report cards or transcripts, results of the class ---- */
/** Largest number of report cards read in one page (one Pronote call per student). */
export const MAX_REPORTS = 40;
export const REPORT_SOURCES = ["reportcard", "transcript"];
const SOURCE_FUNCTION = { reportcard: "reportCard", transcript: "transcript" };
/**
 * Page of report cards (or transcripts) of a class: one student, or [offset, offset + limit) of the roster. A refusal
 * of Pronote is answered available: false with the tab and the space, never bypassed. When the queue towards Pronote
 * is full, the students read so far are returned with "remaining" and "retry_after" (tolerant.ts readEach).
 */
export const reportsPage = async (session, resourceId, periodId, page = {}, source = "reportcard") => {
    const fn = requireFunction(SOURCE_FUNCTION[source]);
    if (kindOf(resourceId) !== "class")
        throw new HttpError(409, "resource_not_class");
    const { resources } = userData(session);
    const classe = resolve("class", resourceId, resources.filter((item) => item.genre === GENRE_CLASS), (item) => item.label);
    const { periods } = await loadPeriods(session);
    const period = resolve("period", periodId, periods, periodKey);
    const { selected, offset, total } = pageOf(await rosterEntries(session, resourceId), page, MAX_REPORTS, 10);
    const base = { validated: false, source, total, offset };
    let denied = false;
    const read = await readEach(selected, async (student) => {
        if (denied)
            return null;
        try {
            const answer = await callPronote(session, {
                name: fn.name,
                data: {
                    eleve: { N: student.pronoteId, G: GENRE_STUDENT, L: student.label },
                    classe: { N: classe.id, G: GENRE_CLASS, L: classe.label },
                    periode: { N: period.N, G: period.G, L: period.L },
                },
                signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
            });
            return reportFromAnswer(answerData(session, answer), student, String(period.L ?? ""));
        }
        catch (error) {
            if (!isAccessDenied(error))
                throw error;
            denied = true;
            return null;
        }
    });
    if (denied) {
        return { ...base, available: false, reason: "access_denied", ...deniedWhere(session, fn.onglet), items: [], read: [],
            remaining: [], partial: false, retry_after: 0 };
    }
    return { ...base, available: true, reason: "", ...read, items: read.items.filter((item) => item !== null) };
};
const COLUMN_LISTS = ["listeColonnes", "ListeServices", "listeServices", "services", "listeMatieres", "colonnes"];
const LINE_LISTS = ["listeLignes", "ListeEleves", "listeEleves", "eleves", "lignes"];
const CELL_LISTS = ["listeMoyennes", "moyennes", "listeNotes", "listeCellules", "cellules", "listeColonnes", "ListeServices", "listeValeurs"];
const cellValue = (cell) => {
    const raw = unwrap(cell);
    if (!isPlain(raw))
        return raw;
    return member(raw, ["moyenne", "MoyenneEleve", "note", "valeur"]);
};
/**
 * Results of a class from a ResultatsClasses answer ("data" member), null when the shape is not understood. The answer
 * was never captured: a table is looked for, with a list of columns (subjects, their teachers and class averages) and
 * a list of lines (one per student: general average, rank, one cell per column, in the order of the columns or named
 * by their subject).
 */
export const resultsFromAnswer = (data, students) => {
    const columns = listOf(member(data, COLUMN_LISTS));
    const lines = listOf(member(data, LINE_LISTS)).filter((line) => isPlain(line));
    if (columns.length === 0 || lines.length === 0)
        return null;
    const subjects = columns.map((column) => ({
        subject: subjectLabel(column) || textOf(member(column, ["matiere", "service"])),
        teachers: [...new Set(teachersOf(column))],
        classAverage: reportNumber(member(column, ["MoyenneClasse", "moyenne"])),
        min: reportNumber(member(column, ["MoyenneInf", "MoyenneMin", "min"])),
        max: reportNumber(member(column, ["MoyenneSup", "MoyenneMax", "max"])),
    }));
    if (subjects.every((item) => item.subject === ""))
        return null;
    const byPronoteId = new Map(students.map((entry) => [entry.pronoteId, entry]));
    const byLabel = new Map();
    for (const entry of students)
        byLabel.set(entry.label, byLabel.has(entry.label) ? null : entry);
    const rows = [];
    for (const line of lines) {
        const owner = (unwrap(member(line, ["eleve"])) ?? line);
        const label = String(owner?.L ?? "").trim();
        if (label === "")
            continue;
        const entry = byPronoteId.get(String(owner?.N ?? "")) ?? byLabel.get(label) ?? null;
        const cells = listOf(member(line, CELL_LISTS));
        const averages = subjects.map((subject, index) => {
            const named = cells.find((cell) => isPlain(unwrap(cell)) && (subjectLabel(unwrap(cell)) || textOf(member(unwrap(cell), ["matiere", "service"]))) === subject.subject);
            const value = cellValue(named ?? cells[index]);
            return { subject: subject.subject, value: reportNumber(value), status: reportStatus(value) };
        });
        rows.push({
            studentid: entry?.id ?? stableId("student", label),
            label,
            average: reportNumber(member(line, ["moyenneGenerale", "MoyenneEleve", "moyenne"])),
            rank: reportNumber(member(line, ["rang", "RangEleve"])),
            averages,
        });
    }
    if (rows.length === 0)
        return null;
    return { subjects: subjects.filter((item) => item.subject !== ""), students: rows.map((row) => ({ ...row, averages: row.averages.filter((cell) => cell.subject !== "") })) };
};
/** Results of a class for a period, every subject (ResultatsClasses, tab 64). NOT VALIDATED: answer shape unknown. */
export const classResults = async (session, resourceId, periodId) => {
    if (kindOf(resourceId) !== "class")
        throw new HttpError(409, "resource_not_class");
    const { resources } = userData(session);
    const classe = resolve("class", resourceId, resources.filter((item) => item.genre === GENRE_CLASS), (item) => item.label);
    const { periods } = await loadPeriods(session);
    const period = resolve("period", periodId, periods, periodKey);
    const periodIds = stableIds("period", periods, periodKey);
    const base = { available: false, reason: "", validated: false, class: { id: resourceId, name: classe.label },
        period: { id: periodIds[periods.indexOf(period)], name: String(period.L ?? "") }, subjects: [], students: [] };
    let data;
    try {
        data = await callFunction(session, "classResults", {
            classe: { N: classe.id, G: GENRE_CLASS, L: classe.label },
            periode: { N: period.N, G: period.G, L: period.L },
            absences: false,
            competences: false,
            afficherSousServices: false,
            afficherSeulementSousServices: false,
            masquerSansNotes: false,
            avecCouleurMoyenne: false,
        });
    }
    catch (error) {
        if (isAccessDenied(error))
            return { ...base, reason: "access_denied", ...deniedWhere(session, functions.classResults.onglet) };
        throw error;
    }
    if (!data || Object.keys(data).length === 0)
        return { ...base, reason: "access_denied", ...deniedWhere(session, functions.classResults.onglet) };
    const read = resultsFromAnswer(data, await rosterEntries(session, resourceId));
    if (read === null)
        return { ...base, reason: "format_unknown", shape: shapeOf(data) };
    return { ...base, available: true, ...read };
};
//# sourceMappingURL=reports.js.map