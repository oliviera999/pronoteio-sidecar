/**
 * Skills assessments ("évaluations par compétences") of the teacher's services, read only.
 *
 * NOT VALIDATED ON THE DEMO SERVER: its teacher profile does not open the skills tabs (65, 56) and Pronote refuses
 * the functions whatever the tab sent. Request and answer shapes come from the web client code (see
 * docs/pronote-matrice/2-3-notes-competences.md in mood_prod): ListeEvaluations { service, ressource, periode } →
 * listeEvaluations[], then PageCompetencesParEvaluation { evaluation, devoir, ressource, periodeEvaluation } →
 * ListeElevesCompetences[]. A refusal ("droits insuffisants") or an empty answer gives available: false.
 */
import { ServerSideError, type SessionHandle } from "pawnote";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import { matchesLabels, seconds, type CompetencyItem, type CompetencyOverview, type CompetencyRating } from "../normalise.js";
import { call, loadServices, pickPeriod, ref, resourceOf, type Element } from "./grades.js";
import { stableId, stableIds } from "./ids.js";

/** Largest number of assessments whose levels are read in one call. */
export const MAX_ITEMS = 30;

/** EGenreNiveauDAcquisition of the client, used when the school's list was not received at login. */
export const DEFAULT_LEVELS: { code: number; name: string }[] = [
  { code: 1, name: "Expert" },
  { code: 2, name: "Acquis" },
  { code: 3, name: "Presque acquis" },
  { code: 4, name: "En cours d'acquisition" },
  { code: 5, name: "Début d'acquisition" },
  { code: 6, name: "Non acquis" },
  { code: 7, name: "Absent" },
  { code: 8, name: "Non évalué" },
  { code: 9, name: "Dispensé" },
  { code: 10, name: "Non rendu" },
];

export const isAccessDenied = (error: unknown): boolean =>
  error instanceof ServerSideError && /droits|insuffisant/i.test(error.message);

/** Levels of the school (listeNiveauxDAcquisitions captured at login), else the client enumeration. */
export const levelsOf = (session: SessionHandle): { code: number; name: string }[] => {
  const raw = listOf<any>(userData(session).acquisitionLevels)
    .filter((item) => item && typeof item === "object" && typeof item.G === "number")
    .map((item) => ({ code: Number(item.G), name: String(item.L ?? "").trim() }));
  return raw.length ? raw : DEFAULT_LEVELS;
};

const text = (value: unknown): string => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  return typeof raw === "string" ? raw.trim() : "";
};

/** Levels given in one assessment (PageCompetencesParEvaluation answer, "data" member). */
export const ratingsFromPage = (data: Record<string, any>, skillIds: Map<string, string>): CompetencyRating[] => {
  const result: CompetencyRating[] = [];
  for (const student of listOf<any>(data?.ListeElevesCompetences)) {
    const label = String(student?.L ?? student?.eleve?.V?.L ?? "").trim();
    for (const item of listOf<any>(student?.ListeCompetences)) {
      const level = item?.NiveauDAcquisition?.V ?? item?.NiveauDAcquisition;
      const code = level && typeof level === "object" ? Number((level as { G?: unknown }).G) : Number(level);
      result.push({
        student: label,
        skill: skillIds.get(String(item?.N ?? "")) ?? String(item?.N ?? ""),
        level: Number.isFinite(code) && code > 0 ? code : null,
        observation: item?.ObservationPubliee === true ? text(item?.Observation) : "",
      });
    }
  }
  return result;
};

/** One assessment of ListeEvaluations, without its ratings. */
export const itemFromList = (
  evaluation: Element,
  subject: string,
  resourcename: string,
  type: "class" | "group",
): { item: CompetencyItem; skillIds: Map<string, string> } => {
  const date = parsePronoteDate(evaluation.dateValidation?.V ?? evaluation.date?.V);
  const publication = parsePronoteDate(evaluation.datePublication?.V);
  const title = String(evaluation.L ?? "").trim();
  const skills = listOf<any>(evaluation.listeCompetences);
  const skillIds = new Map<string, string>();
  const ids = stableIds("competency", skills, (skill) => `${String(skill?.L ?? "")}|${String(skill?.pilier?.V?.L ?? "")}`);
  skills.forEach((skill, index) => skillIds.set(String(skill?.relationESI?.V?.N ?? skill?.N ?? ""), ids[index]));
  return {
    skillIds,
    item: {
      id: stableId("competency", `${date ? seconds(date) : 0}|${resourcename}|${title}`),
      title,
      date: date ? seconds(date) : null,
      publication: publication ? seconds(publication) : null,
      subject,
      resourcename,
      type,
      skills: skills.map((skill, index) => ({
        id: ids[index],
        name: String(skill?.L ?? "").trim(),
        domain: String(skill?.pilier?.V?.L ?? "").trim(),
      })),
      ratings: [],
    },
  };
};

/* non validé sur la démo : onglets 65 et 56 fermés au profil de démonstration */
export const overview = async (session: SessionHandle, periodId = "", classes: string[] = []): Promise<CompetencyOverview> => {
  const picked = await pickPeriod(session, periodId);
  const base: CompetencyOverview = {
    available: true,
    reason: "",
    levels: levelsOf(session),
    period: { id: picked.periodId, name: String(picked.period.L ?? "") },
    items: [],
  };
  const services = await loadServices(session, picked.period);
  let total = 0;
  for (const service of services) {
    const resource = resourceOf(service);
    const resourcename = String(resource?.L ?? "");
    if (!matchesLabels([resourcename], classes)) continue;
    const type = userData(session).resources.find((item) => item.label === resourcename)?.genre === 2 ? "group" : "class";
    let list: Record<string, any>;
    try {
      list = await call(session, "competencyList", {
        service: ref(service),
        ...(resource ? { ressource: ref({ ...resource, G: type === "group" ? 2 : 1 }) } : {}),
        periode: ref(picked.period),
      });
    } catch (error) {
      if (isAccessDenied(error)) return { ...base, available: false, reason: "access_denied" };
      throw error;
    }
    if (!list || Object.keys(list).length === 0) return { ...base, available: false, reason: "access_denied" };
    const subject = String(service.matiere?.V?.L ?? service.L ?? "");
    for (const evaluation of listOf<Element>(list.listeEvaluations)) {
      if (total >= MAX_ITEMS) break;
      total++;
      const { item, skillIds } = itemFromList(evaluation, subject, resourcename, type);
      const page = await call(session, "competencyPage", {
        evaluation: ref(evaluation),
        ...(evaluation.devoir?.V?.N ? { devoir: ref(evaluation.devoir.V) } : {}),
        ...(resource ? { ressource: ref({ ...resource, G: type === "group" ? 2 : 1 }) } : {}),
        periodeEvaluation: ref(picked.period),
      });
      item.ratings = ratingsFromPage(page, skillIds);
      base.items.push(item);
    }
  }
  return base;
};
