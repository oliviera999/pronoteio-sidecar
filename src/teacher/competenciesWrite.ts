/**
 * Writes a skills assessment and its levels: SaisieEvaluations (tab 65), built from the client code
 * (_serialiseEvaluation of the skills grid; see docs/pronote-matrice/2-3-notes-competences.md in mood_prod).
 *
 * NOT VALIDATED: the demo profile does not open the skills tabs and ignores writes; the request shape comes from the
 * client code only. The sidecar reads the assessment before (ListeEvaluations, PageCompetencesParEvaluation), sends
 * the assessment with its state E (1 created, 2 modified, 3 deleted), the skills (relations ESI as read) and only the
 * students whose levels change, then reads again. A published assessment is visible to families.
 *
 * 0.8.0: the service may be a skills service of tab 65 only (group of a "collège" class), designated with or without
 * the brackets of its group; a skill to create may be given by its referential id (rf:…), its code ("D2/4.1") or its
 * label; "defaultLevel" gives a level to every student of the class or group for every skill (niveauAcquiDefaut, the
 * "Niv." of the client's creation window), explicit ratings win; "cycleReport" sets priseEnCompteDansBilan.
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf, pronoteDate, pronoteNumber } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { normalise, type CompetencyItem } from "../normalise.js";
import { epochToWall, legacySeconds } from "../time.js";
import {
  competencyElement,
  DEFAULT_LEVELS,
  findReferentialItem,
  isAccessDenied,
  itemFromList,
  levelsOf,
  loadReferential,
  parentsDelayOf,
  ratingsFromPage,
  resourceRefOf,
  type SessionReferentialItem,
} from "./competencies.js";
import { call, loadAllServices, pickPeriod, ref, resolveService, resourceOf, resourceType, serviceIdsOf, type Element } from "./grades.js";
import { stableId } from "./ids.js";
import { rosterEntries } from "./roster.js";
import { sendWrite } from "./write.js";

const STATE_CREATED = 1;
const STATE_MODIFIED = 2;
const STATE_DELETED = 3;
const TYPE_HTML = 21;
const TYPE_NUMBER = 10;
const GENRE_STUDENT = 4;

export type RatingChange = { student: string; skill: string; level: number; observation?: string; published?: boolean };

export type CompetencyWrite = {
  /** Stable id (cp:…) of the assessment to modify or delete, null to create one. */
  assessment: string | null;
  service: string;
  period: string;
  title?: string;
  /** Assessment date (seconds). */
  date?: number;
  publication?: number | null;
  description?: string;
  coefficient?: number;
  /** Stable skill ids kept (existing assessment) or relation ESI ids of the school's grid (creation). */
  skills?: string[];
  ratings?: RatingChange[];
  delete?: boolean;
  /** 0.8.0: taken into account in the "bilans de cycle"; absent: true at creation, unchanged otherwise. */
  cycleReport?: boolean;
  /** 0.8.0: level code given to every student for every skill of the assessment, explicit ratings win. */
  defaultLevel?: number;
  dryRun: boolean;
  force?: boolean;
};

/** Skill wanted in the assessment: an existing skill of the assessment or a skill of the referential to add. */
export type WantedSkill = {
  /** Value given in "skills" (stable id, referential id, code or label). */
  key: string;
  existing: any | null;
  relation: Record<string, unknown>;
  item: SessionReferentialItem | null;
};

export type CompetencyWriteResult = {
  before: CompetencyItem | null;
  after: CompetencyItem | null;
  request: Record<string, unknown>;
  written: boolean;
  dryRun: boolean;
  validated: false;
  /** 0.8.0: days between the publication to students and to parents, null when unknown. */
  parentsDelayDays: number | null;
};

/** Pronote element of a level code ({N, G, L} from the school's list, or {G, L} from the client enumeration). */
export const levelElement = (session: SessionHandle, code: number): Record<string, unknown> => {
  const raw = listOf<any>(userData(session).acquisitionLevels).find((item) => Number(item?.G) === code);
  if (raw && typeof raw.N === "string") return { N: raw.N, G: code, L: String(raw.L ?? "") };
  // The school's list may be partial: the client enumeration completes it.
  const known = levelsOf(session).find((item) => item.code === code) ?? DEFAULT_LEVELS.find((item) => item.code === code);
  if (!known) throw new HttpError(400, `level_unknown:${code}`);
  return { G: code, L: known.name };
};

