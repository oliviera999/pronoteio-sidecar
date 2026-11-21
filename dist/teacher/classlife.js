/**
 * School life ("vie scolaire") of the students of a class or group over a date range, for the main teacher (0.12.0,
 * read only; contract in docs/pronoteio/vue-pp.md of mood_prod, section 3.4).
 *
 * Sources, each answering for itself (available, reason, scope, detail):
 * - "recap": summary of one student (RecapitulatifVSEleve, tab 19; it answers although tab 19 is in no list of tabs).
 *   0.14.0, real shape of 20/11/2026: NOT a dated list but the official totals of Pronote for the school year, by type
 *   and by subject (officialFromRecap): they fill "official" of each student, every subject, without any date. The
 *   dated list supposed in 0.12.0 (listeAbsences typed by genre) is still read when a school answers it;
 * - "carnet": correspondence notebook of one student (PageSaisieCarnetCorrespondance, tab 78), shape captured on the
 *   demo server: ListeObservations, ListeEncouragements, listeAutresEvenements;
 * - "callsheets": call sheets of the lessons of the account (PageSaisieAbsences, tab 113, validated), week by week:
 *   only the lessons of this teacher ("own_lessons"). The dated detail comes from them as long as no source gives it
 *   for every subject: "totalsScope" then says "own_lessons", and only "official" covers every subject. A whole school
 *   year is many calls: the weeks read stay 10 minutes in memory, so a request refused for lack of time in the queue
 *   (429 rate_limited, retry_after) goes further when sent again;
 * - "summary" (0.14.0, on request): dated detail of every subject from the functions of the web session
 *   (DetailAbsences without teacher, ListePunitions, PageSuivisAbsenceRetard). None of their answers was ever seen:
 *   tolerant decoding, format_unknown with the shape otherwise, one state per function ("parts").
 *
 * Privacy: reasons ("motifs", possibly health) of absences, late arrivals, exemptions and infirmary visits only leave
 * with include=motives; an infirmary visit never carries its comment. Nothing is logged; the week cache lives in the
 * memory of the process only and dies with the session.
 */
import { ServerSideError, translateToWeekNumber } from "pawnote";
import { HttpError } from "../errors.js";
import { answerData, callPronote } from "../pronote/request.js";
import { listOf, pronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { labelKey, localTimes, seconds, splitDisplayName } from "../normalise.js";
import { epochToWall, localString, wallNow } from "../time.js";
import { callFunction, functions, requireFunction } from "./functions.js";
import { stableId } from "./ids.js";
import { resolveResource, rosterEntries, studentKey } from "./roster.js";
import { shapeOf } from "./shape.js";
import { lessonsOfWeek } from "./timetable.js";
import { boolOf, dateOf, dayString, deniedWhere, hoursOf, isAccessDenied, isPlain, labelsOf, member, numberOf, pageOf, readEach, textOf, unwrap } from "./tolerant.js";
export const LIFE_INCLUDES = ["absences", "lateness", "exclusions", "punishments", "observations", "infirmary", "exemptions",
    "motives"];
export const LIFE_SOURCES = ["recap", "carnet", "callsheets", "summary"];
/** Largest number of students read in one page (up to two Pronote calls per student). */
export const MAX_LIFE_STUDENTS = 40;
/** Largest number of weeks of call sheets (a school year and its margins). */
export const MAX_LIFE_WEEKS = 60;
const KIND_INCLUDE = {
    absence: "absences",
    lateness: "lateness",
    exclusion: "exclusions",
    punishment: "punishments",
    observation: "observations",
    infirmary: "infirmary",
    exemption: "exemptions",
};
/** Genres of the school life elements (docs/pronote-matrice/5-6-vie-scolaire-edt.md); 72: precautionary measure. */
const GENRE_KIND = {
    13: "absence",
    14: "lateness",
    15: "exclusion",
    21: "infirmary",
    40: "exemption",
    41: "punishment",
    45: "observation",
    46: "observation",
    72: "exclusion",
};
const GENRE_TEACHER = 3;
const GENRE_STUDENT = 4;
/** Genres of the events of a student folder (EGenreElementDossier of the web client), disjoint from the genres above. */
const FOLDER_KIND = { 0: "absence", 1: "lateness", 2: "exemption", 3: "punishment", 4: "sanction",
    9: "infirmary", 10: "incident", 100: "valorisation" };
/** Genres of the events of the school life (TypeGenreEvenementVS of the web client), read from "genreEvenementVS" only. */
const EVENT_KIND = { 3: "punishment", 4: "sanction", 5: "exemption", 7: "absence", 8: "lateness" };
/** Kinds whose reasons may speak of health: reasons only with include=motives. */
const HEALTH_KINDS = ["absence", "lateness", "exemption", "infirmary"];
/** Hour (wall clock) that splits a day into its two half-days. */
const NOON = 13;
/**
 * Half-days covered by [start, end] (wall Dates), Sundays left out: the morning of a day counts when the interval
 * touches it before 13:00, the afternoon when it goes beyond 13:00. An estimate, used only when Pronote gives no
 * count of half-days with the absence.
 */
export const halfDaysBetween = (start, end) => {
    if (end <= start)
        return 1;
    let count = 0;
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    for (let guard = 0; day <= end && guard < 400; guard++, day.setDate(day.getDate() + 1)) {
        if (day.getDay() === 0)
            continue;
        const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), NOON);
        const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        const from = start > day ? start : day;
        const to = end < next ? end : next;
        if (to <= from)
            continue;
        if (from < noon)
            count++;
        if (to > noon)
            count++;
    }
    return Math.max(1, count);
};
/** Kind of an observation: its genreObservation (0 notebook fault, 1 observation, 2 encouragement), else its label. */
export const observationKind = (genre, label) => {
    const key = labelKey(label);
    if (/parent/.test(key))
        return "parents";
    const code = typeof genre === "number" ? genre : numberOf(genre);
    if (code === 0)
        return "notebook";
    if (code === 1)
        return "observation";
    if (code === 2)
        return "encouragement";
    if (code !== null)
        return "other";
    if (/encourag/.test(key))
        return "encouragement";
    if (/carnet/.test(key))
        return "notebook";
    if (/^observations?$/.test(key))
        return "observation";
    return "other";
};
/** Rubrics whose name says nothing more than the kind: the text is the comment alone. */
const plainRubric = (label) => /^(observations?|encouragements?|defaut de carnet|)$/.test(labelKey(label));
const observationText = (rubric, comment) => plainRubric(rubric) ? comment : comment !== "" ? `${rubric} : ${comment}` : rubric;
/**
 * Event of one element of a school life list (summary of a student or call sheet), null when it is not one. The
 * reasons and texts are complete here; sanitise() removes what was not asked.
 */
