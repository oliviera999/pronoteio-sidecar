/**
 * Student files ("fiches élèves") of a class or group, read on demand (FicheEleve, tab 105).
 *
 * Moodle (local_olutionmcp) only asks for the students of the classes and groups taught by the account and checks
 * that perimeter before calling. This module returns ONLY the requested parts and never keeps anything:
 * - identity (always): names, sex, birth date, Pronote number, e-mail, class, groups, options, regime;
 * - "imagerights": image rights authorisation ("droit à l'image"), "unknown" when Pronote gives no answer;
 * - "guardians": legal guardians and contacts (AvecResponsables);
 * - "health": support plans (PAI, PAP...) and medical information, never sent otherwise;
 * - "photo": only whether a photo exists (the pictures are read by photos.ts);
 * - 0.12.0, "contact": address and mobile phone of the student; "school": delegate, commitments, exit authorisation,
 *   transport, locker, canteen number, support assistant (AESH), tutors, main teachers, pedagogical team and
 *   communication preferences; "memos": memos and "valorisations" of the student (ListeMemosEleves).
 * Attestations and every other member of the file are dropped here. Only the KEYS (never the values) of the
 * members that were not mapped are returned in "unmappedKeys", to validate the mapping on a real account.
 *
 * NOT VALIDATED: FicheEleve was never captured on a real account (docs/pronote-matrice/4-9-bulletins-divers.md). The
 * member names below are candidates read from the web client. 10/11/2026: the real answer wraps the student in a
 * typed value and a "Scolarite" object (see identityOf); the health check (/students/files/check) returns the shape
 * of one answer (member paths and types, no value) to finish the mapping without reading any student data.
 * 20/11/2026: the 32 keys left unmapped on a real class (CP, adresse1…4, listeRessources, listeEquipePeda, listePP,
 * telPort, indPort…) are mapped below from their names; their values were never seen. 0.12.1, first real read:
 * listeRessources holds the guardians, not the groups (see fileOf).
 */
import type { SessionHandle } from "pawnote";
import { ServerSideError, type SessionHandle as Session } from "pawnote";
import { HttpError, RateLimitedError } from "../errors.js";
import { listOf, parsePronoteDate } from "../pronote/encoding.js";
import { labelKey, normalise } from "../normalise.js";
import { userData } from "../pronote/userdata.js";
import { regimeSeen } from "./classlife.js";
import { callFunction, callFunctionAt, functions, isTabClosed } from "./functions.js";
import { loadPeriods, periodKey } from "./grades.js";
import { stableId, stableIds } from "./ids.js";
import { reportsPage } from "./reports.js";
import { SENSITIVE, shapeOf } from "./shape.js";
import { boolOf, dateOf, dayString, labelsOf, member, textOf, unwrap } from "./tolerant.js";
import { resolveResource, rosterEntries, studentKey, type RosterEntry } from "./roster.js";

export const INCLUDE_VALUES = ["imagerights", "guardians", "health", "photo", "contact", "school", "memos", "groups"] as const;
export type Include = (typeof INCLUDE_VALUES)[number];

/** Largest number of files read in one request (one Pronote call per student). */
export const MAX_FILES = 40;

export type ImageRights = "authorized" | "refused" | "unknown";

export type PhoneKind = "mobile" | "home" | "work" | "other";

export type Guardian = {
  name: string;
  relation: string;
  legal: boolean | null;
  /** Numbers with their international prefix when Pronote gives it ("+212 600000001"). */
  phones: string[];
  email: string;
  address: string;
  preferences: string[];
  /** 0.12.0: position in the list of guardians (1 first), parental authority, letters, SMS and e-mails accepted. */
  order: number;
  authority: boolean | null;
  mail: boolean | null;
  sms: boolean | null;
  emailAllowed: boolean | null;
  phoneDetails: { type: PhoneKind; number: string }[];
  /**
   * 0.14.0 (members named by the real file of 20/11/2026, read as the web client shows them): level of responsibility
   * as Pronote words it ("Responsable légal", "En charge", "Contact"; "" when not understood), parent delegate of a
   * class, member of the school board, emergency contact, and why "email" is empty ("not_in_file").
   */
  responsibility: string;
  classDelegate: boolean | null;
  boardMember: boolean | null;
  emergency: boolean | null;
  emailReason: string;
};

export type GroupKind = "class" | "speciality" | "language" | "option" | "group";

/**
 * Where a group or option of a student comes from (0.14.0): "file" a member of the file, "team" a subject of the
 * pedagogical team whose label names a speciality, a language or an option, "rosters" the list of students of a group
 * of the session, "reportcard" the group of a service of the report card.
 */
export type GroupSource = "file" | "team" | "rosters" | "reportcard";

export type StudentContact = { address: string; postcode: string; city: string; country: string; mobile: string };

export type StudentSchool = {
  delegate: boolean | null;
  commitments: string[];
  exitAuthorisation: string;
  transport: boolean | null;
  locker: string;
  canteen: string;
  aesh: string;
  tutors: string[];
  mainTeachers: string[];
  team: { subject: string; teachers: string[] }[];
  communication: { email: boolean | null; sms: boolean | null; mail: boolean | null; discussion: boolean | null };
};

export type PlanType = "PAI" | "PAP" | "PPS" | "PPRE" | "accommodation" | "other";

export type HealthPlan = {
  type: PlanType;
  label: string;
  title: string;
  /** "YYYY-MM-DD", "" when unknown. */
  start: string;
  end: string;
  comment: string;
  accommodations: string[];
  examAccommodations: boolean;
  documents: { name: string }[];
};

export type StudentMemo = { date: string; text: string; author: string; published: boolean | null; kind: "memo" | "valorisation" };

