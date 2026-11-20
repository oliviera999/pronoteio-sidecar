/**
 * Pronote of the skills pages, in memory, for the tests (0.13.0). Built from the code of the web client
 * (objetrequetesaisieevaluations.js, interfacepagelisteevaluations.js, objetfenetre_competences.js, parametres.js) and
 * from what the real server answered on 20/11/2026; NOT a capture. Names are generated.
 *
 * - ListeEvaluations signed with tab 56 answers the assessments of the service, class or group and period asked; signed
 *   with tab 65 it answers EVERY assessment of the teacher, whatever is asked (case of 20/11/2026).
 * - SaisieEvaluations is accepted on tab 56 only (on tab 65 it answers an empty "data" and changes nothing). A creation
 *   needs a title, a date, a publication date, a service, a class and skills that are elements of the referential, each
 *   with a new relation (state E 1) and the cycle of its domain; anything else is ignored silently, as a real server
 *   does. Levels sent together with a creation are dropped (the client never sends them). The created identifier comes
 *   back in RapportSaisie.listeEvaluationsCreees.
 * - A level is stored only when its element is one of the school's levels ({N, G}) and the school uses it in assessments.
 */
import { rememberUserData } from "../../src/pronote/userdata.js";
import { fakeSession, type FakeCall } from "../fake-session.js";

type Level = { N: string; G: number; L: string; abbreviation?: string; couleur?: string; actifPour: { _T: 26; V: string }; ponderation?: { _T: 10; V: string } };

/** School with the four LSU levels enabled out of the six of Pronote (genres 1, 2, 4, 6), and the four annotations. */
export const SCHOOL_LEVELS: Level[] = [
  { N: "16#aucun", G: 0, L: "", actifPour: { _T: 26, V: "[0,1]" } } as unknown as Level,
  { N: "16#n1", G: 1, L: "Très bonne maîtrise", abbreviation: "V+", couleur: "#00B050", actifPour: { _T: 26, V: "[0,1]" }, ponderation: { _T: 10, V: "50" } },
  { N: "16#n2", G: 2, L: "Maîtrise satisfaisante", abbreviation: "V", couleur: "#92D050", actifPour: { _T: 26, V: "[0,1]" }, ponderation: { _T: 10, V: "40" } },
  { N: "16#n3", G: 3, L: "Presque acquis", abbreviation: "PA", couleur: "#FFFF00", actifPour: { _T: 26, V: "[]" }, ponderation: { _T: 10, V: "33" } },
  { N: "16#n4", G: 4, L: "Maîtrise fragile", abbreviation: "J", couleur: "#FFC000", actifPour: { _T: 26, V: "[0,1]" }, ponderation: { _T: 10, V: "25" } },
  { N: "16#n5", G: 5, L: "Début d'acquisition", abbreviation: "DA", couleur: "#FF6600", actifPour: { _T: 26, V: "[]" }, ponderation: { _T: 10, V: "18" } },
  { N: "16#n6", G: 6, L: "Maîtrise insuffisante", abbreviation: "R", couleur: "#FF0000", actifPour: { _T: 26, V: "[0,1]" }, ponderation: { _T: 10, V: "10" } },
  { N: "16#n7", G: 7, L: "Absent", abbreviation: "Abs", actifPour: { _T: 26, V: "[0]" } },
  { N: "16#n8", G: 8, L: "Non évalué", abbreviation: "NE", actifPour: { _T: 26, V: "[0]" } },
  { N: "16#n9", G: 9, L: "Dispensé", abbreviation: "Dsp", actifPour: { _T: 26, V: "[0]" } },
  { N: "16#n10", G: 10, L: "Non rendu", abbreviation: "NR", actifPour: { _T: 26, V: "[0]" } },
];

const period = { N: "11#t1", L: "Trimestre 1", G: 2 };
const palier = { N: "27#c3", G: 27, L: "Cycle 3" };
const pilierScience = { N: "90#scie", G: 90, L: "Sciences et technologie", code: "SCIE", palier: { _T: 24, V: palier } };
const pilierCommun = { N: "90#comp", G: 90, L: "Compétences transversales", code: "Comp", palier: { _T: 24, V: palier } };