export const eventFromItem = (value, source, defaults = {}) => {
    const item = unwrap(value);
    if (!isPlain(item))
        return null;
    // The genre of the element when it is a school life genre, else the genre of its list.
    const kind = (typeof item.G === "number" ? GENRE_KIND[item.G] : undefined) ?? GENRE_KIND[defaults.genre ?? -1];
    if (!kind)
        return null;
    const ownStart = dateOf(member(item, ["DateDebut", "date", "dateDemande", "dateHeure"]));
    const start = ownStart ?? defaults.start ?? null;
    if (!start)
        return null;
    const end = dateOf(member(item, ["DateFin"])) ?? (ownStart ? ownStart : (defaults.end ?? start));
    const comment = textOf(member(item, ["commentaire"]));
    const circumstances = textOf(member(item, ["circonstances", "circonstance"]));
    const reasons = [...new Set([...labelsOf(member(item, ["listeMotifs", "motifs"])), textOf(member(item, ["motif"])),
            kind === "lateness" || kind === "absence" ? textOf(member(item, ["justification"])) : ""].filter(Boolean))];
    let subkind = "";
    let text = "";
    if (kind === "observation") {
        // Call sheet: the observation names its rubric (a column of the sheet, G 45) by its identifier.
        const ref = unwrap(member(item, ["rubrique", "observation"]));
        const column = isPlain(ref) ? defaults.rubrics?.get(String(ref.N ?? "")) : undefined;
        const rubric = textOf(ref) || column?.label || textOf(item.L);
        subkind = observationKind(member(item, ["genreObservation"]) ?? column?.genre, rubric);
        text = observationText(rubric, comment);
    }
    else if (kind === "punishment") {
        subkind = textOf(member(item, ["nature"])) || textOf(item.L);
        text = circumstances || comment;
    }
    else if (kind === "exclusion") {
        subkind = item.G === 72 ? "mesure conservatoire" : "";
        text = circumstances || comment;
    }
    else if (kind === "exemption") {
        text = comment;
    }
    const absence = kind === "absence";
    const explicit = numberOf(member(item, ["nbDemiJournees", "NbrDemiJournees", "demiJournees"]));
    const base = {
        kind,
        subkind,
        start: seconds(start),
        end: seconds(end < start ? start : end),
        local: localTimes({ start, end: end < start ? start : end }),
        justified: absence || kind === "lateness" ? boolOf(member(item, ["justifie", "estJustifie"])) : null,
        settled: boolOf(member(item, ["reglee", "regle", "estReglee"])),
        halfDays: absence ? (explicit ?? halfDaysBetween(start, end)) : null,
        hours: absence ? hoursOf(member(item, ["NbrHeures", "nbHeures", "heuresManquees"])) : null,
        minutes: kind === "lateness" || kind === "punishment" ? numberOf(member(item, ["Duree"])) : null,
        subject: textOf(member(item, ["matiere", "strMatiere"])) || labelsOf(member(item, ["listeMatieres"]))[0] || (defaults.subject ?? ""),
        author: textOf(member(item, ["demandeur", "Professeur", "auteur", "strIndividu", "rapporteur", "strAuteur"])) || (defaults.author ?? ""),
        text,
        reasons,
        source,
    };
    return { ...base, dedup: dedupKey(base, start, end) };
};
const dedupKey = (event, start, end) => {
    if (event.kind === "observation")
        return `observation|${dayString(start)}|${event.subkind}|${labelKey(event.text).slice(0, 60)}`;
    if (event.kind === "punishment")
        return `punishment|${dayString(start)}|${labelKey(event.subkind)}`;
    return `${event.kind}|${localString(start)}|${localString(end < start ? start : end)}`;
};
/** Lists of a student summary that hold elements of every genre, then lists of one genre (elements without G). */
const RECAP_LISTS = ["listeAbsences", "listeEvenements", "listeRecapitulatif", "listeEvenementsVS"];
const RECAP_TYPED = [
    [["listePunitions"], 41],
    [["listeDispenses"], 40],
    [["listeObservations"], 46],
    [["listeRetards"], 14],
    [["listeExclusions"], 15],
];
/** Events of a RecapitulatifVSEleve answer ("data" member), null when no known list is found. */
export const eventsFromRecap = (data) => {
    const main = member(data, RECAP_LISTS);
    const typed = RECAP_TYPED.map(([names, genre]) => [member(data, names), genre]).filter(([list]) => list !== undefined);
    if (main === undefined && typed.length === 0)
        return null;
    const events = listOf(main).map((item) => eventFromItem(item, "recap"));
    for (const [list, genre] of typed)
        events.push(...listOf(list).map((item) => eventFromItem(item, "recap", { genre })));
    return events.filter((event) => event !== null);
};
/** Kind of a line of the official totals: its label first (the only member always there), then its genre. */
export const officialKind = (label, item = {}) => {
    const key = labelKey(label);
    if (/retard/.test(key))
        return "lateness";
    if (/infirmerie/.test(key))
        return "infirmary";
    if (/dispense/.test(key))
        return "exemption";
    if (/exclu/.test(key))
        return "exclusion";
    if (/punition|retenue/.test(key))
        return "punishment";
    if (/sanction/.test(key))
        return "sanction";
    if (/incident/.test(key))
        return "incident";
    if (/valorisation/.test(key))
        return "valorisation";
    if (/observation|encouragement|carnet/.test(key))
        return "observation";
    // "Absences" but neither the meals nor the boarding school, which are not lessons missed.
    if (/absence/.test(key) && !/repas|internat|demi pension/.test(key))
        return "absence";
    if (key !== "")
        return "other";
    if (typeof item.genreObservation === "number")
        return "observation";
    if (typeof item.genreEvenementVS === "number")
        return EVENT_KIND[item.genreEvenementVS] ?? "other";
    return (typeof item.G === "number" ? (GENRE_KIND[item.G] ?? FOLDER_KIND[item.G]) : undefined) ?? "other";
};
const officialCount = (value) => {
    const item = unwrap(value);
    if (!isPlain(item))
        return null;
    const label = textOf(item.L);
    const raw = numberOf(member(item, ["valeur", "nombre", "nb"]));
    // A duration is a fraction of a day in the web client (TUtilitaireDuree.dureeEnMs): 0.0625 is 1 h 30.
    const duration = boolOf(member(item, ["estUneDuree"])) === true;
    return {
        kind: officialKind(label, item),
        label,
        count: duration ? null : raw,
        minutes: duration && raw !== null ? Math.round(raw * 24 * 60) : null,
        halfDays: numberOf(member(item, ["nbDJAbsence"])),
    };
};
/**
 * Official totals of a RecapitulatifVSEleve answer ("data" member), null when neither list is there. First real check
 * of 20/11/2026: the answer is not a dated list but two lists of NUMBERS, read as the web client shows them
 * (objetfenetre_recapitulatifvseleve.js): listeTotal[] ({ G, L, valeur, nbDJAbsence }: one line per type, every subject)
 * and listeMatiere[] ({ L, colonnes[]: { L, valeur, estUneDuree, genreEvenementVS | genreObservation } }: the same per
 * subject). The values were never seen.
 */