export type StudentFile = {
  id: string;
  /** Opaque key of the Pronote student (see roster.ts studentKey): tells two homonyms apart. */
  key: string;
  label: string;
  lastname: string;
  firstname: string;
  sex: "F" | "M" | "";
  birthdate: number | null;
  number: string;
  email: string;
  class: string;
  groups: string[];
  options: string[];
  regime: string;
  /** 0.12.0: town of birth, adult flag, classes and groups of the student with their kind (guessed from the label). */
  birthplace: string;
  adult: boolean | null;
  groupDetails: { label: string; kind: GroupKind; source: GroupSource }[];
  /** 0.14.0: why groups and options are empty ("" when something was found): never a guessed label. */
  groupsReason: string;
  /** 0.14.0: where "regime" comes from ("file", "callsheets"), and why it is empty ("not_in_file"). */
  regimeSource: "" | "file" | "callsheets";
  regimeReason: string;
  /** 0.14.0: why "memos" is empty ("" when some came back, or when none exists): access_denied, format_unknown. */
  memosReason?: string;
  imageRights?: ImageRights;
  guardians?: Guardian[];
  health?: { plans: string[]; medical: string[]; allergies: string[]; planDetails: HealthPlan[] };
  photo?: { exists: boolean };
  contact?: StudentContact;
  school?: StudentSchool;
  memos?: StudentMemo[];
};

export type StudentFilesResult = {
  available: boolean;
  reason: string;
  validated: false;
  items: StudentFile[];
  unmappedKeys: string[];
  /** 0.12.0: names (never values) of the members of the guardians that were not mapped. */
  unmappedGuardianKeys: string[];
  truncated: boolean;
  /** Students of the class or group (roster), whatever the page read. */
  total: number;
  /** First student read (position in the roster). */
  offset: number;
};

/** Page of a student files request: offset in the roster and number of files read (MAX_FILES at most). */
export type FilesPage = { offset?: number; limit?: number };

/** Text of a string, a number, a typed value or an element (tolerant.ts textOf). */
const text = textOf;

const labels = (value: unknown): string[] => listOf<any>(value).map((item) => text(item)).filter(Boolean);

const isPlain = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Sub-objects whose members are identity members. 10/11/2026, real account: the answer wraps the student in a typed
 * value ({ _T, V: {...} }) and puts schooling members in "Scolarite"; only "Scolarite", "V", "_T" and two lists were
 * seen at the first level, so sex and birth date stayed empty.
 */
const CONTAINERS = new Set(["eleve", "identite", "ficheeleve", "scolarite", "etatcivil", "infosperso", "informationspersonnelles"]);

/**
 * Identity members: the members of the answer object, of its typed values (V) and of its known sub-objects, flattened
 * (depth 4 at most). The containers themselves and the type codes (_T) are never members.
 */
const identityOf = (data: Record<string, any>): Record<string, any> => {
  const merged: Record<string, any> = {};
  const visit = (source: unknown, depth: number) => {
    if (!isPlain(source) || depth > 4) return;
    for (const [key, value] of Object.entries(source)) {
      if (key === "_T") continue;
      if (key === "V") {
        visit(value, depth + 1);
        continue;
      }
      if (CONTAINERS.has(key.toLowerCase()) && isPlain(value)) {
        visit(value, depth + 1);
        continue;
      }
      merged[key] = value;
    }
  };
  visit(data, 0);
  return merged;
};

export { MAX_SHAPE, MAX_SHAPE_FULL, SENSITIVE, shapeOf } from "./shape.js";

/** First member present among candidate names, compared without case. */
const pick = (object: Record<string, any>, names: string[], used: Set<string>): unknown => {
  const keys = Object.keys(object);
  for (const name of names) {
    const key = keys.find((item) => item.toLowerCase() === name.toLowerCase());
    if (key !== undefined && object[key] !== undefined && object[key] !== null) {
      used.add(key);
      return object[key];
    }
  }
  return undefined;
};

/** Sex from a label ("Féminin", "Garçon", "Mme"...); a boolean is read as "estMasculin". */
export const sexOf = (value: unknown): "F" | "M" | "" => {
  if (typeof value === "boolean") return value ? "M" : "F";
  const label = normalise(text(value)).replace(/\.$/, "");
  if (["f", "feminin", "fille", "femme", "mme", "mlle", "madame", "mademoiselle"].includes(label)) return "F";
  if (["m", "masculin", "garcon", "homme", "monsieur"].includes(label)) return "M";
  return "";
};

/**
 * Sex from a Pronote code. 11/11/2026, real account (plan_profile_fields dryrun on a class): the code is 1 for the
 * girls and 0 for the boys, the opposite of the INSEE code (1 = male) read until then: every girl came out "Garçon"
 * and no boy was recognised. 1 or true = F, 0 or false = M, otherwise a label.
 */
export const sexCode = (value: unknown): "F" | "M" | "" => {
  if (typeof value === "boolean") return value ? "F" : "M";
  const raw = text(value);
  if (raw === "1") return "F";
  if (raw === "0") return "M";
  return sexOf(value);
};

/** Sex from the members of an identity: explicit flags first, then the coded members, then the civil title. */
const sexFrom = (identity: Record<string, any>, used: Set<string>): "F" | "M" | "" => {
  const feminine = pick(identity, ["estFeminin", "estFille"], used);
  if (typeof feminine === "boolean") return feminine ? "F" : "M";
  const masculine = pick(identity, ["estMasculin"], used);
  if (typeof masculine === "boolean") return masculine ? "M" : "F";
  const coded = pick(identity, ["Sexe", "genreSexe", "sexeEleve", "civilite"], used);
  return coded === undefined ? "" : sexCode(coded);
};

/**
 * Image rights: a boolean member whose name speaks of photo or image and of authorisation, consent or broadcasting
 * (e.g. autorisePhoto, accordDiffusionPhoto, droitImage), or a labelled value ("Autorisé", "Refusé").
 */
export const imageRightsOf = (object: Record<string, any>, used: Set<string>): ImageRights => {
  for (const [key, value] of Object.entries(object)) {
    const name = normalise(key);
    if (!/(photo|image)/.test(name) || !/(autoris|accord|diffus|droit|consent)/.test(name)) continue;
    used.add(key);
    if (typeof value === "boolean") return value ? "authorized" : "refused";
    const label = normalise(text(value));
    if (/^(oui|autorise|accorde|true|1)/.test(label)) return "authorized";
    if (/^(non|refuse|interdit|false|0)/.test(label)) return "refused";
  }
  return "unknown";
};

