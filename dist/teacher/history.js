import { listOf } from "../pronote/encoding.js";
import { labelKey } from "../normalise.js";
import { resolveResource, rosterEntries } from "./roster.js";
import { FAILED, STOP, openSource, readPage, readStudentSource } from "./studentSource.js";
import { isPlain, member, numberOf, pageOf, textOf, unwrap } from "./tolerant.js";
/** Largest page of students (one Pronote call per student and per source). */
export const MAX_HISTORY_STUDENTS = 40;
export const HISTORY_SOURCES = ["livret", "multiyear"];
const SOURCE_FUNCTION = { livret: "schoolRecord", multiyear: "multiYear" };
const WRAPPERS = ["livret", "livretScolaire", "suivi", "suiviPluriannuel", "donnees", "page"];
// The recorded names first (listeDonnees, listeSuivis, strAnnee, strClasses), then the supposed ones.
const YEARS = ["listeDonnees", "listeAnnees", "listeAnneesScolaires", "annees", "listeBulletins", "listeNiveaux", "listeClasses", "listeLivrets"];
const SUBJECTS = ["listeSuivis", "listeMatieres", "listeServices", "listeDisciplines", "listeEnseignements", "matieres", "services", "listeLignes", "lignes"];
/** Lines of the school record of a student (recorded name; the shape of a line is supposed). */
const LIVRET = ["listeLivret"];
const CELLS = ["listeAnnees", "listeMoyennes", "moyennes", "listeColonnes", "colonnes", "listeValeurs", "valeurs", "listeNotes"];
const YEAR_LABEL = ["strAnnee", "annee", "anneeScolaire", "libelleAnnee", "millesime", "libelle"];
const YEAR_END = ["strFinAnnee", "anneeFin", "finAnnee"];
const LEVEL = ["strClasses", "niveau", "classe", "strClasse", "nomClasse", "libelleClasse", "formation"];
const SUBJECT = ["matiere", "service", "discipline", "enseignement"];
const AVERAGE = ["moyenneEleve", "moyEleve", "moyenne", "moyenneAnnuelle", "moyAnnuelle", "moyenneAnnuelleEleve", "note"];
const CLASS_AVERAGE = ["moyenneClasse", "moyClasse", "moyenneAnnuelleClasse", "moyenneGroupe", "moyGroupe"];
const GENERAL = ["moyenneGenerale", "moyGenerale", "moyenneGeneraleEleve", "moyGeneraleEleve", ...AVERAGE];
const GENERAL_CLASS = ["moyenneGeneraleClasse", "moyGeneraleClasse", ...CLASS_AVERAGE];
const COMMENT = ["appreciation", "appreciationAnnuelle", "commentaire", "avis"];
const COMMENTS = ["listeAppreciations", "appreciations"];
/** "2025-2026" of a label that names a school year ("Année 2025-2026", "2025/26"), "" otherwise. */
export const schoolYearOf = (label) => {
    const match = /(?:^|\D)(20\d{2})\s*[-/–]\s*(?:20)?(\d{2})(?!\d)/.exec(label);
    if (!match)
        return "";
    const first = Number(match[1]);
    return Number(match[2]) === (first + 1) % 100 ? `${first}-${first + 1}` : "";
};
const isList = (value) => value !== undefined && Array.isArray(unwrap(value));
const commentOf = (item) => textOf(member(item, COMMENT)) || listOf(member(item, COMMENTS)).map((line) => textOf(line)).find((line) => line !== "") || "";
const subjectFrom = (value) => {
    const item = unwrap(value);
    if (!isPlain(item))
        return null;
    const subject = textOf(item.L) || textOf(member(item, SUBJECT));
    if (subject === "")
        return null;
    return { subject, average: numberOf(member(item, AVERAGE)), classAverage: numberOf(member(item, CLASS_AVERAGE)), comment: commentOf(item) };
};
const yearLabelOf = (item) => {
    const own = textOf(item.L);
    return schoolYearOf(own) !== "" ? own : (textOf(member(item, YEAR_LABEL)) || own);
};
/**
 * School year of an element: its label when it names one ("2025-2026"), else its two ends when they are given apart
 * (strAnnee "2025", strFinAnnee "2026") and follow each other.
 */