export const officialFromRecap = (data) => {
    const totals = member(data, ["listeTotal", "listeTotaux"]);
    const subjects = member(data, ["listeMatiere", "listeMatieres"]);
    if (totals === undefined && subjects === undefined)
        return null;
    const counts = listOf(totals).map(officialCount).filter((item) => item !== null);
    const bySubject = listOf(subjects).map((value) => {
        const item = unwrap(value);
        return { subject: textOf(isPlain(item) ? item.L : ""),
            counts: listOf(member(item, ["colonnes", "listeColonnes"])).map(officialCount).filter((line) => line !== null) };
    }).filter((item) => item.subject !== "" || item.counts.length > 0);
    const sum = (kind) => {
        const lines = counts.filter((line) => line.kind === kind && line.count !== null);
        return lines.length === 0 ? null : lines.reduce((total, line) => total + (line.count ?? 0), 0);
    };
    const halfDays = counts.filter((line) => line.kind === "absence" && line.halfDays !== null);
    return {
        counts,
        bySubject,
        summary: { absences: sum("absence"), absenceHalfDays: halfDays.length === 0 ? null : halfDays.reduce((total, line) => total + (line.halfDays ?? 0), 0),
            lateness: sum("lateness"), exclusions: sum("exclusion"), punishments: sum("punishment"), observations: sum("observation"),
            infirmary: sum("infirmary"), exemptions: sum("exemption") },
    };
};
/** Include that lets a line of the official totals out: the kind of its events, or the nearest one. */
const OFFICIAL_INCLUDE = { ...KIND_INCLUDE, sanction: "punishments", incident: "punishments",
    valorisation: "observations", other: null };