/** Number with its international prefix: ("212", "600000001") gives "+212 600000001". */
export const phoneNumber = (prefix: string, number: string): string => {
  const digits = prefix.replace(/^\+/, "").trim();
  return number === "" ? "" : digits === "" || number.startsWith("+") ? number : `+${digits} ${number}`;
};

const PHONES: { type: PhoneKind; numbers: string[]; prefixes: string[] }[] = [
  { type: "mobile", numbers: ["telPort", "telephonePortable", "telPortable", "portable"], prefixes: ["indPort", "indicatifPortable", "indicatifTel"] },
  { type: "home", numbers: ["telFixe", "telephoneFixe", "telDomicile", "telephoneDomicile", "telephone"], prefixes: ["indFixe", "indicatifFixe", "indDomicile"] },
  { type: "work", numbers: ["telPro", "telephoneProfessionnel", "telBureau", "telTravail"], prefixes: ["indPro", "indicatifPro", "indBureau", "indTravail"] },
  { type: "other", numbers: ["telAutre", "autreTelephone"], prefixes: ["indAutre"] },
];

const phonesOf = (item: Record<string, any>, used: Set<string>): { type: PhoneKind; number: string }[] => {
  const result: { type: PhoneKind; number: string }[] = [];
  for (const phone of PHONES) {
    const prefix = text(pick(item, phone.prefixes, used));
    for (const name of phone.numbers) {
      const number = phoneNumber(prefix, text(pick(item, [name], used)));
      if (number !== "" && !result.some((entry) => entry.number === number)) result.push({ type: phone.type, number });
    }
  }
  return result;
};

const addressOf = (item: Record<string, any>, used: Set<string>): StudentContact => ({
  address: ["adresse1", "adresse2", "adresse3", "adresse4"].map((name) => text(pick(item, [name], used))).filter(Boolean).join(", ")
    || text(pick(item, ["adresse"], used)),
  postcode: text(pick(item, ["CP", "codePostal"], used)),
  city: text(pick(item, ["ville"], used)),
  country: text(pick(item, ["pays"], used)),
  mobile: "",
});

/** Levels of responsibility of a guardian (TypeGenreNiveauResponsabilite of the web client). */
const RESPONSIBILITY: Record<number, string> = { 1: "Responsable légal", 2: "En charge", 3: "Contact" };

/**
 * Level of responsibility of a guardian. Its value was never seen: the web client prints it as a label, the public
 * lists carry it as a genre (0 none, 1 legal, 2 in charge, 3 contact). A label, a number or { G, L } are read; "legal"
 * is null when the value is not understood.
 */
export const responsibilityOf = (value: unknown): { label: string; legal: boolean | null } => {
  const raw = unwrap(value);
  const code = typeof raw === "number" ? raw : isPlain(raw) && typeof raw.G === "number" ? raw.G : /^\d+$/.test(text(raw)) ? Number(text(raw)) : null;
  const written = code !== null && !isPlain(raw) ? "" : text(raw);
  const label = written || (code !== null ? RESPONSIBILITY[code] ?? "" : "");
  const key = labelKey(label);
  if (code === 1 || /legal/.test(key)) return { label, legal: true };
  if ((code !== null && code in { 0: 1, 2: 1, 3: 1 }) || /charge|contact|aucun/.test(key)) return { label, legal: false };
  return { label, legal: null };
};

/** Guardian of a FicheEleve answer with the names of its members that were not read. */
export const guardianRead = (value: unknown, index = 0): { guardian: Guardian; unused: string[] } => {
  const item = (unwrap(value) ?? {}) as Record<string, any>;
  const used = new Set<string>(["N", "G", "P", "_T"]);
  const phoneDetails = phonesOf(item, used);
  const legal = pick(item, ["estResponsableLegal", "responsableLegal", "estLegal"], used);
  const preferences: string[] = [];
  for (const [key, flag] of Object.entries(item)) {
    if (/^(accepte|autorise|recoit|souhaite)/i.test(key)) {
      used.add(key);
      if (flag === true) preferences.push(key);
    }
  }
  const contact = addressOf(item, used);
  const order = Number(pick(item, ["ordre", "rang", "numeroOrdre"], used));
  const responsibility = responsibilityOf(pick(item, ["niveauResponsabilite"], used));
  const authority = boolOf(pick(item, ["avecAutoriteParentale", "autoriteParentale", "aAutoriteParentale", "detientAutoriteParentale"], used));
  const delegate = pick(item, ["delegueClasse"], used);
  const email = text(pick(item, ["email", "eMail", "adresseEmail", "mail", "courriel"], used));
  const guardian: Guardian = {
    name: text(pick(item, ["L", "nom", "Nom"], used)),
    relation: text(pick(item, ["lienParente", "lien", "parente", "Lien"], used)),
    legal: typeof legal === "boolean" ? legal : responsibility.legal,
    phones: phoneDetails.map((entry) => entry.number),
    email,
    address: [contact.address, contact.postcode, contact.city].filter(Boolean).join(" "),
    preferences,
    order: Number.isFinite(order) && order > 0 ? order : index + 1,
    // Without a member of its own, the parental authority follows the level of responsibility (legal or not).
    authority: authority ?? responsibility.legal,
    mail: boolOf(member(item, ["autoriseCourrier", "recoitCourrier", "accepteCourrier", "destinataireCourrier"])),
    sms: boolOf(member(item, ["autoriseSMS", "accepteSMS", "recoitSMS"])),
    emailAllowed: boolOf(member(item, ["autoriseEmail", "accepteEmail", "recoitEmail"])),
    phoneDetails,
    responsibility: responsibility.label,
    // The web client prints the class the guardian is delegate of: any text is a yes.
    classDelegate: delegate === undefined ? null : (boolOf(delegate) ?? text(delegate) !== ""),
    boardMember: boolOf(pick(item, ["membreCA"], used)),
    emergency: boolOf(pick(item, ["contactUrgence"], used)),
    emailReason: email === "" ? "not_in_file" : "",
  };
  // Known and never returned: other names of the guardian, its job and work situation (unrelated to the follow-up of
  // the student), display colours, and the pick-up authorisation of primary schools.
  for (const name of ["nom", "Nom", "prenoms", "prenom", "civilite", "profession", "situation", "couleurPanel", "couleurStr",
    "autoriseRecupererEnfant"]) pick(item, [name], used);
  return { guardian, unused: Object.keys(item).filter((key) => !used.has(key) && !SENSITIVE.test(key)) };
};