const yearKeyOf = (item, label) => {
    const whole = schoolYearOf(label) || schoolYearOf(textOf(item.L)) || schoolYearOf(textOf(member(item, YEAR_LABEL)));
    if (whole !== "")
        return whole;
    const first = /(?:^|\D)(20\d{2})(?!\d)/.exec(textOf(member(item, YEAR_LABEL)))?.[1];
    const last = /(?:^|\D)(20\d{2})(?!\d)/.exec(textOf(member(item, YEAR_END)))?.[1];
    return first && last && Number(last) === Number(first) + 1 ? `${first}-${last}` : "";
};
/** Layout 1: a list of years, each with its subjects or at least an average. */
const fromYears = (root) => {
    const list = member(root, YEARS);
    if (!isList(list))
        return null;
    const elements = listOf(list).map(unwrap).filter(isPlain);
    const years = [];
    for (const item of elements) {
        const subjects = member(item, SUBJECTS);
        const average = numberOf(member(item, GENERAL));
        if (!isList(subjects) && average === null)
            continue;
        const label = yearLabelOf(item);
        if (label === "")
            continue;
        const year = yearKeyOf(item, label);
        // A label that names no school year ("2025", a class) gives way to the year found beside it.
        years.push({ year, label: year !== "" && schoolYearOf(label) === "" ? year : label, level: textOf(member(item, LEVEL)), average, classAverage: numberOf(member(item, GENERAL_CLASS)),
            subjects: listOf(subjects).map(subjectFrom).filter((subject) => subject !== null) });
    }
    // Elements, but none that is a year with results: the years of the columns of layout 2, or another shape.
    return elements.length > 0 && years.length === 0 ? null : years;
};
/** Layouts 2 and 3: a list of subjects, each with one cell per year, or alone (one year). */
const fromSubjects = (root) => {
    const list = member(root, SUBJECTS);
    if (!isList(list))
        return null;
    const elements = listOf(list).map(unwrap).filter(isPlain);
    const columns = listOf(member(root, YEARS)).map((column) => {
        const item = unwrap(column);
        return isPlain(item) ? { label: yearLabelOf(item), level: textOf(member(item, LEVEL)), average: numberOf(member(item, GENERAL)),
            classAverage: numberOf(member(item, GENERAL_CLASS)) } : { label: textOf(column), level: "", average: null, classAverage: null };
    });
    const years = new Map();
    const yearOf = (label, column) => {
        let year = years.get(label);
        if (!year) {
            year = { year: schoolYearOf(label), label, level: column?.level ?? "", average: column?.average ?? null, classAverage: column?.classAverage ?? null, subjects: [] };
            years.set(label, year);
        }
        return year;
    };
    // The years named beside come first, in their order, even when no subject fills them.
    for (const column of columns)
        if (column.label !== "")
            yearOf(column.label, column);
    let named = 0;
    let flat = 0;
    for (const item of elements) {
        const subject = textOf(item.L) || textOf(member(item, SUBJECT));
        if (subject === "")
            continue;
        named++;
        const cells = member(item, CELLS);
        if (!isList(cells)) {
            flat++;
            continue;
        }
        listOf(cells).forEach((cell, index) => {
            const raw = unwrap(cell);
            const plain = isPlain(raw) ? raw : null;
            const label = (plain ? yearLabelOf(plain) : "") || (columns[index]?.label ?? "");
            if (label === "")
                return;
            const average = plain ? numberOf(member(plain, AVERAGE)) : numberOf(raw);
            const classAverage = plain ? numberOf(member(plain, CLASS_AVERAGE)) : null;
            const comment = plain ? commentOf(plain) : "";
            if (average === null && classAverage === null && comment === "")
                return;
            yearOf(label, columns[index]).subjects.push({ subject, average, classAverage, comment });
        });
    }
    if (elements.length > 0 && named === 0)
        return null;
    if (flat > 0 && flat === named) {
        // Subjects alone: the results of one year, named by the answer when it names it.
        const label = textOf(member(root, YEAR_LABEL));
        return [{ year: schoolYearOf(label), label, level: textOf(member(root, LEVEL)), average: numberOf(member(root, GENERAL)),
                classAverage: numberOf(member(root, GENERAL_CLASS)),
                subjects: elements.map(subjectFrom).filter((subject) => subject !== null) }];
    }
    // Cells that name no year (and no list of years beside): the subjects cannot be placed.
    if (named > 0 && years.size === 0)
        return null;
    return [...years.values()];
};
/**
 * Years of a LivretScolaire answer ("data" member), null when the shape is not understood. The recorded frame first:
 * the lines of the student (eleve.listeLivret) are the subjects of one year, the class of the frame its level; no
 * line is a school record not filled yet. Any other frame is read as the supposed layouts.
 */
export const livretFromAnswer = (data) => {
    if (!isPlain(data))
        return null;
    const student = unwrap(member(data, ["eleve"]));
    if (!isPlain(student) || !isList(member(student, LIVRET)))
        return yearsFromAnswer(data);
    const lines = listOf(member(student, LIVRET));
    if (lines.length === 0)
        return [];
    const subjects = lines.map(subjectFrom).filter((subject) => subject !== null);
    // Lines, but no subject recognised in them: the shape of a line is not the one supposed.
    if (subjects.length === 0)
        return null;
    const classe = unwrap(member(data, ["classe"]));
    const level = isPlain(classe) ? textOf(classe.L) : "";
    const label = textOf(member(data, YEAR_LABEL));
    return [{ year: schoolYearOf(label), label: label || level, level, average: numberOf(member(student, GENERAL)),
            classAverage: numberOf(member(student, GENERAL_CLASS)), subjects }];
};
/**
 * Years of a PageSuiviPluriannuel answer ("data" member), or of an answer in one of the supposed layouts; null when
 * the shape is not understood. A known list that is empty is a student without past results.
 */