/** Official totals reduced to the kinds asked (a line of another kind is not even named). */
export const officialFor = (official, include) => {
    const keep = (line) => {
        const needed = OFFICIAL_INCLUDE[line.kind];
        return needed !== null && include.includes(needed);
    };
    const wanted = (kind, value) => (include.includes(KIND_INCLUDE[kind]) ? value : null);
    return {
        counts: official.counts.filter(keep),
        bySubject: official.bySubject.map((item) => ({ subject: item.subject, counts: item.counts.filter(keep) })).filter((item) => item.counts.length > 0),
        summary: { absences: wanted("absence", official.summary.absences), absenceHalfDays: wanted("absence", official.summary.absenceHalfDays),
            lateness: wanted("lateness", official.summary.lateness), exclusions: wanted("exclusion", official.summary.exclusions),
            punishments: wanted("punishment", official.summary.punishments), observations: wanted("observation", official.summary.observations),
            infirmary: wanted("infirmary", official.summary.infirmary), exemptions: wanted("exemption", official.summary.exemptions) },
    };
};
/** Lists a dated school life answer may hold (DetailAbsences, ListePunitions, PageSuivisAbsenceRetard: never seen). */
const SUMMARY_LISTS = ["listeAbsences", "listeRetards", "listePunitions", "listeSuivis", "listeEvenements", "listeLignes", "liste"];
/**
 * Events of a dated school life answer whose shape was never seen: every known list is read with the member names of
 * the call sheets (DateDebut, DateFin, justifie, reglee, listeMotifs, Duree, Professeur, listeMatieres), an element
 * without school life genre taking the genre asked. null when no known list is there (format_unknown, with the shape).
 */
export const eventsFromSummary = (data, genre) => {
    const lists = SUMMARY_LISTS.map((name) => member(data, [name])).filter((list) => list !== undefined);
    if (lists.length === 0)
        return null;
    return lists.flatMap((list) => listOf(list).map((item) => eventFromItem(item, "summary", { genre })))
        .filter((event) => event !== null);
};
/**
 * Events of a PageSaisieCarnetCorrespondance answer (shape captured on the demo server): observations (G 1) and
 * encouragements (G 2) of the account, and the events entered by colleagues (listeAutresEvenements: rubrique,
 * strMatiere, strIndividu, date). null when none of the three lists is there.
 */
export const eventsFromNotebook = (data) => {
    const observations = member(data, ["ListeObservations"]);
    const encouragements = member(data, ["ListeEncouragements"]);
    const others = member(data, ["listeAutresEvenements"]);
    if (observations === undefined && encouragements === undefined && others === undefined)
        return null;
    const events = [];
    const push = (value, forced) => {
        const item = unwrap(value);
        if (!isPlain(item))
            return;
        const start = dateOf(member(item, ["date", "DateDebut"]));
        if (!start)
            return;
        const rubric = textOf(member(item, ["rubrique"])) || (forced === null ? textOf(item.L) : "");
        const subkind = forced ?? observationKind(member(item, ["genreObservation"]), rubric);
        const base = {
            kind: "observation",
            subkind,
            start: seconds(start),
            end: seconds(start),
            local: localTimes({ start, end: start }),
            justified: null,
            settled: null,
            halfDays: null,
            hours: null,
            minutes: null,
            subject: textOf(member(item, ["strMatiere", "matiere"])),
            author: textOf(member(item, ["demandeur", "strIndividu", "auteur"])),
            text: observationText(rubric, textOf(member(item, ["commentaire"]))),
            reasons: [],
            source: "carnet",
        };
        events.push({ ...base, dedup: dedupKey(base, start, start) });
    };
    // In these two lists G is 1 (observation) or 2 (encouragement), not a school life genre.
    for (const item of listOf(observations))
        push(item, unwrap(item)?.G === 2 ? "encouragement" : "observation");
    for (const item of listOf(encouragements))
        push(item, unwrap(item)?.G === 1 ? "observation" : "encouragement");
    for (const item of listOf(others))
        push(item, null);
    return events;
};
/**
 * Events of a call sheet (PageSaisieAbsences answer) for the given students: ListeAbsences (every genre), listePunitions
 * and ListeDispenses of each student. An element without date takes the times of the lesson.
 */