export const guardianOf = (item: any, index = 0): Guardian => guardianRead(item, index).guardian;

/**
 * Kind of a class or group of a student, guessed from its Pronote label: "T-SPE SVT 2" is a speciality, "TLVB ESP 3" a
 * language, "T-OPT MATHS EXP" an option. A heuristic: the label itself is always returned beside it.
 */
export const groupKind = (label: string, genre?: unknown): GroupKind => {
  if (genre === 1) return "class";
  const key = labelKey(label);
  const tokens = key.split(" ");
  if (tokens.some((token) => ["spe", "specialite", "eds", "llce", "llcer", "hggsp", "hlp", "nsi", "ses"].includes(token))) return "speciality";
  if (tokens.some((token) => /^(t|1|2)?lv[abc123]?$/.test(token)
    || ["ang", "anglais", "esp", "espagnol", "all", "allemand", "ara", "arabe", "ita", "italien", "chi", "chinois", "osib"].includes(token))) {
    return "language";
  }
  if (tokens.some((token) => ["opt", "option", "latin", "grec", "lca", "mexp", "mcomp", "dgemc", "dnl", "euro"].includes(token))
    || /maths? (exp|comp)/.test(key)) {
    return "option";
  }
  return "group";
};

/** Kind of a support plan from its Pronote label ("PAI.", "PAP", "AMENAGTS EXAMS", "AMENAGT EPS"…). */
export const planType = (label: string): PlanType => {
  const key = labelKey(label);
  const tokens = key.split(" ");
  if (tokens.includes("pai")) return "PAI";
  if (tokens.includes("pap")) return "PAP";
  if (tokens.includes("pps")) return "PPS";
  if (tokens.includes("ppre")) return "PPRE";
  if (/amenag/.test(key)) return "accommodation";
  return "other";
};

const planOf = (value: unknown): HealthPlan => {
  const item = unwrap(value);
  const label = textOf(item);
  return {
    type: planType(label),
    label,
    title: textOf(member(item, ["intitule", "libelle", "titre", "motif", "nom"])),
    start: dayString(dateOf(member(item, ["dateDebut", "debut"]))),
    end: dayString(dateOf(member(item, ["dateFin", "fin"]))),
    comment: textOf(member(item, ["commentaire", "description", "detail"])),
    accommodations: labelsOf(member(item, ["listeAmenagements", "amenagements", "listeMesures"])),
    examAccommodations: /exam/.test(labelKey(label)) || boolOf(member(item, ["avecAmenagementsExamen", "amenagementExamen", "pourExamens"])) === true,
    documents: listOf<unknown>(member(item, ["listeDocuments", "documents", "listePiecesJointes", "listeFichiers"]))
      .map((document) => ({ name: textOf(document) })).filter((document) => document.name !== ""),
  };
};

/** Pedagogical team of a student: one entry per subject with its teachers (listeEquipePeda). */
export const teamOf = (value: unknown): { subject: string; teachers: string[] }[] => {
  const bySubject = new Map<string, string[]>();
  const add = (subject: string, teachers: string[]) => {
    const list = bySubject.get(subject) ?? [];
    for (const teacher of teachers) if (teacher !== "" && !list.includes(teacher)) list.push(teacher);
    bySubject.set(subject, list);
  };
  for (const raw of listOf<unknown>(value)) {
    const item = unwrap(raw);
    const teachers = labelsOf(member(item, ["listeProfesseurs", "professeurs", "professeur"]));
    const subjects = [...labelsOf(member(item, ["listeMatieres", "matieres"])), textOf(member(item, ["matiere", "strMatiere", "discipline"]))].filter(Boolean);
    // An entry naming its teachers is a subject; otherwise it is a person, with the subject(s) taught.
    if (teachers.length > 0) add(textOf(item), teachers);
    else if (subjects.length > 0) subjects.forEach((subject) => add(subject, [textOf(item)]));
    else add("", [textOf(item)]);
  }
  return [...bySubject.entries()].map(([subject, teachers]) => ({ subject, teachers })).filter((entry) => entry.teachers.length > 0);
};

export const MEMO_LISTS = ["listeMemos", "listeMemosEleves", "listeValorisations", "memos"];

/** Memos of a ListeMemosEleves answer (or of the list embedded in the file). */
export const memosFrom = (data: unknown, kind: StudentMemo["kind"]): StudentMemo[] =>
  listOf<unknown>(Array.isArray(unwrap(data)) ? data : member(data, MEMO_LISTS))
    .map((raw) => {
      const item = unwrap(raw);
      return {
        date: dayString(dateOf(member(item, ["date", "dateCreation"]))),
        text: textOf(member(item, ["commentaire", "texte"])) || textOf(item),
        author: textOf(member(item, ["auteur", "demandeur", "strAuteur", "individu"])),
        published: boolOf(member(item, ["publie", "estPubliee", "estPublie"])),
        kind,
      };
    })
    .filter((memo) => memo.text !== "");