/** Elements of the referential as ListePiliers gives them: a flat list per domain, each element with its parent. */
const referential = [
  { ...pilierScience, listeCompetences: { _T: 24, V: [
    { N: "24#e13", G: 24, L: "13 Pratiquer des démarches scientifiques" },
    { N: "25#i133", G: 25, L: "13.3 Proposer une hypothèse", pere: { _T: 24, V: { N: "24#e13" } } },
    { N: "25#i134", G: 25, L: "13.4 Interpréter un résultat, en tirer une conclusion", pere: { _T: 24, V: { N: "24#e13" } } },
  ] } },
  { ...pilierCommun, listeCompetences: { _T: 24, V: [
    { N: "24#e9", G: 24, L: "9 Organisation du travail personnel" },
    { N: "25#i91", G: 25, L: "9.1 Etre autonome, s'organiser et apprendre ses leçons", pere: { _T: 24, V: { N: "24#e9" } } },
  ] } },
];
const elements = new Map(referential.flatMap((pilier) => pilier.listeCompetences.V.map((item) => [item.N, { item, pilier }] as const)));

const groups = {
  "2#g12": { N: "2#g12", G: 2, L: "6-SC-601-602" },
  "2#g3": { N: "2#g3", G: 2, L: "6-SC-603" },
};
const services = [
  { N: "12#st12", G: 12, L: "SCIENCES ET TECHNOLOGIE", matiere: { _T: 24, V: { N: "9#st", L: "SCIENCES ET TECHNOLOGIE" } }, groupe: { _T: 24, V: groups["2#g12"] } },
  { N: "12#st3", G: 12, L: "SCIENCES ET TECHNOLOGIE", matiere: { _T: 24, V: { N: "9#st", L: "SCIENCES ET TECHNOLOGIE" } }, groupe: { _T: 24, V: groups["2#g3"] } },
];

const students = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ N: `4#${prefix}${index + 1}`, G: 4, L: `ELEVE${prefix.toUpperCase()}${String(index + 1).padStart(2, "0")} Prénom` }));
export const ROSTERS: Record<string, { N: string; G: number; L: string }[]> = { "2#g12": students("a", 19), "2#g3": students("b", 20) };

type StoredSkill = { N: string; G: number; L: string; relation: string; pilier: any };
type Stored = {
  N: string; L: string; service: string; classe: string; periode: string; date: string; publication: string;
  coefficient: number; cycle: boolean; descriptif: string; skills: StoredSkill[];
  /** student N → relation N → level N. */
  levels: Map<string, Map<string, string>>;
};

export type SkillsPronote = ReturnType<typeof skillsPronote>;