export const eventsFromCallSheet = (data, students, lesson, onRegime) => {
    const byPronoteId = new Map(students.map((entry) => [entry.pronoteId, entry]));
    const byLabel = new Map();
    for (const entry of students)
        byLabel.set(entry.label, byLabel.has(entry.label) ? null : entry);
    const result = new Map();
    const rubrics = new Map();
    for (const column of listOf(member(data, ["ListeColonnes"]))) {
        if (column?.G === 45 && typeof column?.N === "string")
            rubrics.set(column.N, { label: textOf(column.L), genre: column.genreObservation });
    }
    const defaults = { start: lesson.start, end: lesson.end, subject: lesson.subject, rubrics };
    for (const student of listOf(member(data, ["ListeEleves"]))) {
        const lists = [
            [member(student, ["ListeAbsences"]), undefined],
            [member(student, ["listePunitions"]), 41],
            [member(student, ["ListeDispenses"]), 40],
        ];
        for (const [list, genre] of lists) {
            for (const item of listOf(list)) {
                const owner = unwrap(item?.eleve) ?? student;
                const entry = byPronoteId.get(String(owner?.N ?? "")) ?? byLabel.get(String(owner?.L ?? ""));
                if (!entry)
                    continue;
                // 0.14.0: an absence names the regime of the student ("regime"), the only place it was ever seen.
                const regime = textOf(member(unwrap(item), ["regime"]));
                if (regime !== "")
                    onRegime?.(entry.id, regime);
                const event = eventFromItem(item, "callsheets", { ...defaults, genre });
                if (!event)
                    continue;
                const list = result.get(entry.id) ?? [];
                list.push(event);
                result.set(entry.id, list);
            }
        }
    }
    return result;
};
/** Removes from an event what was not asked: reasons of the kinds that may speak of health, exemption comments. */
export const sanitise = (event, motives) => {
    if (!HEALTH_KINDS.includes(event.kind))
        return event;
    // An infirmary visit never carries its comment; the other texts of these kinds are reasons too.
    return motives ? { ...event, text: event.kind === "infirmary" ? "" : event.text } : { ...event, reasons: [], text: "" };
};
const SOURCE_ORDER = ["recap", "summary", "carnet", "callsheets"];
/** Events of a student: kinds asked, inside [from, to), the same event kept once (recap, summary, carnet, then call sheets). */
export const mergeEvents = (studentId, events, include, from, to) => {
    const motives = include.includes("motives");
    const seen = new Map();
    const ordered = [...events].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
    for (const event of ordered) {
        if (!include.includes(KIND_INCLUDE[event.kind]))
            continue;
        if (event.start < from || event.start >= to)
            continue;
        if (!seen.has(event.dedup))
            seen.set(event.dedup, event);
    }
    return [...seen.values()]
        .map((event) => sanitise(event, motives))
        .sort((a, b) => a.start - b.start || a.kind.localeCompare(b.kind))
        .map(({ dedup, ...event }) => ({ id: stableId("absence", `${studentId}|${dedup}`), ...event }));
};
const round = (value) => Math.round(value * 100) / 100;
/** Totals of a student, computed on the events returned: totals and detail always agree. */
export const totalsOf = (events) => {
    const absences = events.filter((event) => event.kind === "absence");
    const unjustified = absences.filter((event) => event.justified === false);
    const count = (kind) => events.filter((event) => event.kind === kind).length;
    const observations = { observation: 0, encouragement: 0, notebook: 0, parents: 0, other: 0 };
    for (const event of events) {
        if (event.kind === "observation")
            observations[(event.subkind in observations ? event.subkind : "other")]++;
    }
    return {
        absences: absences.length,
        absenceHalfDays: round(absences.reduce((sum, event) => sum + (event.halfDays ?? 0), 0)),
        unjustifiedAbsences: unjustified.length,
        unjustifiedHalfDays: round(unjustified.reduce((sum, event) => sum + (event.halfDays ?? 0), 0)),
        missedHours: round(absences.reduce((sum, event) => sum + (event.hours ?? 0), 0)),
        lateness: count("lateness"),
        exclusions: count("exclusion"),
        punishments: count("punishment"),
        infirmary: count("infirmary"),
        exemptions: count("exemption"),
        observations,
    };
};
const WEEK_TTL_MS = 10 * 60_000;
const weekCache = new WeakMap();
/** Regime of the students seen on the call sheets of a session (student stable id → label), in memory only. */
const regimes = new WeakMap();
/** Regime of a student read on a call sheet of this session, "" when none was seen. */
export const regimeSeen = (session, studentId) => regimes.get(session)?.get(studentId) ?? "";
const rememberRegime = (session, studentId, regime) => {
    const known = regimes.get(session) ?? new Map();
    known.set(studentId, regime);
    regimes.set(session, known);
};
/** Forgets the weeks of call sheets and the closed summary functions kept in memory (tests). */
export const resetWeekCache = (session) => {
    weekCache.delete(session);
    regimes.delete(session);
    resetSummaryMemory(session);
};
/**
 * Whether a lesson of the account may hold students of the class or group: a group lesson is kept for a class (its
 * students may attend it), a lesson of other whole classes is not.
 */