/** Normalised file of one FicheEleve answer ("data" member), with only the requested parts. */
export const fileOf = (
  entry: RosterEntry,
  data: Record<string, any>,
  include: Include[],
): { file: StudentFile; unmapped: string[]; unmappedGuardian: string[] } => {
  const identity = identityOf(data);
  // L and P (label and position of the student) and the setting nombreJoursSelectionnables carry nothing to return.
  const used = new Set<string>(["N", "G", "L", "P", "Eleve", "eleve", "Identite", "identite", "ficheEleve", "nombreJoursSelectionnables"]);
  const [lastnameLabel, ...firstnames] = entry.label.split(" ");
  const lastname = text(pick(identity, ["Nom", "nom"], used)) || lastnameLabel;
  const firstname = text(pick(identity, ["Prenoms", "prenoms", "Prenom", "prenom"], used)) || firstnames.join(" ");
  const birth = parsePronoteDate(text(pick(identity, ["DateNaissance", "dateDeNaissance", "dateNaiss", "naissance"], used)));
  // 0.12.1: listeRessources is NOT the classes and groups of the student. 20/11/2026, first real read: it lists the
  // guardians of the student, so their names came out in "groups", even without the "guardians" part. It is a known
  // member (never reported as unmapped) and nothing of it is ever read: guardians come from listeResponsables, on
  // request only.
  used.add("listeRessources");
  // Groups: only the members that name them (shapes never seen on a real account); none on the file read so far.
  const groups = [...new Set(labels(pick(identity, ["listeGroupes", "groupes", "ListeGroupes"], used)))];
  const groupDetails: StudentFile["groupDetails"] = groups.map((label) => ({ label, kind: groupKind(label), source: "file" as const }));
  // Options: a list of elements, or the text the web client prints as it is ("LATIN, SECTION EURO").
  const rawOptions = pick(identity, ["listeOptions", "options", "ListeOptions"], used);
  const writtenOptions = typeof unwrap(rawOptions) === "string" ? text(rawOptions).split(/\s*[,;\n]\s*/).filter(Boolean) : labels(rawOptions);
  for (const label of writtenOptions) {
    if (!groupDetails.some((item) => item.label === label)) groupDetails.push({ label, kind: "option", source: "file" });
  }
  // 0.14.0: the subjects of the pedagogical team whose label names a speciality, a language or an option.
  const team = teamOf(pick(identity, ["listeEquipePeda", "equipePedagogique"], used));
  for (const entry of team) {
    const kind = entry.subject === "" ? "group" : groupKind(entry.subject);
    if (kind !== "group" && !groupDetails.some((item) => item.label === entry.subject)) groupDetails.push({ label: entry.subject, kind, source: "team" });
  }
  const options = [...new Set([...writtenOptions,
    ...groupDetails.filter((item) => ["speciality", "language", "option"].includes(item.kind)).map((item) => item.label)])];
  const regime = text(pick(identity, ["regime", "Regime", "regimeEleve", "libelleRegime"], used));
  const file: StudentFile = {
    id: entry.id,
    key: studentKey(entry.pronoteId),
    label: entry.label,
    lastname,
    firstname,
    sex: sexFrom(identity, used),
    // Date sans heure : minuit UTC du jour Pronote. 13/11/2026 : minuit heure du serveur (en avance sur UTC) tombait la
    // veille en UTC, et Moodle reportait la date de naissance avec un jour de moins.
    birthdate: birth ? Date.UTC(birth.getFullYear(), birth.getMonth(), birth.getDate()) / 1000 : null,
    number: text(pick(identity, ["numeroEleve", "Numero", "numero", "numeroNational", "ine", "INE"], used)),
    email: text(pick(identity, ["email", "eMail", "adresseEmail", "mail", "courriel"], used)),
    class: text(pick(identity, ["classe", "Classe"], used)),
    groups,
    options,
    regime,
    birthplace: text(pick(identity, ["villeNaiss", "villeNaissance", "lieuNaissance"], used)),
    adult: boolOf(pick(identity, ["estMajeur", "majeur"], used)),
    groupDetails,
    groupsReason: groupDetails.length === 0 ? "no_source" : "",
    regimeSource: regime === "" ? "" : "file",
    regimeReason: regime === "" ? "not_in_file" : "",
  };
  // Known members are always marked as used (their names are not "unmapped"); their values only leave on request.
  const imageRights = imageRightsOf(identity, used);
  const guardians = pick(identity, ["listeResponsables", "ListeResponsables", "responsables"], used);
  if (include.includes("imagerights")) file.imageRights = imageRights;
  const guardianReads = listOf<any>(guardians).map((item, index) => guardianRead(item, index));
  if (include.includes("guardians")) file.guardians = guardianReads.map((item) => item.guardian);

  // Contact of the student: address and mobile phone.
  const contact = addressOf(identity, used);
  contact.mobile = phoneNumber(text(pick(identity, ["indPort", "indicatifPortable"], used)), text(pick(identity, ["telPort", "telephonePortable", "telPortable"], used)));
  if (include.includes("contact")) file.contact = contact;

  // Schooling: delegate, commitments, authorisations, transport, locker, canteen, support assistant, tutors, teachers.
  const delegate = pick(identity, ["delegue", "estDelegue"], used);
  const delegateLabel = typeof unwrap(delegate) === "boolean" ? "" : text(delegate);
  const tutor = pick(identity, ["tuteur"], used);
  const school: StudentSchool = {
    delegate: delegate === undefined ? null : (boolOf(delegate) ?? delegateLabel !== ""),
    commitments: [...new Set([delegateLabel, ...labelsOf(pick(identity, ["engagements", "listeEngagements"], used))].filter(Boolean))],
    exitAuthorisation: ((value: unknown) => (typeof unwrap(value) === "boolean" ? (unwrap(value) ? "oui" : "non") : text(value)))(
      pick(identity, ["autorisationSortie"], used)),
    transport: boolOf(pick(identity, ["useTransport", "utiliseTransport"], used)),
    locker: text(pick(identity, ["numeroCasier", "casier"], used)),
    canteen: text(pick(identity, ["numeroSelf", "numeroCantine"], used)),
    aesh: ((value: unknown) => (unwrap(value) === true ? "oui" : labelsOf(value).join(", ")))(
      pick(identity, ["accompagnant", "listeAccompagnants", "AESH"], used)),
    tutors: [...new Set([...labelsOf(pick(identity, ["listeTuteurs"], used)), ...(typeof unwrap(tutor) === "boolean" ? [] : labelsOf(tutor))])],
    mainTeachers: [...new Set([...labelsOf(pick(identity, ["listePP"], used)), ...labelsOf(pick(identity, ["profPrincipal"], used))])],
    team,
    communication: {
      email: boolOf(pick(identity, ["autoriseEmail"], used)),
      sms: boolOf(pick(identity, ["autoriseSMS"], used)),
      mail: boolOf(pick(identity, ["autoriseCourrier"], used)),
      discussion: boolOf(pick(identity, ["autoriseDiscussion"], used)) ?? boolOf(member(identity, ["avecDiscussion"])),
    },
  };
  used.add("avecDiscussion");
  if (include.includes("school")) file.school = school;

  // Health members are always marked as used: their names never leave the sidecar, their values only on request.
  const plans = pick(identity, ["listeProjetsAccompagnement", "projetsAccompagnement", "ListeProjets"], used);
  const medical = pick(identity, ["infosMedicales", "informationsMedicales", "allergies", "listeAllergies", "regimeAlimentaire"], used);
  const allergies = member(identity, ["allergies", "listeAllergies"]);
  const embeddedMemos = member(identity, ["listeMemosEleves", "listeMemos", "memos"]);
  for (const key of Object.keys(identity)) {
    if (SENSITIVE.test(key)) used.add(key);
  }
  if (include.includes("health")) {
    file.health = {
      plans: labels(plans),
      medical: [...labels(medical), text(medical)].filter(Boolean),
      allergies: labelsOf(allergies),
      planDetails: listOf<unknown>(plans).map(planOf).filter((plan) => plan.label !== ""),
    };
  }
  if (include.includes("memos")) file.memos = memosFrom(embeddedMemos ?? [], "memo");
  const photo = pick(identity, ["existePhoto", "avecPhoto", "photo"], used);
  if (include.includes("photo")) file.photo = { exists: photo === true || (typeof photo === "object" && photo !== null) };
  const unmapped = Object.keys(identity).filter((key) => !used.has(key)).sort();
  return { file, unmapped, unmappedGuardian: [...new Set(guardianReads.flatMap((item) => item.unused))].sort() };
};

