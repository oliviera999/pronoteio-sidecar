/**
 * Report card comments ("appréciations") of the teacher's service for a class and a period, read only.
 *
 * NOT VALIDATED ON THE DEMO SERVER: tabs 25 and 27 are closed to its teacher profile (refusal verified). Shapes come
 * from the web client code (docs/pronote-matrice/4-9-bulletins-divers.md in mood_prod): PageApprBulletin
 * { ressource, periode, service } → listeLignes[] (eleve, appA/appB/appC, cloture), appreciationClasse,
 * strInfoCloture; for the main teacher, ListeAppreciations (kinds) then PageAppreciationsGenerales
 * { classe, periode, appreciation, estUneRubrique } → listeLignes[] (eleve, appreciationGle).
 */
import type { SessionHandle } from "pawnote";
import { HttpError } from "../errors.js";
import { listOf } from "../pronote/encoding.js";
import { userData } from "../pronote/userdata.js";
import type { ReportComments } from "../normalise.js";
import { isAccessDenied } from "./competencies.js";
import { call, loadServices, pickPeriod, ref, resourceOf, serviceKey, type Element } from "./grades.js";
import { kindOf, resolve, stableIds } from "./ids.js";

const GENRE_CLASS = 1;
const GENRE_GROUP = 2;
const GENRE_PERIOD = 2;

const text = (value: unknown): string | null => {
  const raw = value !== null && typeof value === "object" && "V" in (value as object) ? (value as { V: unknown }).V : value;
  if (raw !== null && typeof raw === "object") return text((raw as { L?: unknown }).L);
  return typeof raw === "string" ? raw : null;
};

/** Largest length of a report card comment (TailleMaxAppreciation[0], teacher's bulletin comment), null if unknown. */
export const maxLengthOf = (session: SessionHandle): number | null => {
  const raw = userData(session).maxCommentLength;
  const value = Array.isArray(raw) ? raw[0] : raw !== null && typeof raw === "object" ? (raw as { V?: unknown }).V : raw;
  const first = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(first ?? ""), 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 0 ? parsed : null;
};

/** Lines of a PageApprBulletin answer ("data" member): one per student, with the teacher's comment. */
export const commentsFromPage = (data: Record<string, any>): { students: { student: string; comment: string | null }[]; classComment: string | null; closed: boolean } => {
  const students = listOf<any>(data?.listeLignes)
    .filter((line) => line?.eleve)
    .map((line) => {
      const first = line.appA ?? line.appB ?? line.appC ?? null;
      return { student: String(line.eleve?.V?.L ?? line.eleve?.L ?? "").trim(), comment: text(first) };
    });
  const closed = String(data?.strInfoCloture ?? "").trim() !== ""
    || listOf<any>(data?.listeLignes).some((line) => line?.appA?.cloture === true || line?.appA?.V?.cloture === true);
  return { students, classComment: text(data?.appreciationClasse), closed };
};

/** General comments of the main teacher (PageAppreciationsGenerales answer): student → text. */
export const generalFromPage = (data: Record<string, any>): Map<string, string | null> =>
  new Map(
    listOf<any>(data?.listeLignes)
      .filter((line) => line?.eleve && line?.estPere !== true)
      .map((line) => [String(line.eleve?.V?.L ?? line.eleve?.L ?? "").trim(), text(line.appreciationGle)]),
  );

/* non validé sur la démo : onglets 25 et 27 fermés au profil de démonstration */
export const reportComments = async (session: SessionHandle, resourceId: string, periodId: string): Promise<ReportComments> => {
  const kind = kindOf(resourceId);
  if (kind !== "class" && kind !== "group") throw new HttpError(409, "resource_without_pronote_id");
  const genre = kind === "class" ? GENRE_CLASS : GENRE_GROUP;
  const resource = resolve(kind, resourceId, userData(session).resources.filter((item) => item.genre === genre), (item) => item.label);
  const picked = await pickPeriod(session, periodId);
  const services = await loadServices(session, picked.period);
  const index = services.findIndex((service) => String(resourceOf(service)?.L ?? "") === resource.label);
  if (index < 0) throw new HttpError(404, "service_not_found");
  const service = services[index];
  const serviceId = stableIds("service", services, serviceKey)[index];
  const result: ReportComments = {
    available: true,
    reason: "",
    class: { id: resourceId, name: resource.label },
    period: { id: picked.periodId, name: String(picked.period.L ?? "") },
    service: { id: serviceId, name: [service.matiere?.V?.L ?? service.L ?? "", resource.label].filter(Boolean).join(" - ") },
    closed: false,
    maxLength: maxLengthOf(session),
    classComment: null,
    students: [],
  };
  let page: Record<string, any>;
  try {
    page = await call(session, "commentsPage", {
      ressource: { N: resource.id, G: genre },
      periode: { N: picked.period.N, G: GENRE_PERIOD },
      service: { N: service.N },
    });
  } catch (error) {
    if (isAccessDenied(error)) return { ...result, available: false, reason: "access_denied" };
    throw error;
  }
  if (!page || Object.keys(page).length === 0) return { ...result, available: false, reason: "access_denied" };
  const read = commentsFromPage(page);
  result.closed = read.closed;
  result.classComment = read.classComment;
  let general = new Map<string, string | null>();
  if (resource.principal) {
    try {
      const kinds = listOf<Element>((await call(session, "commentKinds", {})).listeAppreciations);
      const rubric = kinds.find((item) => /globale/i.test(String(item.L ?? ""))) ?? kinds.find((item) => item.G === 0) ?? null;
      if (rubric) {
        general = generalFromPage(await call(session, "generalCommentsPage", {
          classe: { N: resource.id, G: GENRE_CLASS },
          periode: { N: picked.period.N, G: GENRE_PERIOD },
          appreciation: ref(rubric),
          estUneRubrique: false,
        }));
      }
    } catch (error) {
      if (!isAccessDenied(error)) throw error;
    }
  }
  result.students = read.students.map((line) => ({ ...line, general: general.get(line.student) ?? null }));
  return result;
};