export const yearsFromAnswer = (data) => {
    if (!isPlain(data))
        return null;
    const inner = unwrap(member(data, WRAPPERS));
    for (const root of [data, ...(isPlain(inner) ? [inner] : [])]) {
        const years = fromYears(root) ?? fromSubjects(root);
        if (years !== null)
            return years;
    }
    return null;
};
/** Years of several sources, the first source first: one entry per school year, what the first lacks filled by the next. */
export const mergeYears = (lists) => {
    const merged = [];
    for (const list of lists) {
        for (const year of list) {
            const key = year.year || labelKey(year.label);
            const known = merged.find((item) => (item.year || labelKey(item.label)) === key);
            if (!known) {
                merged.push({ ...year, subjects: year.subjects.map((subject) => ({ ...subject })) });
                continue;
            }
            known.level = known.level || year.level;
            known.average = known.average ?? year.average;
            known.classAverage = known.classAverage ?? year.classAverage;
            for (const subject of year.subjects) {
                const same = known.subjects.find((item) => labelKey(item.subject) === labelKey(subject.subject));
                if (!same)
                    known.subjects.push({ ...subject });
                else
                    Object.assign(same, { average: same.average ?? subject.average, classAverage: same.classAverage ?? subject.classAverage, comment: same.comment || subject.comment });
            }
        }
    }
    // Most recent first; the years Pronote does not name keep their place after them.
    return [...merged.filter((year) => year.year !== "").sort((a, b) => b.year.localeCompare(a.year)), ...merged.filter((year) => year.year === "")];
};
const NOT_ASKED = { available: false, reason: "not_asked" };
/**
 * Past results of a page of students of a class or group, from the sources asked (both by default). A source Pronote
 * refuses is closed (no other call, nothing asked in its place); the other goes on. Unavailable when no source asked
 * answers. When the queue towards Pronote is full, the students read so far come back with "remaining" and "retry_after".
 */
export const studentHistory = async (session, resourceId, page = {}, asked = []) => {
    const wanted = asked.length > 0 ? [...new Set(asked)] : [...HISTORY_SOURCES];
    const resource = resolveResource(session, resourceId);
    const { selected, offset, total } = pageOf(await rosterEntries(session, resourceId), page, MAX_HISTORY_STUDENTS, 10);
    const sources = new Map();
    for (const name of wanted)
        sources.set(name, openSource(session, SOURCE_FUNCTION[name]));
    // The school record is the one of a class: for a group, the function is not asked.
    const livret = sources.get("livret");
    if (livret && resource.genre !== 1)
        livret.state = { available: false, reason: "resource_not_class" };
    const classe = { N: resource.id, G: 1, L: resource.label };
    const dataOf = (name, entry) => (name === "livret"
        ? { Classe: classe, AvecDonneesClasse: true, Eleve: { N: entry.pronoteId, G: 4, L: entry.label } }
        : { eleve: { N: entry.pronoteId } });
    const states = () => ({ livret: sources.get("livret")?.state ?? NOT_ASKED, multiyear: sources.get("multiyear")?.state ?? NOT_ASKED });
    const open = () => [...sources.values()].some((source) => source.state.available);
    const base = { validated: false, class: { id: resourceId, name: resource.label }, total, offset };
    const read = await readPage(selected, async (entry) => {
        // Every source closed (refused, not understood): the students left are "remaining" (contract 7.4 ter).
        if (!open())
            return STOP;
        const outcomes = { livret: NOT_ASKED, multiyear: NOT_ASKED };
        const lists = [];
        let error = false;
        for (const [name, source] of sources) {
            const one = await readStudentSource(session, source, dataOf(name, entry), name === "livret" ? livretFromAnswer : yearsFromAnswer, []);
            // The shape of a closed source is given once, by the page: not repeated in every student.
            outcomes[name] = one.value === null && !source.state.available ? { available: false, reason: one.outcome.reason } : one.outcome;
            if (one.value !== null)
                lists.push(one.value);
            error = error || one.outcome.reason === "pronote_error";
        }
        // An error of Pronote on one of his sources: the student is left to read, the page goes on.
        if (error)
            return FAILED;
        return open() || lists.length > 0 ? { studentid: entry.id, label: entry.label, sources: outcomes, years: mergeYears(lists) } : STOP;
    });
    if (!open() && read.read.length === 0) {
        const first = [...sources.values()][0]?.state ?? NOT_ASKED;
        return { ...base, available: false, reason: first.reason || "access_denied", sources: states(), items: [], read: [], remaining: [],
            partial: false, retry_after: 0 };
    }
    return { ...base, available: true, reason: "", sources: states(), ...read, ...(read.failed.length === 0 ? { failed: undefined } : {}) };
};
//# sourceMappingURL=history.js.map