/** Requests tried for the memos of a student: the tab of the list of students, then the tabs of the pages that show them. */
export const MEMO_TABS = [105, 113, 78];
type MemoVariant = { onglet: number | null; member: "eleve" | "Eleve" };

/** Request that gave the memos of a session, or why none did: not tried again for every student. */
const memoRoutes = new WeakMap<Session, MemoVariant | { reason: string }>();

/** Forgets the memo request found for a session (tests). */
export const resetMemoRoute = (session: Session): void => {
  memoRoutes.delete(session);
};

const memoVariants = (): MemoVariant[] => {
  const tabs = [...new Set([functions.studentMemos.onglet, ...MEMO_TABS])];
  return tabs.flatMap((onglet) => (["eleve", "Eleve"] as const).map((member) => ({ onglet, member })));
};

/**
 * Memos and "valorisations" of one student (ListeMemosEleves; request read from the web client: { eleve,
 * estValorisation }, answer listeMemosEleves). First real check of 20/11/2026: an EMPTY answer with tab 105. 0.14.0: the
 * request is tried with "eleve" then "Eleve" (as FicheEleve) on tabs 105, 113 and 78; the first that answers is kept
 * for the session. Nothing answers: the memos the file itself carries, and the reason. The queue errors are thrown.
 */
export const readMemos = async (
  session: Session,
  entry: RosterEntry,
  embedded: StudentMemo[],
): Promise<{ memos: StudentMemo[]; reason: string }> => {
  const eleve = { N: entry.pronoteId, G: 4, L: entry.label };
  const ask = async (variant: MemoVariant, valorisation: boolean): Promise<Record<string, any> | string> => {
    try {
      const data = await callFunctionAt(session, "studentMemos", variant.onglet, { [variant.member]: eleve, estValorisation: valorisation });
      if (!data || Object.keys(data).length === 0) return "access_denied";
      return member(data, MEMO_LISTS) === undefined && !Array.isArray(unwrap(data)) ? "format_unknown" : data;
    } catch (error) {
      if (!(error instanceof ServerSideError)) throw error;
      return /droits|insuffisant/i.test(error.message) ? "access_denied" : "pronote_error";
    }
  };
  let route = memoRoutes.get(session);
  let first: Record<string, any> | null = null;
  if (route === undefined) {
    let reason = "access_denied";
    for (const variant of memoVariants()) {
      const answer = await ask(variant, false);
      if (typeof answer !== "string") {
        route = variant;
        first = answer;
        break;
      }
      if (answer === "format_unknown") reason = answer;
    }
    route = route ?? { reason };
    memoRoutes.set(session, route);
  }
  if ("reason" in route) return { memos: embedded, reason: embedded.length > 0 ? "" : route.reason };
  const memos: StudentMemo[] = [];
  for (const kind of ["memo", "valorisation"] as const) {
    const answer = kind === "memo" && first ? first : await ask(route, kind === "valorisation");
    if (typeof answer !== "string") memos.push(...memosFrom(answer, kind));
  }
  return { memos: memos.length > 0 ? memos : embedded, reason: "" };
};

/** One FicheEleve call (and the memos when asked) for a student of the roster. */
const readFile = async (session: Session, entry: RosterEntry, include: Include[]): Promise<ReturnType<typeof fileOf>> => {
  const data = await callFunction(session, "studentFile", {
    Eleve: { N: entry.pronoteId, G: 4, L: entry.label },
    AvecEleve: true,
    AvecResponsables: include.includes("guardians"),
  });
  const read = fileOf(entry, data, include);
  if (include.includes("memos")) {
    const memos = await readMemos(session, entry, read.file.memos ?? []);
    read.file.memos = memos.memos;
    read.file.memosReason = memos.reason;
  }
  // 0.14.0: no member of the real file carries the regime; an absence of a call sheet read in this session names it.
  if (read.file.regime === "") {
    const seen = regimeSeen(session, entry.id);
    if (seen !== "") Object.assign(read.file, { regime: seen, regimeSource: "callsheets", regimeReason: "" });
  }
  return read;
};