export const lessonConcerns = (groups, resource, classes) => {
    const wanted = labelKey(resource.label);
    const keys = groups.map(labelKey).filter(Boolean);
    if (keys.includes(wanted))
        return true;
    if (resource.genre !== 1)
        return false;
    if (keys.length === 0)
        return true;
    const known = new Set(classes.map(labelKey));
    return keys.some((key) => !known.has(key));
};
class SourceDenied extends Error {
}
const readWeek = async (session, resource, students, week, now) => {
    const fn = requireFunction("absencesList");
    const me = session.user.resources[0];
    const classes = userData(session).resources.filter((item) => item.genre === 1).map((item) => item.label);
    const entry = { expires: Date.now() + WEEK_TTL_MS, events: new Map(), lessons: 0, skipped: 0 };
    for (const ref of await lessonsOfWeek(session, week)) {
        if (ref.lesson.cancelled || ref.lesson.start >= now || !lessonConcerns(ref.lesson.groups, resource, classes))
            continue;
        const start = epochToWall(ref.lesson.start);
        let data;
        try {
            data = answerData(session, await callPronote(session, {
                name: fn.name,
                data: { Professeur: { N: me.id, G: GENRE_TEACHER, L: me.name }, Ressource: { N: ref.pronoteId }, Date: pronoteDate(start) },
                signature: fn.onglet !== null ? { onglet: fn.onglet } : undefined,
            }));
        }
        catch (error) {
            if (isAccessDenied(error))
                throw new SourceDenied();
            // A lesson whose call sheet Pronote does not give (outing, lesson not usable for the call) is skipped.
            if (!(error instanceof ServerSideError))
                throw error;
            entry.skipped++;
            continue;
        }
        entry.lessons++;
        const lesson = { start, end: epochToWall(ref.lesson.end), subject: ref.lesson.subject };
        for (const [id, events] of eventsFromCallSheet(data, students, lesson, (student, regime) => rememberRegime(session, student, regime))) {
            entry.events.set(id, [...(entry.events.get(id) ?? []), ...events]);
        }
    }
    return entry;
};
/**
 * Events of the call sheets of the lessons of the account between two wall Dates, for every student of the class or
 * group. Weeks already read during the last 10 minutes come from memory. Throws RateLimitedError (429) when the queue
 * has no time left: the weeks read are kept, the same request sent again goes further.
 */
export const callSheetEvents = async (session, resourceId, resource, students, from, to) => {
    const state = { available: true, reason: "", scope: "own_lessons", function: functions.absencesList.name,
        onglet: functions.absencesList.onglet, lessons: 0, skipped: 0 };
    const events = new Map();
    const nowWall = wallNow();
    const until = to < nowWall ? to : nowWall;
    if (until <= from)
        return { events, state };
    const firstMonday = session.instance.firstMonday;
    const first = Math.max(1, translateToWeekNumber(from, firstMonday));
    const last = translateToWeekNumber(new Date(until.getTime() - 1), firstMonday);
    if (last - first + 1 > MAX_LIFE_WEEKS)
        throw new HttpError(400, "range_too_large");
    let cache = weekCache.get(session);
    if (!cache) {
        cache = new Map();
        weekCache.set(session, cache);
    }
    const now = seconds(nowWall);
    for (let week = first; week <= last; week++) {
        const key = `${resourceId}|${week}`;
        let entry = cache.get(key);
        if (!entry || entry.expires <= Date.now()) {
            try {
                entry = await readWeek(session, resource, students, week, now);
            }
            catch (error) {
                if (!(error instanceof SourceDenied))
                    throw error;
                return { events: new Map(), state: { ...state, available: false, reason: "access_denied", ...deniedWhere(session, functions.absencesList.onglet) } };
            }
            cache.set(key, entry);
        }
        state.lessons = (state.lessons ?? 0) + entry.lessons;
        state.skipped = (state.skipped ?? 0) + entry.skipped;
        for (const [id, list] of entry.events)
            events.set(id, [...(events.get(id) ?? []), ...list]);
    }
    return { events, state };
};
/** Reads one student from a per-student source; a refusal or an unknown shape closes the source for the request. */
const readSource = async (session, source, entry) => {
    const nothing = { events: [] };
    if (!source.state.available)
        return nothing;
    let data;
    try {
        data = await callFunction(session, source.key, source.data(entry));
    }
    catch (error) {
        if (!(error instanceof ServerSideError))
            throw error;
        const denied = isAccessDenied(error);
        Object.assign(source.state, { available: false, reason: denied ? "access_denied" : "pronote_error" }, denied ? deniedWhere(session, functions[source.key].onglet) : {});
        return nothing;
    }
    if (!data || Object.keys(data).length === 0) {
        Object.assign(source.state, { available: false, reason: "access_denied" }, deniedWhere(session, functions[source.key].onglet));
        return nothing;
    }
    const decoded = source.decode(data);
    if (decoded === null) {
        Object.assign(source.state, { available: false, reason: "format_unknown", shape: shapeOf(data) });
        return nothing;
    }
    if (decoded.detail !== undefined)
        source.state.detail = (source.state.detail ?? false) || decoded.detail;
    return decoded;
};
/**
 * A RecapitulatifVSEleve answer: the official totals (real shape of 20/11/2026) and, should a school answer the dated
 * list supposed in 0.12.0, its events. null when neither is recognised.
 */