const number = (value: number) => ({ _T: TYPE_NUMBER, V: pronoteNumber(value) });

/** Students of an assessment page (ListeElevesCompetences) or of the roster, by label. */
const studentsOf = (page: Record<string, any> | null, roster: { pronoteId: string; label: string }[]): { N: string; L: string }[] => {
  const fromPage = listOf<any>(page?.ListeElevesCompetences)
    .filter((item) => typeof item?.N === "string")
    .map((item) => ({ N: String(item.N), L: String(item?.L ?? item?.eleve?.V?.L ?? "").trim() }));
  return fromPage.length ? fromPage : roster.map((item) => ({ N: item.pronoteId, L: item.label }));
};

/**
 * Skills wanted in the assessment, resolved against the existing skills of the assessment (stable ids), then the
 * referential of the service (rf: id, code "D2/4.1" or label), then a raw relation ESI identifier ("15#…", legacy).
 * HTTP 404 skill_not_found:<value> otherwise.
 */
export const resolveSkills = (
  wanted: string[],
  existing: Element | null,
  skillIds: Map<string, string>,
  referential: () => SessionReferentialItem[],
): WantedSkill[] => {
  const byStableId = new Map<string, any>();
  listOf<any>(existing?.listeCompetences).forEach((skill) => {
    const id = skillIds.get(String(skill?.relationESI?.V?.N ?? skill?.N ?? ""));
    if (id) byStableId.set(id, skill);
  });
  return wanted.map((key) => {
    const skill = byStableId.get(key);
    if (skill) return { key, existing: skill, relation: skill.relationESI?.V ? ref(skill.relationESI.V) : { N: skill.N }, item: null };
    const item = findReferentialItem(key, referential());
    if (item) {
      const same = [...byStableId.values()].find((s) => String(s?.relationESI?.V?.N ?? "") === item.relation);
      if (same) return { key, existing: same, relation: ref(same.relationESI.V), item };
      return { key, existing: null, relation: { N: item.relation }, item };
    }
    if (/^\d+#/.test(key)) return { key, existing: null, relation: { N: key }, item: null };
    throw new HttpError(404, `skill_not_found:${key}`);
  });
};

/** Ratings to send: explicit ones, plus the default level for every student and skill they leave out. */
export const expandRatings = (
  ratings: RatingChange[],
  defaultLevel: number | undefined,
  students: { N: string; L: string }[],
  skills: string[],
): RatingChange[] => {
  if (defaultLevel === undefined || defaultLevel === null) return ratings;
  const given = new Set(ratings.map((rating) => `${normalise(rating.student)}|${rating.skill}`));
  const result = [...ratings];
  for (const student of students) {
    for (const skill of skills) {
      if (!given.has(`${normalise(student.L)}|${skill}`)) result.push({ student: student.L, skill, level: defaultLevel });
    }
  }
  return result;
};

/** SaisieEvaluations JSON for one assessment (creation, modification or deletion). */
export const buildCompetencyRequest = (
  session: SessionHandle,
  service: Element,
  resource: Element | undefined,
  period: Element,
  existing: Element | null,
  skillIds: Map<string, string>,
  students: { N: string; L: string }[],
  write: CompetencyWrite,
  resolved?: WantedSkill[],
): Record<string, unknown> => {
  const wanted = resolved ?? resolveSkills(write.skills ?? [...skillIds.values()], existing, skillIds, () => []);
  const kept = write.skills ? wanted : resolveSkills([...skillIds.values()], existing, skillIds, () => []);
  const skillMembers = kept.map(({ existing: skill, relation }, index) => {
    if (skill) {
      return {
        N: skill.N,
        E: STATE_MODIFIED,
        relationESI: skill.relationESI?.V ? ref(skill.relationESI.V) : undefined,
        coefficient: skill.coefficient ?? number(1),
        niveauAcquiDefaut: write.defaultLevel !== undefined ? levelElement(session, write.defaultLevel) : skill.niveauAcquiDefaut,
        ordre: index,
        palier: skill.palier,
      };
    }
    return {
      N: 0,
      E: STATE_CREATED,
      relationESI: relation,
      coefficient: number(1),
      ...(write.defaultLevel !== undefined ? { niveauAcquiDefaut: levelElement(session, write.defaultLevel) } : {}),
      ordre: index,
    };
  });
  const relationOf = (skillId: string): Record<string, unknown> => {
    const found = kept.find((skill) => skill.key === skillId)
      ?? kept.find((skill) => skill.existing && skillIds.get(String(skill.existing?.relationESI?.V?.N ?? skill.existing?.N ?? "")) === skillId)
      ?? kept.find((skill) => skill.item && findReferentialItem(skillId, [skill.item]));
    if (found) return found.relation;
    throw new HttpError(404, `skill_not_found:${skillId}`);
  };
  const byStudent = new Map<string, RatingChange[]>();
  const ratings = write.delete ? [] : expandRatings(write.ratings ?? [], write.defaultLevel, students, kept.map((skill) => skill.key));
  for (const rating of ratings) {
    const key = normalise(rating.student);
    byStudent.set(key, [...(byStudent.get(key) ?? []), rating]);
  }
  const studentMembers = [...byStudent.entries()].map(([key, items]) => {
    const student = students.find((item) => normalise(item.L) === key);
    if (!student) throw new HttpError(404, `student_not_found:${items[0].student}`);
    return {
      N: student.N,
      G: GENRE_STUDENT,
      E: STATE_MODIFIED,
      listeCompetences: items.map((rating) => ({
        relationESI: relationOf(rating.skill),
        niveauDAcquisition: levelElement(session, rating.level),
        observation: rating.observation ?? "",
        observationPubliee: rating.published === true,
      })),
    };
  });
  const date = write.date !== undefined ? epochToWall(write.date) : null;
  const evaluation: Record<string, unknown> = {
    N: existing ? existing.N : 0,
    E: write.delete ? STATE_DELETED : existing ? STATE_MODIFIED : STATE_CREATED,
    L: write.title ?? String(existing?.L ?? ""),
    Service: ref(service),
    ...(resource ? { Ressource: ref(resource) } : {}),
    Periode: ref(period),
    ListeThemes: listOf<any>(existing?.ListeThemes).map(ref),
    DateValidation: date ? pronoteDate(date) : existing?.dateValidation ?? null,
    DatePublication:
      write.publication === undefined
        ? existing?.datePublication ?? null
        : write.publication === null
          ? null
          : pronoteDate(epochToWall(write.publication)),
    Descriptif: { _T: TYPE_HTML, V: write.description ?? String(existing?.descriptif?.V ?? "") },
    coefficient: write.coefficient !== undefined ? number(write.coefficient) : existing?.coefficient ?? number(1),
    priseEnCompteDansBilan: write.cycleReport ?? existing?.priseEnCompteDansBilan ?? true,
    listeCompetences: write.delete ? [] : skillMembers,
    listeEleves: write.delete ? [] : studentMembers,
  };
  return { service: ref(service), ...(resource ? { ressource: ref(resource) } : {}), listeEvaluations: [evaluation], listeFichiers: [] };
};

/* non validé sur la démo : onglet 65 fermé au profil de démonstration, écritures ignorées */
export const writeCompetency = async (session: SessionHandle, write: CompetencyWrite): Promise<CompetencyWriteResult> => {
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
  const item = (evaluation: Element) => itemFromList(evaluation, subject, resourcename, type, serviceid, parentsDelay);
  let list: Record<string, any>;
  try {
    list = await call(session, "competencyList", {
      service: ref(service),
      ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
      periode: ref(picked.period),
    });
  } catch (error) {
    if (isAccessDenied(error)) throw new HttpError(403, "access_denied");
    throw error;
  }
  const evaluations = listOf<Element>(list?.listeEvaluations);
  let existing: Element | null = null;
  let before: CompetencyItem | null = null;
  let skillIds = new Map<string, string>();
  let page: Record<string, any> | null = null;
  if (write.assessment) {
    for (const evaluation of evaluations) {
      const parsed = item(evaluation);
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
    if (!existing) throw new HttpError(404, "assessment_not_found");
  } else if (!write.title || write.date === undefined) {
    throw new HttpError(400, "title_and_date_required");
  }
  if (write.delete && !existing) throw new HttpError(400, "delete_without_id");
  const roster = resourceRef && (page === null || write.defaultLevel !== undefined)
    ? await rosterEntries(session, stableId(type, resourcename))
    : [];
  const students = studentsOf(page, roster);
  let referential: SessionReferentialItem[] | null = null;
  const referentialOf = () => (referential ??= []);
  const wantedKeys = write.skills ?? [...skillIds.values()];
  const needsReferential = !write.delete && wantedKeys.some((key) => ![...skillIds.values()].includes(key) && !/^\d+#/.test(key));
  if (needsReferential) referential = await loadReferential(session, service, resourceRef, list);
  const resolved = write.delete ? [] : resolveSkills(wantedKeys, existing, skillIds, referentialOf);
  const request = buildCompetencyRequest(session, service, resourceRef, picked.period, existing, skillIds, students, write, resolved);

  const plannedTitle = write.title ?? before?.title ?? "";
  const plannedDate = write.date ?? before?.date ?? null;
  const plannedPublication = write.publication === undefined ? before?.publication ?? null : write.publication;
  const plannedSkills = resolved.map((skill) => {
    const kept = before?.skills.find((s) => s.id === skill.key || (skill.existing && s.name === String(skill.existing?.L ?? "").trim()));
    if (kept) return kept;
    const ref = skill.item;
    return {
      id: skill.key,
      name: ref?.name ?? skill.key,
      domain: ref?.domain ?? "",
      domainCode: ref?.domainCode ?? "",
      number: ref?.number ?? "",
      code: ref?.code ?? "",
      cycle: ref?.cycle ?? "",
    };
  });
  const planned: CompetencyItem | null = write.delete
    ? null
    : {
        id: before?.id ?? stableId("competency", `${plannedDate !== null && plannedDate !== undefined ? legacySeconds(epochToWall(plannedDate)) : 0}|${resourcename}|${plannedTitle}`),
        title: plannedTitle,
        date: plannedDate,
        publication: plannedPublication,
        publicationParents: plannedPublication !== null && parentsDelay !== null
          ? plannedPublication + Math.round(parentsDelay * 86400)
          : before?.publicationParents ?? null,
        coefficient: write.coefficient ?? before?.coefficient ?? (existing ? null : 1),
        cycleReport: write.cycleReport ?? before?.cycleReport ?? true,
        subject,
        resourcename,
        type,
        serviceid,
        skills: plannedSkills,
        ratings: mergeRatings(before?.ratings ?? [], expandRatings(write.ratings ?? [], write.defaultLevel, students, resolved.map((s) => s.key))),
      };
  const common = { request, validated: false as const, parentsDelayDays: parentsDelay };
  if (write.dryRun) return { before, after: planned, written: false, dryRun: true, ...common };

  await sendWrite(session, "competencySave", request, write.force === true);
  const reread = listOf<Element>((await call(session, "competencyList", {
    service: ref(service),
    ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
    periode: ref(picked.period),
  }))?.listeEvaluations);
  const found = reread.map((evaluation) => item(evaluation)).find((parsed) => parsed.item.id === (planned?.id ?? before?.id));
  if (write.delete) {
    if (found) throw new HttpError(502, "assessment_not_deleted");
    return { before, after: null, written: true, dryRun: false, ...common };
  }
  if (!found) throw new HttpError(502, "assessment_not_saved");
  const evaluation = reread.find((candidate) => item(candidate).item.id === found.item.id)!;
  const afterPage = await call(session, "competencyPage", {
    evaluation: ref(evaluation),
    ...(evaluation.devoir?.V?.N ? { devoir: ref(evaluation.devoir.V) } : {}),
    ...(resourceRef ? { ressource: ref(resourceRef) } : {}),
    periodeEvaluation: ref(picked.period),
  });
  found.item.ratings = ratingsFromPage(afterPage, found.skillIds);
  return { before, after: found.item, written: true, dryRun: false, ...common };
};

/** Ratings as they should read after the write: requested levels replace the ones read. */
export const mergeRatings = (
  before: CompetencyItem["ratings"],
  changes: RatingChange[],
): CompetencyItem["ratings"] => {
  const result = before.map((item) => ({ ...item }));
  for (const change of changes) {
    const index = result.findIndex((item) => normalise(item.student) === normalise(change.student) && item.skill === change.skill);
    const next = { student: change.student, skill: change.skill, level: change.level, observation: change.published ? change.observation ?? "" : "" };
    if (index >= 0) result[index] = { ...result[index], ...next, student: result[index].student };
    else result.push(next);
  }
  return result;
};