/* ---- 0.14.0: groups of a student from the lists of students of the groups of the session (include=groups) ---- */

/** Largest number of groups whose list of students is read for one request (one Pronote call each, kept 10 minutes). */
export const MAX_GROUP_ROSTERS = 30;
const GROUP_TTL_MS = 10 * 60_000;
const groupRosters = new WeakMap<Session, Map<string, { expires: number; members: Set<string> }>>();

/** Forgets the lists of students of the groups kept in memory (tests). */
export const resetGroupRosters = (session: Session): void => {
  groupRosters.delete(session);
};

/** Level of a class or group from its label: "t" (terminale) or the digit of the level ("T06", "1G3", "6-SC-601", "205"). */
export const levelOf = (label: string): string => {
  const key = labelKey(label).replace(/\s/g, "");
  if (/^(t|tle|term)/.test(key) && !/^(tr|te(?!rm))/.test(key)) return "t";
  const digit = key.match(/^([1-6])/);
  return digit ? digit[1] : "";
};

/**
 * Groups of the session each student of "entries" belongs to: the list of students of every group of the level of the
 * class is read (ListeEleves, the only function that answers for any group of the school) and kept 10 minutes. A group
 * whose list Pronote refuses is skipped. "complete" is false when the queue towards Pronote stopped the reading.
 */
export const groupsFromRosters = async (
  session: Session,
  className: string,
  entries: RosterEntry[],
): Promise<{ groups: Map<string, string[]>; complete: boolean; read: number }> => {
  const level = levelOf(className);
  const classKey = labelKey(className);
  const candidates = userData(session).resources
    .filter((item) => item.genre === 2 && (level !== "" ? levelOf(item.label) === level : classKey !== "" && labelKey(item.label).includes(classKey)))
    .slice(0, MAX_GROUP_ROSTERS);
  const cache = groupRosters.get(session) ?? new Map<string, { expires: number; members: Set<string> }>();
  groupRosters.set(session, cache);
  const groups = new Map<string, string[]>();
  let complete = true;
  let read = 0;
  for (const group of candidates) {
    let known = cache.get(group.label);
    if (!known || known.expires <= Date.now()) {
      try {
        const roster = await rosterEntries(session, stableId("group", group.label));
        known = { expires: Date.now() + GROUP_TTL_MS, members: new Set(roster.map((entry) => entry.pronoteId)) };
        cache.set(group.label, known);
      } catch (error) {
        if (error instanceof RateLimitedError) {
          complete = false;
          break;
        }
        if (!(error instanceof ServerSideError) && !(error instanceof HttpError && error.status === 404)) throw error;
        continue;
      }
    }
    read++;
    for (const entry of entries) {
      if (known.members.has(entry.pronoteId)) groups.set(entry.id, [...(groups.get(entry.id) ?? []), group.label]);
    }
  }
  return { groups, complete, read };
};

/**
 * Adds to the files of a page the groups found by other means than the file (include=groups): the lists of students
 * of the groups of the session, then, for a student still without group, the groups of the services of the report
 * card of the current period. Nothing found: the lists stay empty with "groupsReason", never a guessed label.
 */
const addGroups = async (session: Session, resourceId: string, selected: RosterEntry[], files: StudentFile[]): Promise<void> => {
  if (files.length === 0) return;
  const resource = resolveResource(session, resourceId);
  const className = resource.genre === 1 ? resource.label : (files[0].class || resource.label);
  const found = await groupsFromRosters(session, className, selected);
  const add = (file: StudentFile, label: string, source: GroupSource) => {
    if (label === "" || labelKey(label) === labelKey(className) || file.groupDetails.some((item) => item.label === label)) return;
    const kind = groupKind(label);
    file.groupDetails.push({ label, kind, source });
    if (!file.groups.includes(label)) file.groups.push(label);
    if (["speciality", "language", "option"].includes(kind) && !file.options.includes(label)) file.options.push(label);
  };
  for (const file of files) for (const label of found.groups.get(file.id) ?? []) add(file, label, "rosters");
  const without = files.filter((file) => file.groups.length === 0);
  if (without.length > 0 && resource.genre === 1) {
    try {
      const { periods, current } = await loadPeriods(session);
      const period = current ?? periods[0];
      if (period) {
        const periodId = stableIds("period", periods, periodKey)[periods.indexOf(period)];
        for (const file of without) {
          const page = await reportsPage(session, resourceId, periodId, { student: file.id });
          if (!page.available) break;
          for (const subject of page.items[0]?.subjects ?? []) add(file, subject.group, "reportcard");
        }
      }
    } catch (error) {
      if (error instanceof RateLimitedError) found.complete = false;
      else if (!(error instanceof ServerSideError)) throw error;
    }
  }
  for (const file of files) {
    file.groupsReason = file.groupDetails.length > 0 ? "" : found.complete ? "no_source" : "rate_limited";
  }
};

/**
 * Files of the students of a class or group (resource stable id), or of one of them (student stable id).
 * A closed tab or a refusal of Pronote is returned as available=false with the reason, never bypassed.
 */
export const studentFiles = async (
  session: SessionHandle,
  resource: string,
  include: Include[],
  student = "",
  page: FilesPage = {},
): Promise<StudentFilesResult> => {
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  const limit = Math.min(MAX_FILES, Math.max(1, Math.floor(page.limit ?? MAX_FILES)));
  const empty: StudentFilesResult = { available: false, reason: "", validated: false, items: [], unmappedKeys: [],
    unmappedGuardianKeys: [], truncated: false, total: 0, offset };
  if (isTabClosed(session, "studentFile")) return { ...empty, reason: "tab_closed:105" };
  let entries = await rosterEntries(session, resource);
  if (student !== "") {
    entries = entries.filter((entry) => entry.id === student);
    if (entries.length === 0) throw new HttpError(404, "student_not_found");
  }
  // One Pronote call per file read: only the requested page is read, so that a request stays short (a long request
  // may be delivered twice by the web server, see auth.ts registerAuth).
  const selected = entries.slice(offset, offset + limit);
  const truncated = page.limit === undefined && entries.length > offset + MAX_FILES;
  const items: StudentFile[] = [];
  const unmapped = new Set<string>();
  const unmappedGuardian = new Set<string>();
  for (const entry of selected) {
    let read: ReturnType<typeof fileOf>;
    try {
      read = await readFile(session, entry, include);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (items.length === 0) {
        return { ...empty, total: entries.length, reason: String((error as Error)?.message ?? error).slice(0, 300) };
      }
      throw error;
    }
    read.unmapped.forEach((key) => unmapped.add(key));
    read.unmappedGuardian.forEach((key) => unmappedGuardian.add(key));
    items.push(read.file);
  }
  if (include.includes("groups")) await addGroups(session, resource, selected, items);
  return { available: true, reason: "", validated: false, items, unmappedKeys: [...unmapped].sort(),
    unmappedGuardianKeys: [...unmappedGuardian].sort(), truncated, total: entries.length, offset };
};