export const decodeRecap = (data) => {
    const official = officialFromRecap(data);
    const events = eventsFromRecap(data);
    if (official === null && events === null)
        return null;
    return { events: events ?? [], official, detail: events !== null };
};
const student = (entry) => ({ N: entry.pronoteId, G: GENRE_STUDENT, L: entry.label });
/**
 * Functions of the web session that may give the dated school life of ONE student for every subject. Their requests
 * are those of the web client (PRONOTE 2026.2); none of their answers was ever seen: each one is decoded tolerantly
 * (eventsFromSummary) and answers format_unknown with its shape otherwise. DetailAbsences is asked WITHOUT "professeur"
 * (with it, on the demo server, only the lessons of that teacher are counted).
 */
const SUMMARY_PARTS = [
    { key: "lifeAbsenceDetail", genre: 13, needs: ["absences"],
        data: (entry, from, to) => ({ eleve: student(entry), dateDebut: pronoteDate(from), dateFin: pronoteDate(to), genreAbsence: 13 }) },
    { key: "lifeAbsenceDetail", genre: 14, needs: ["lateness"],
        data: (entry, from, to) => ({ eleve: student(entry), dateDebut: pronoteDate(from), dateFin: pronoteDate(to), genreAbsence: 14 }) },
    { key: "lifePunishments", genre: 41, needs: ["punishments"], data: (entry) => ({ eleve: student(entry) }) },
    { key: "lifeFollowUp", genre: 13, needs: ["absences", "lateness"],
        data: (entry, from, to) => ({ eleve: student(entry), dateDebut: pronoteDate(from), dateFin: pronoteDate(to) }) },
];
/** Functions of the dated summary a session has seen refused or unreadable: not asked again for every student. */
const summaryClosed = new WeakMap();
/** Forgets the summary functions closed for a session (tests). */
export const resetSummaryMemory = (session) => {
    summaryClosed.delete(session);
};
/** Events of one student from the functions of the dated summary still open; closes those that refuse or are not understood. */
const readSummary = async (session, state, entry, include, from, to) => {
    const closed = summaryClosed.get(session) ?? new Map();
    summaryClosed.set(session, closed);
    const parts = new Map((state.parts ?? []).map((part) => [part.function, part]));
    const events = [];
    for (const part of SUMMARY_PARTS) {
        if (!part.needs.some((kind) => include.includes(kind)))
            continue;
        const fn = functions[part.key];
        if (!fn.name)
            continue;
        const known = closed.get(part.key);
        if (known) {
            parts.set(fn.name, known);
            continue;
        }
        const line = parts.get(fn.name) ?? { function: fn.name, onglet: fn.onglet, available: true, reason: "" };
        parts.set(fn.name, line);
        const close = (reason, shape) => {
            Object.assign(line, { available: false, reason }, shape ? { shape } : {});
            closed.set(part.key, line);
        };
        let data;
        try {
            data = await callFunction(session, part.key, part.data(entry, from, to));
        }
        catch (error) {
            if (!(error instanceof ServerSideError))
                throw error;
            close(isAccessDenied(error) ? "access_denied" : "pronote_error");
            continue;
        }
        if (!data || Object.keys(data).length === 0) {
            close("access_denied");
            continue;
        }
        const read = eventsFromSummary(data, part.genre);
        if (read === null)
            close("format_unknown", shapeOf(data));
        else
            events.push(...read);
    }
    state.parts = [...parts.values()];
    state.available = state.parts.some((part) => part.available);
    state.reason = state.available ? "" : (state.parts[0]?.reason ?? "not_asked");
    return events;
};
/**
 * School life of a page of students of a class or group between two instants (seconds). See the header for the
 * sources; "sources" names those to ask. By default: "recap" (official totals of Pronote, every subject, without
 * date), "carnet" (observations) and, for the dated detail, "callsheets" (lessons of the account only) unless the
 * summary itself gives dated events. "summary" (dated detail of every subject, functions never seen answering) is read
 * on request only.
 */
