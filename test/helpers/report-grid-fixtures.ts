/**
 * 0.17.0 (lot NS): answers of tab 25 in the shapes of the capture of the real server of 24/11/2026
 * (docs/pronoteio/capture-saisies-2026-11-24.md). Generated names ("ELEVE E01"), identifiers by their form only.
 * The member that carries the positioning of a line (niveauAcqu) is supposed: the capture names it only in the
 * RapportSaisie of SaisiePositionnement.
 */
import { rememberUserData } from "../../src/pronote/userdata.js";
import { fakeSession, type FakeCall } from "../fake-session.js";

type Handler = (data: Record<string, any> | undefined, call: FakeCall) => Record<string, any>;

export const T1 = { N: "105#t1", G: 2, L: "Trimestre 1", GenreNotation: 1, cloture: false, strInfoCloture: "" };
const T2 = { N: "105#t2", G: 2, L: "Trimestre 2", GenreNotation: 1, cloture: false, strInfoCloture: "" };
const T3 = { N: "105#t3", G: 2, L: "Trimestre 3", GenreNotation: 1, cloture: false, strInfoCloture: "" };
const BB1 = { N: "105#b1", G: 4, L: "BAC BLANC", GenreNotation: 0, cloture: false, strInfoCloture: "" };
const BB2 = { N: "105#b2", G: 4, L: "BAC BLANC 2", GenreNotation: 0, cloture: false, strInfoCloture: "" };
const CCF = { N: "105#cc", G: 4, L: "CCF", GenreNotation: 0, cloture: false, strInfoCloture: "" };

/** ListePeriodes of tab 25 for a lycée class: three trimesters, two bac blancs, a CCF; periodeParDefaut without G. */
export const lyceePeriods = { listePeriodes: { _T: 24, V: [T1, T2, T3, BB1, BB2, CCF] }, periodeParDefaut: { _T: 24, V: { N: "105#t1", L: "Trimestre 1" } } };

/** Semesters (a school organised by semesters). */
export const semesterPeriods = { listePeriodes: { _T: 24, V: [
  { N: "105#s1", G: 2, L: "Semestre 1", GenreNotation: 1, cloture: true, strInfoCloture: "Saisie close" },
  { N: "105#s2", G: 2, L: "Semestre 2", GenreNotation: 1, cloture: false, strInfoCloture: "" },
] }, periodeParDefaut: { _T: 24, V: { N: "105#s2", L: "Semestre 2" } } };

/** listeNiveaux of a 6e line (N "93#…"). */
export const levels = { _T: 24, V: [
  { N: "93#1", G: 1, L: "Très bonne maîtrise" },
  { N: "93#2", G: 2, L: "Maîtrise satisfaisante" },
  { N: "93#4", G: 4, L: "Maîtrise fragile" },
  { N: "93#6", G: 6, L: "Maîtrise insuffisante" },
  { N: "93#7", G: 7, L: "Absent" },
  { N: "93#8", G: 8, L: "Non évalué" },
  { N: "93#9", G: 9, L: "Dispensé" },
  { N: "93#10", G: 10, L: "Non rendu" },
] };

const classe603 = { N: "23#603", G: 1, L: "603" };
const classe604 = { N: "23#604", G: 1, L: "604" };

type LineState = { positioning?: number | null; lsu?: string; editable?: boolean; comment?: string };

const levelOf = (genre: number) => levels.V.find((item) => item.G === genre)!;

/** One line of the grid of a 6e group (columns Pos., N. LSU, App. A). */
export const sixthLine = (n: string, classe: { N: string; G: number; L: string }, state: LineState = {}) => ({
  eleve: { N: `46#${n}`, G: 4, L: `ELEVE ${n}` },
  classe,
  appA: state.comment ? { N: `10#${n}`, G: 1, L: state.comment, estEditable: true } : { G: 1, estEditable: true },
  typePositionnementClasse: 1,
  niveauAcquEditable: state.editable ?? true,
  noteLSUEditable: state.editable ?? true,
  noteLSU: { _T: 10, V: state.lsu ?? "" },
  ...(state.positioning ? { niveauAcqu: { ...levelOf(state.positioning) } } : {}),
  listeNiveaux: levels,
  listeNiveauxChronologique: { _T: 24, V: [] },
  listePiliers: { _T: 24, V: [] },
  nbEvals: 3,
});

