# Lot NS — Sidecar : périodes d'une classe, grille de l'onglet 25, positionnement et note LSU

Vague 1, session séparée. Dépôt **`pronoteio-sidecar`**, branche d'intégration `claude/gallant-turing-lu9vxj`
(ta session te donne ta branche de travail). Version visée : **0.17.0**. Ce fichier, le contrat
(`docs/olutionsuivi/lots/N-contrat.md`) et la capture (`docs/pronoteio/capture-saisies-2026-11-24.md`) sont copiés
dans ce dépôt, sous les mêmes chemins.

## But

Ajouter au sidecar, **par ajout seulement**, ce dont le chantier 0.3.0 a besoin : périodes d'une classe, appréciation
générale tentée hors professeur principal, lecture de la grille de l'onglet 25 (positionnement, note LSU), écritures
`SaisiePositionnement` et `SaisieNoteLSU`, filtre par service des devoirs et évaluations d'une période.

## À lire, et rien d'autre

- `docs/olutionsuivi/lots/N-contrat.md` : sections 1, 2, 6.1 et 7.
- `docs/pronoteio/capture-saisies-2026-11-24.md` (fait foi pour la forme des requêtes).
- Code : `src/teacher/comments.ts`, `src/teacher/commentsWrite.ts`, `src/teacher/write.ts`, `src/teacher/grades.ts`
  (`loadPeriods`, `pickPeriod`, `periodDates`, `overview`), `src/teacher/competencies.ts` (`overview`,
  `levelsOf`), `src/pronote/functions.ts`, `src/routes/reports.ts`, `src/routes/grades.ts`,
  `src/routes/competencies.ts`, `src/health.ts`, `src/errorCodes.ts`, `contracts/README.md`,
  `test/contracts.test.ts`, `test/comments-write.test.ts`.

## Fichiers possédés

Tout le dépôt `pronoteio-sidecar`, sauf `docs/olutionsuivi/lots/` et `docs/pronoteio/` (copies de référence).

## Règles du lot

- Aucune route existante ne change de forme ni ne perd un champ ; aucun test existant ne change (sauf celui qui
  affirmait le refus a priori de l'appréciation générale, qui devient le test du nouveau comportement).
- Les deux écritures reproduisent **exactement** la capture : membres, genres `G`, libellés `L`, ordre des membres
  sans importance ; `estPourElementCompetence: false` ; jamais `estCalculAuto`, jamais `ValidationAuto*` ni
  `CalculAutoNotesSelonCompetences`. Aucune écriture d'un genre absent de la capture.
- Simulation : `dryRun` ou `writeMode` différent de `live` → rien n'est envoyé, `before`/`after`/`requests` rendus.
- Journal sans valeur ni nom d'élève. Aucun appel réel à Pronote : mocks et fixtures anonymisées.
- `sendWrite` (mode exclusif, refus relayés) est réutilisé, pas réécrit.

## À faire

1. `GET /reports/periods?resource=` (contrat 6.1, point 1) : `ListePeriodes` avec `ressource` sous l'onglet 25
   (ajouter la clé de fonction si besoin) ; `kind`/`code` selon la section 2 ; dates par `periodDates()`.
2. `comments.ts` : retirer le refus a priori (lignes ~198 et ~374 ; repli `generalFromReports` permis à tous) ; un
   refus de Pronote → `general.available: false`, `reason: pronote_refused` ou `access_denied`.
3. `GET /reports/grid?resource&period&service` (point 3) : lire `PageApprBulletin` comme `commentsFromPage`, et en
   plus `listeNiveaux`, `typePositionnementClasse`, `niveauAcquEditable`, `noteLSUEditable`, `noteLSU`, `nbEvals`,
   `classe` de chaque ligne, appréciation et son `estEditable`. 2 et 3 touchent le même fichier : à la suite.
4. `POST /reports/positioning` (point 4), nouveau module `src/teacher/positioningWrite.ts` : lecture avant, écarts,
   requêtes de la capture (création, remise à vide `{N: 0, G: 0, L: "Aucun"}`, effacement LSU `V: ""`), écriture
   cellule par cellule avec arrêt à la première dont le `RapportSaisie` ne porte pas la valeur, relecture, réponse
   du contrat ; codes d'erreur ajoutés à `src/errorCodes.ts`. La classe de la requête est celle **de l'élève**
   (`classe` de la ligne), pas le groupe.
5. Paramètre facultatif `services=` sur `GET /grades/overview` et `GET /competencies` (point 5).
6. `GET /health` : `routes` (contrat 6.1, fin). Contrats : schémas stricts, fixtures, `npm run contracts:requests`.
7. `CHANGELOG.md` (0.17.0), `package.json` 0.17.0, `docs/olutionsuivi/CONTRAT_SIDECAR.md` : section « 0.17.0 ».

Sous-agents possibles : 1 ; puis 2 et 3 ; 4 ; 5 et 6.

## Tests exigés

Tests Node sur des fixtures **à la forme capturée** : périodes d'une classe (trimestres, semestres, bacs blancs,
CCF) ; appréciation générale hors professeur principal lue, puis refusée par Pronote ; grille d'un groupe de 6e
(colonnes présentes) et d'une classe sans Pos. ni N. LSU ; positionnement : création, remise à vide, cellule non
éditable, période close, refus relayé, mode exclusif, arrêt à la première écriture non confirmée, simulation ; note
LSU : écriture `"15,00"`, effacement, hors bornes ; filtre `services`. `npm test` et `npm run typecheck` verts.

## Terminé quand

- [ ] chaque ajout a ses tests Node sur des fixtures à la forme capturée ;
- [ ] les deux écritures envoient exactement les requêtes de la capture (création, remise à vide, cellule non
      éditable, période close, refus relayé, simulation) ;
- [ ] aucun test existant ne change (hors refus a priori, dit dans la passation) ; `npm test` et `npm run typecheck`
      verts (nombres dans la passation) ;
- [ ] contrats (`contracts/`) et `CHANGELOG.md` à jour, version 0.17.0 ;
- [ ] aucune route existante n'a perdu un champ (test de contrat ou comparaison de fixtures).

Passation : `docs/olutionsuivi/passations/NS.md` **dans ce dépôt**. PR en brouillon vers
`claude/gallant-turing-lu9vxj` de `pronoteio-sidecar`. Ne fusionne rien vers `main` : c'est le déploiement.