/** Session with the two groups of 6e of the case of 20/11/2026 and their four existing assessments. */
export const skillsPronote = (options: { levels?: unknown[] | null; refuseEntryTab?: boolean; refusal?: string; tabs?: number[] } = {}) => {
  const stored: Stored[] = [];
  const saves: { onglet?: number; data: Record<string, any> }[] = [];
  let counter = 0;
  const add = (title: string, group: keyof typeof groups, date: string, skillIds: string[], level?: string) => {
    counter++;
    const service = services.find((item) => item.groupe.V.N === group)!;
    const assessment: Stored = {
      N: `29#e${counter}`, L: title, service: service.N, classe: group, periode: period.N, date, publication: date, coefficient: 1,
      cycle: true, descriptif: "",
      skills: skillIds.map((id, index) => ({ ...elements.get(id)!.item, relation: `15#r${counter}_${index}`, pilier: elements.get(id)!.pilier })) as StoredSkill[],
      levels: new Map(),
    };
    if (level) for (const student of ROSTERS[group]) assessment.levels.set(student.N, new Map(assessment.skills.map((skill) => [skill.relation, level])));
    stored.push(assessment);
    return assessment;
  };
  add("Classeur", "2#g12", "10/11/2026", ["25#i91"], "16#n2");
  add("Evaluation classeur", "2#g3", "10/11/2026", ["25#i91"], "16#n1");
  // Same title and same date in the two groups (and once more in 603): the ids must stay distinct.
  add("Se connecter et accéder à olution", "2#g12", "17/11/2026", ["25#i133"], "16#n1");
  add("Se connecter et accéder à olution", "2#g3", "17/11/2026", ["25#i133"], "16#n6");

  const levels = options.levels === undefined ? SCHOOL_LEVELS : options.levels;
  const levelByN = new Map((levels ?? SCHOOL_LEVELS).map((level: any) => [level.N, level]));
  const usable = (N: unknown) => typeof N === "string" && levelByN.has(N) && String((levelByN.get(N) as any).actifPour?.V ?? "[0]").includes("0")
    && Number((levelByN.get(N) as any).G) >= 1;

  const evaluationJson = (item: Stored) => ({
    N: item.N, G: 29, L: item.L,
    dateValidation: { _T: 7, V: item.date },
    datePublication: { _T: 7, V: item.publication },
    descriptif: { _T: 21, V: item.descriptif },
    coefficient: item.coefficient,
    priseEnCompteDansBilan: item.cycle,
    avecSaisie: true,
    periode: { _T: 24, V: period },
    service: { _T: 24, V: { N: item.service, L: "SCIENCES ET TECHNOLOGIE" } },
    classe: { _T: 24, V: groups[item.classe as keyof typeof groups] },
    listeCompetences: { _T: 24, V: item.skills.map((skill, index) => ({
      N: skill.N, G: skill.G, L: skill.L, P: index + 1, coefficient: 1,
      relationESI: { _T: 24, V: { N: skill.relation } },
      pilier: { _T: 24, V: skill.pilier },
      palier: { _T: 24, V: palier },
    })) },
  });

  const denied = { Erreur: { Titre: "Vos droits sont insuffisants pour effectuer cette opération." } };

  const save = (data: Record<string, any> | undefined, call: FakeCall) => {
    saves.push({ onglet: call.onglet, data: data ?? {} });
    // "Liste des évaluations" (tab 65): the real server answered without creating anything.
    if (call.onglet !== 56) return {};
    if (options.refusal) return { RapportSaisie: { _erreurSaisie_: true, titre_Messages_Erreur: "Saisie impossible", _messagesErreur_: [options.refusal] } };
    const created: { N: string }[] = [];
    for (const sent of (data?.listeEvaluations ?? []) as any[]) {
      if (sent.E === 1) {
        const service = services.find((item) => item.N === sent.Service?.N);
        const group = groups[sent.Ressource?.N as keyof typeof groups];
        const skills = (sent.listeCompetences ?? []) as any[];
        const valid = service && group && String(sent.L ?? "").trim() !== "" && sent.Periode?.N === period.N
          && sent.DateValidation?._T === 7 && sent.DatePublication?._T === 7 && skills.length > 0
          && typeof sent.coefficient === "number" && typeof sent.Descriptif === "string"
          && skills.every((skill) => elements.has(skill.N) && skill.E === 1 && skill.relationESI?.E === 1 && skill.palier?.N === palier.N
            && typeof skill.coefficient === "number");
        if (!valid) continue;
        const assessment = add(String(sent.L).trim(), group.N as keyof typeof groups, String(sent.DateValidation.V).split(" ")[0], skills.map((skill) => skill.N));
        assessment.publication = String(sent.DatePublication.V).split(" ")[0];
        assessment.coefficient = sent.coefficient;
        assessment.cycle = sent.priseEnCompteDansBilan !== false;
        assessment.descriptif = sent.Descriptif;
        created.push({ N: assessment.N });
        continue;
      }
      const index = stored.findIndex((item) => item.N === sent.N);
      if (index < 0) continue;
      if (sent.E === 3) {
        stored.splice(index, 1);
        continue;
      }
      const assessment = stored[index];
      if (sent.E === 2) {
        assessment.L = String(sent.L ?? assessment.L);
        if (sent.DateValidation?.V) assessment.date = String(sent.DateValidation.V).split(" ")[0];
        if (sent.DatePublication?.V) assessment.publication = String(sent.DatePublication.V).split(" ")[0];
        for (const skill of (sent.listeCompetences ?? []) as any[]) {
          if (skill.E === 1 && elements.has(skill.N) && skill.relationESI?.E === 1) {
            assessment.skills.push({ ...elements.get(skill.N)!.item, relation: `15#r${assessment.N}_${assessment.skills.length}`, pilier: elements.get(skill.N)!.pilier } as StoredSkill);
          }
        }
      }
      for (const student of (sent.listeEleves ?? []) as any[]) {
        if (student.E !== 2 || !ROSTERS[assessment.classe].some((item) => item.N === student.N)) continue;
        for (const skill of (student.listeCompetences ?? []) as any[]) {
          const relation = assessment.skills.find((item) => item.relation === skill.relationESI?.N);
          if (!relation || skill.E !== 2 || skill.N !== relation.N || !usable(skill.niveauDAcquisition?.N)) continue;
          const row = assessment.levels.get(student.N) ?? new Map<string, string>();
          row.set(relation.relation, skill.niveauDAcquisition.N);
          assessment.levels.set(student.N, row);
        }
      }
    }
    return created.length ? { RapportSaisie: { listeEvaluationsCreees: { _T: 24, V: created } } } : {};
  };

  const session = fakeSession({
    ListePeriodes: () => ({ listePeriodes: { _T: 24, V: [period] }, periodeParDefaut: { _T: 24, V: period } }),
    "ListeServices@23": () => ({ services: { _T: 24, V: [] } }),
    "ListeServices@65": () => ({ services: { _T: 24, V: services } }),
    "ListeEvaluations@56": (data) => {
      if (options.refuseEntryTab) return denied;
      return { avecSaisie: true, listeEvaluations: { _T: 24, V: stored
        .filter((item) => item.service === data?.service?.N && item.classe === data?.ressource?.N && item.periode === data?.periode?.N)
        .map(evaluationJson) } };
    },
    // Every assessment of the teacher, whatever service and group are sent.
    "ListeEvaluations@65": () => ({ avecSaisie: true, listeEvaluations: { _T: 24, V: stored.map(evaluationJson) } }),
    PageCompetencesParEvaluation: (data) => {
      const assessment = stored.find((item) => item.N === data?.evaluation?.N);
      if (!assessment) return denied;
      const roster = ROSTERS[assessment.classe];
      return {
        listeEleves: { _T: 24, V: roster.map((student) => ({ ...student, classe: { _T: 24, V: groups[assessment.classe as keyof typeof groups] } })) },
        // As on 20/11/2026: the level rows carry the student identifier only.
        ListeElevesCompetences: { _T: 24, V: roster.filter((student) => assessment.levels.has(student.N)).map((student) => ({
          N: student.N,
          ListeCompetences: { _T: 24, V: [...assessment.levels.get(student.N)!.entries()].map(([relation, level]) => ({
            N: relation, NiveauDAcquisition: { _T: 24, V: { N: level, G: (levelByN.get(level) as any)?.G, L: (levelByN.get(level) as any)?.L } },
          })) },
        })) },
      };
    },
    "ListePiliers@56": () => ({ listePiliers: { _T: 24, V: referential } }),
    ListeEleves: (data) => ({ listeEleves: { _T: 24, V: ROSTERS[String(data?.ressource?.N ?? "")] ?? [] } }),
    SaisieEvaluations: save,
  });
  rememberUserData(session, {
    resources: Object.values(groups).map((group) => ({ id: group.N, label: group.L, genre: 2 as const, taught: true, principal: false })),
    tabs: options.tabs ?? [16, 23, 56, 65, 105],
    acquisitionLevels: levels ?? [],
    parentsDelayDays: 1,
  });
  return { session, stored, saves, period };
};