export const classLife = async (session, resourceId, fromEpoch, toEpoch, options = {}) => {
    const include = options.include?.length ? [...new Set(options.include)] : ["absences", "lateness"];
    const resource = resolveResource(session, resourceId);
    const entries = await rosterEntries(session, resourceId);
    const { selected, offset, total } = pageOf(entries, options.page ?? {}, MAX_LIFE_STUDENTS, 10);
    const from = epochToWall(fromEpoch);
    const to = epochToWall(toEpoch);
    const asked = options.sources?.length ? [...new Set(options.sources)] : null;
    const wants = (source) => (asked ? asked.includes(source) : source === "recap" || source === "carnet");
    const base = { available: false, reason: "", validated: false, class: { id: resourceId, name: resource.label },
        from: fromEpoch, to: toEpoch, include, total, offset, sources: {}, totalsScope: "none", items: [], read: [], remaining: [],
        partial: false, retry_after: 0 };
    const perStudent = (key, decode, data) => ({ key, decode, data, state: { available: true, reason: "", scope: "all", function: functions[key].name, onglet: functions[key].onglet } });
    // Request that answered on the real server (20/11/2026). The web client sends the student alone and shows the
    // numbers of the school year: the dates are not known to narrow the official totals.
    const recap = wants("recap")
        ? perStudent("studentLifeRecap", decodeRecap, (entry) => ({ eleve: student(entry), DateDebut: pronoteDate(from), DateFin: pronoteDate(to) }))
        : null;
    if (recap)
        recap.state.detail = false;
    // The correspondence notebook only holds observations: not read when they are not asked.
    const carnet = wants("carnet") && include.includes("observations")
        ? perStudent("studentNotebook", (data) => {
            const events = eventsFromNotebook(data);
            return events === null ? null : { events };
        }, (entry) => ({ Eleve: student(entry) }))
        : null;
    const summary = wants("summary") ? { available: true, reason: "", scope: "all", detail: true, parts: [] } : null;
    // The first student tells whether the summary gives dated events: the call sheets (many calls, possibly refused for
    // lack of time in the queue) are read before the other students, so that a 429 costs one student, not a page.
    const none = { events: [] };
    const firstRecap = recap && selected.length > 0 ? await readSource(session, recap, selected[0]) : none;
    const firstSummary = summary && selected.length > 0 ? await readSummary(session, summary, selected[0], include, from, to) : [];
    const dated = (recap?.state.available === true && recap.state.detail === true) || summary?.available === true;
    const fallback = asked ? asked.includes("callsheets") : !dated;
    let sheets = null;
    if (fallback && selected.length > 0)
        sheets = await callSheetEvents(session, resourceId, resource, entries, from, to);
    const read = await readEach(selected, async (entry) => {
        const events = [];
        let official = null;
        if (recap) {
            const one = entry === selected[0] ? firstRecap : await readSource(session, recap, entry);
            events.push(...one.events);
            official = one.official ?? null;
        }
        if (summary)
            events.push(...(entry === selected[0] ? firstSummary : await readSummary(session, summary, entry, include, from, to)));
        if (carnet)
            events.push(...(await readSource(session, carnet, entry)).events);
        return { events, official };
    });
    if (recap)
        base.sources.recap = recap.state;
    if (summary)
        base.sources.summary = summary;
    if (carnet)
        base.sources.carnet = carnet.state;
    if (sheets)
        base.sources.callsheets = { ...sheets.state, detail: true };
    const states = Object.values(base.sources);
    if (states.length > 0 && states.every((state) => !state.available)) {
        return { ...base, reason: states[0].reason || "access_denied" };
    }
    const everySubject = (recap?.state.available === true && recap.state.detail === true) || summary?.available === true;
    const totalsScope = everySubject ? "all" : sheets?.state.available ? "own_lessons" : "none";
    const items = read.read.map((id, index) => {
        const entry = selected[index];
        const name = splitDisplayName(entry.label);
        const one = read.items[index];
        const events = mergeEvents(id, [...one.events, ...(sheets?.events.get(id) ?? [])], include, fromEpoch, toEpoch);
        return { studentid: id, key: studentKey(entry.pronoteId), label: entry.label, lastname: name.lastname, firstname: name.firstname,
            totals: totalsOf(events), events, official: one.official ? officialFor(one.official, include) : null };
    });
    return { ...base, available: true, totalsScope, items, read: read.read, remaining: read.remaining, partial: read.partial,
        retry_after: read.retry_after };
};
//# sourceMappingURL=classlife.js.map