/** Largest number of ids of a bulk request (students/files?ids=…). */
export const MAX_IDS = 200;

export type StudentFilesBulkResult = StudentFilesResult & {
  /** Ids read in this answer, in the order asked. */
  read: string[];
  /** Ids not read yet (deadline of the queue reached): ask them again after retry_after seconds. */
  remaining: string[];
  /** Ids not found in the class or group. */
  notFound: string[];
  /** Some ids remain to be read. */
  partial: boolean;
  /** Seconds to wait before asking the remaining ids (0 when complete). */
  retry_after: number;
};

/**
 * Files of a list of students of a class or group (P2, 0.9.0): the sidecar paces the FicheEleve calls itself (rate
 * limiter queue, bulk priority). When the queue cannot serve the next file before the deadline of the request, the
 * files read so far are returned with the remaining ids and retry_after, instead of a 429 for the whole request.
 */
export const studentFilesByIds = async (
  session: SessionHandle,
  resource: string,
  include: Include[],
  ids: string[],
): Promise<StudentFilesBulkResult> => {
  const wanted = [...new Set(ids)].slice(0, MAX_IDS);
  const base = { available: false, reason: "", validated: false as const, items: [] as StudentFile[], unmappedKeys: [] as string[],
    unmappedGuardianKeys: [] as string[], truncated: false, total: 0, offset: 0, read: [] as string[], remaining: [] as string[], notFound: [] as string[], partial: false,
    retry_after: 0 };
  if (isTabClosed(session, "studentFile")) return { ...base, reason: "tab_closed:105", remaining: wanted };
  const entries = await rosterEntries(session, resource);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const notFound = wanted.filter((id) => !byId.has(id));
  const todo = wanted.filter((id) => byId.has(id));
  const items: StudentFile[] = [];
  const read: string[] = [];
  const unmapped = new Set<string>();
  const unmappedGuardian = new Set<string>();
  let retryAfter = 0;
  for (const id of todo) {
    const entry = byId.get(id) as RosterEntry;
    let one: ReturnType<typeof fileOf>;
    try {
      one = await readFile(session, entry, include);
    } catch (error) {
      if (error instanceof RateLimitedError) {
        retryAfter = error.retryAfter;
        break;
      }
      if (error instanceof HttpError) throw error;
      if (items.length === 0) {
        return { ...base, total: entries.length, notFound, remaining: todo, reason: String((error as Error)?.message ?? error).slice(0, 300) };
      }
      throw error;
    }
    one.unmapped.forEach((key) => unmapped.add(key));
    one.unmappedGuardian.forEach((key) => unmappedGuardian.add(key));
    items.push(one.file);
    read.push(id);
  }
  const remaining = todo.filter((id) => !read.includes(id));
  if (remaining.length > 0 && read.length === 0) throw new RateLimitedError(retryAfter || 1);
  if (include.includes("groups")) await addGroups(session, resource, read.map((id) => byId.get(id) as RosterEntry), items);
  return { ...base, available: true, items, unmappedKeys: [...unmapped].sort(), unmappedGuardianKeys: [...unmappedGuardian].sort(),
    total: entries.length, read, remaining, notFound,
    partial: remaining.length > 0, retry_after: remaining.length > 0 ? Math.max(1, Math.ceil(retryAfter)) : 0 };
};

/**
 * Result of the student files check (get_pronote_health): never a value read from a file. "mapped" names the fields
 * filled from the file read, "shape" describes that answer (member paths and types only, see shapeOf).
 */
export type StudentFilesCheck = {
  available: boolean;
  reason: string;
  students: number;
  read: number;
  mappedKeys: number;
  mapped: string[];
  shape: string[];
};

/** Fields counted by the check. */
const CHECKED_FIELDS = ["lastname", "firstname", "sex", "birthdate", "number", "email", "class", "regime"] as const;

/**
 * Minimal read of the student files path for the health check: the roster of the class, then ONE FicheEleve call
 * (first student). Only counts, field names and the shape of the answer are returned: no identity, no value.
 */
export const checkStudentFiles = async (session: SessionHandle, resource: string): Promise<StudentFilesCheck> => {
  const none = { students: 0, read: 0, mappedKeys: 0, mapped: [], shape: [] };
  if (isTabClosed(session, "studentFile")) return { ...none, available: false, reason: "tab_closed:105" };
  const entries = await rosterEntries(session, resource);
  if (entries.length === 0) return { ...none, available: false, reason: "empty_roster" };
  const entry = entries[0];
  let data: Record<string, any>;
  try {
    data = await callFunction(session, "studentFile", { Eleve: { N: entry.pronoteId, G: 4, L: entry.label }, AvecEleve: true,
      AvecResponsables: false });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return { ...none, available: false, reason: String((error as Error)?.message ?? error).slice(0, 300), students: entries.length };
  }
  const { file } = fileOf(entry, data, []);
  const mapped = CHECKED_FIELDS.filter((key) => Boolean((file as Record<string, unknown>)[key]));
  return { available: true, reason: "", students: entries.length, read: 1, mappedKeys: mapped.length, mapped,
    shape: shapeOf(data) };
};