/** PageApprBulletin of the group 6-SC-603 (two classes, one line not editable). */
export const sixthGrid = (states: Record<string, LineState> = {}, closed = "") => ({
  strInfoCloture: closed,
  listeLignes: { _T: 24, V: [
    sixthLine("E01", classe603, states.E01 ?? { positioning: 2, lsu: "15" }),
    sixthLine("E02", classe603, states.E02 ?? {}),
    sixthLine("E03", classe604, states.E03 ?? { editable: false }),
  ] },
});

/** PageApprBulletin of a lycée class: comments only, no Pos. nor N. LSU. */
export const lyceeGrid = {
  strInfoCloture: "",
  appreciationClasse: { G: 9, titre: "Classe", appreciation: "", editable: true, cloture: false },
  listeLignes: { _T: 24, V: [
    { eleve: { N: "46#L01", G: 4, L: "ELEVE L01" }, appA: { N: "10#a", G: 1, L: "Bon trimestre", estEditable: true } },
    { eleve: { N: "46#L02", G: 4, L: "ELEVE L02" }, appA: { G: 1, estEditable: true } },
  ] },
};

export const group = { id: "60#g603", label: "6-SC-603", genre: 2 as const, taught: true, principal: false };
export const classT06 = { id: "2#t06", label: "T06", genre: 1 as const, taught: true, principal: false };

/** Service of tab 25: "131#…" without G, with groupe (6e) or classe (lycée). */
export const sixthService = { N: "131#st", L: "SCIENCES ET TECHNOLOGIE", matiere: { _T: 24, V: { N: "9#st", L: "SCIENCES ET TECHNOLOGIE" } },
  groupe: { _T: 24, V: { N: "60#g603", G: 2, L: "6-SC-603" } } };
export const lyceeService = { N: "131#es", L: "ENSEIGNEMENT SCIENTIFIQUE", matiere: { _T: 24, V: { N: "9#es", L: "ENSEIGNEMENT SCIENTIFIQUE" } },
  classe: { _T: 24, V: { N: "2#t06", G: 1, L: "T06" } } };

/**
 * Fake session of a 6e teacher: tab 23 without service for the group (skills only), tab 25 with its service. The
 * writes answer the RapportSaisie of the capture; "writes" overrides them.
 */
export const gridSession = (options: { grid?: () => Record<string, any>; periods?: Record<string, any>; writes?: Record<string, Handler>; extra?: Record<string, Handler> } = {}) => {
  let state: Record<string, LineState> = {};
  const fake = fakeSession({
    "ListePeriodes@25": () => options.periods ?? lyceePeriods,
    ListePeriodes: () => ({ listePeriodes: { _T: 24, V: [T1, T2, T3] }, periodeParDefaut: { _T: 24, V: T1 } }),
    "ListeServices@25": (data) => ({ services: { _T: 24, V: data?.Ressource?.G === 2 ? [sixthService] : [lyceeService] } }),
    ListeServices: () => ({ services: { _T: 24, V: [{ ...lyceeService, N: "5#es" }] } }),
    PageApprBulletin: (data) => options.grid?.() ?? (data?.ressource?.G === 2 ? sixthGrid(state) : lyceeGrid),
    SaisiePositionnement: (data) => {
      const genre = Number(data?.positionnement?.G ?? 0);
      const n = String(data?.eleve?.N ?? "").replace("46#", "");
      state = { ...state, [n]: { ...(state[n] ?? defaults[n]), positioning: genre || null } };
      return { RapportSaisie: { service: data?.service, eleve: data?.eleve, ...(genre ? { niveauAcqu: { L: data?.positionnement?.L, N: data?.positionnement?.N, G: genre } } : {}) } };
    },
    SaisieNoteLSU: (data) => {
      const value = String(data?.posLSUNote?.V ?? "");
      const n = String(data?.eleve?.N ?? "").replace("46#", "");
      const shown = value === "" ? "" : String(Number(value.replace(",", ".")));
      state = { ...state, [n]: { ...(state[n] ?? defaults[n]), lsu: shown } };
      return { RapportSaisie: { service: data?.service, eleve: data?.eleve, posLSUNote: { _T: 10, V: shown } } };
    },
    ...options.writes,
    ...options.extra,
  });
  const defaults: Record<string, LineState> = { E01: { positioning: 2, lsu: "15" }, E02: {}, E03: { editable: false } };
  state = { ...defaults };
  rememberUserData(fake, { resources: [group, classT06] });
  return fake;
};
