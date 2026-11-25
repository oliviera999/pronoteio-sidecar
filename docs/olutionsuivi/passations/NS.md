# Passation — lot NS (sidecar 0.17.0)

**État : terminé** (en revue). Branche `suivi03/NS-sidecar`, partie de `claude/gallant-turing-lu9vxj` (déjà à jour :
le merge du début n'a rien apporté). PR en brouillon vers `claude/gallant-turing-lu9vxj`. Aucun appel au vrai Pronote
ni à la production : fausses sessions (`test/fake-session.ts`) et fixtures générées (« ELEVE E01 »).

## Fait

1. **`GET /reports/periods?resource=`** — `src/teacher/reportGrid.ts` (`classPeriods`) : `ListePeriodes` signé
   onglet 25 avec `{ressource, listeRessources}` (clé neuve `classPeriodsList`), `kind`/`code`/`rank` selon la section
   2 (T1…T3, S1, S2, BB1, BB2, CCF, sinon `X<rang>` / `P<rang>` ; un code déjà pris passe au rang), dates par
   `periodDates()` sinon `null`, `current` par `periodeParDefaut` (sans G), `closed` par `cloture`/`strInfoCloture`.
   Refus → `403 access_denied`.
2. **Appréciation générale** — `src/teacher/comments.ts` : refus a priori retiré (`readGeneral` ; défaut de
   `reportComments`) ; lecture tentée pour un non PP et pour un groupe (`classe.G` = genre de la ressource) ; un refus
   de droits → `access_denied`, tout autre refus de Pronote (`ServerSideError`) → `pronote_refused` ; repli
   `generalFromReports` (client paginé) permis à tous (toujours pour une classe seulement). `not_principal` n'est plus
   rendu. L'écriture reste réservée (`403 not_main_teacher`, inchangé).
3. **`GET /reports/grid?resource&period&service`** — `reportGrid.ts` (`gridFromPage`, `reportGrid`) : lecture de
   `PageApprBulletin` comme `commentsFromPage`, plus `listeNiveaux` (statut `level` G 1-6, `special` G 7-10),
   `typePositionnementClasse`, `niveauAcquEditable`, `noteLSUEditable`, `noteLSU`, `nbEvals`, `classe` de la ligne,
   appréciation et son éditabilité. `period` : id stable ou code (`T1`), cherché dans les périodes de la classe
   (onglet 25) puis dans celles de la saisie des notes. `service` : id stable cherché onglet 23, puis 25
   (sous-services compris), puis 65 ; absent → service des appréciations.
4. **`POST /reports/positioning`** — `src/teacher/positioningWrite.ts` : lecture avant ; écarts dans `skipped` ;
   requêtes exactement celles de la capture (vérifiées membre à membre dans les tests) ; classe **de l'élève** ;
   écriture cellule par cellule par `sendWrite` (réutilisé) ; arrêt à la première dont le `RapportSaisie` ne porte pas
   la valeur (`502 positioning_not_saved:<élève>` avec `done`) ; relecture ; `before`/`after`/`requests`. Codes
   ajoutés à `src/errorCodes.ts` : `period_closed`, `positioning_not_editable` (forbidden), `lsu_out_of_range`,
   `positioning_level_unknown` (validation). `done` passé aussi dans la réponse `verified: false` des clients de
   contrat 2 (`src/app.ts`, `unverifiedResult`) et ajouté au schéma d'erreur.
5. **`services=`** sur `GET /grades/overview` et `GET /competencies` (schéma `periodClassesServicesQuery` ; filtre sur
   les ids stables ; sans lui, réponse identique — testé par égalité).
6. **`GET /health`** : `routes` ; schéma `health` mis à jour.
7. **Contrats** : schémas stricts `reports-periods`, `reports-grid`, `reports-positioning`, fixtures (dont
   `error-lsu-out-of-range`), `requests.json` (`npm run contracts:requests`), README des contrats.
   `CHANGELOG.md` 0.17.0, `package.json`/`package-lock.json` 0.17.0, `docs/olutionsuivi/CONTRAT_SIDECAR.md` section
   « 0.17.0 ». `pronote-functions.example.json` : trois clés neuves (`classPeriodsList`, `positioningSave`, `lsuSave`).

## Décisions

- **Écriture hors mode `live`** : `dryRun: false` avec `writeMode` ≠ `live` → `403 write_mode_simulate` (comme toute
  écriture du sidecar, et comme la liste d'erreurs du contrat 6.1). `dryRun: true` → simulation complète, rien
  d'envoyé. La règle du lot « writeMode différent de live → rien n'est envoyé » est tenue (rien n'est envoyé), mais
  sous forme de refus plutôt que de simulation silencieuse, pour qu'un `apply()` ne croie jamais avoir écrit.
- **Écarts et erreurs** : `student_not_found` et `period_closed` vont dans `skipped` en simulation (le plan les
  montre) ; en écriture réelle, ils arrêtent **avant tout envoi** (`404 student_not_found:<nom>`, `409
  period_closed`). `unchanged` et `not_editable` sont sautés dans les deux modes (`positioning_not_editable` existe
  dans la table des codes mais n'est pas levé : une cellule non éditable est un écart du plan).
- **Refus après des écritures** (`pronote_refused`, `exclusive_mode` à la k-ième cellule) : l'erreur porte `done`.
- **`stoppedAt`** est toujours `null` dans une réponse 200 : un arrêt est une erreur 502 (l'élève est dans le code,
  `done` en membre), comme le contrat le décrit.
- **Valeur `value` du corps** : pas de type dans le schéma Fastify (une union `integer|string|null` laisserait la
  coercition changer `null` en `0`) ; contrôle dans le module (entier > 0 ou `null` ; LSU 0 à 100, virgule ou point,
  deux décimales au plus, rendu `"15,00"`). Testé par la route (`null` conservé).
- **Ids des niveaux** (`levels[].id`, `positioning.id`) : le `N` de Pronote (`"93#…"`), pas un id stable ; l'écriture
  prend le **genre**.

## Écarts proposés au contrat

- Le membre qui porte le positionnement **actuel** d'une ligne de la grille n'est pas dans la capture (elle ne nomme
  que `niveauAcqu` dans le `RapportSaisie`). Lu dans `niveauAcqu`, puis `positionnement`, `niveauAcquisition`. **À
  vérifier** au prochain relevé réel (une ligne d'un élève déjà positionné) ; sinon le positionnement lu reste `null`
  et `unchanged` n'est jamais détecté pour lui (l'écriture reste correcte).
- `GET /reports/grid` : `service` facultatif (contrat : paramètre listé) ; `period` accepte aussi le code (`T1`).

## Fragments déposés

Aucun (le sidecar est entièrement possédé par le lot ; `TABLEAU.md` n'existe pas dans ce dépôt : la ligne est à
mettre par l'orchestrateur dans `mood_prod`, état « en revue »).

## Tests

- `npm ci` puis `npm run typecheck` : **vert** (0 erreur).
- `npm test` : **431 tests, 431 passés, 0 échec** (avant le lot : 416/416). Ajouts : `test/report-grid.test.ts`
  (12 tests), `test/report-grid-routes.test.ts` (1), `test/comments-general.test.ts` (+1),
  `test/competency-services.test.ts` (+1, filtre `services`), échantillons de contrat (4 réponses neuves validées par
  `test/contracts.test.ts`). Fixtures de la capture : `test/helpers/report-grid-fixtures.ts`.
- Un test étranger au lot (`token-store` : « the chain survives a restart ») a échoué une fois sur un lancement
  complet puis passé (7/7 seul, puis dans les deux lancements complets suivants) : sensibilité au temps, préexistante.
- Pas de phpcs/PHPUnit (dépôt Node).

## Terminé quand

- [x] **chaque ajout a ses tests Node sur des fixtures à la forme capturée** — `test/report-grid.test.ts` : périodes
      (trimestres + bacs blancs + CCF ; semestres dont un clos, dates ; codes `X`/`P`/`BB` ; refus), grille d'un groupe
      de 6e (colonnes présentes, classe de l'élève, niveaux) et d'une classe sans Pos. ni N. LSU, refus ; positionnement
      (création, remise à vide, non éditable, période close, refus relayé, mode exclusif, arrêt à la première écriture
      non confirmée, simulation, niveau inconnu) ; note LSU (`"15,00"`, effacement, hors bornes). Appréciation générale
      hors PP lue puis refusée : `test/comments-general.test.ts`. Filtre `services` : `test/competency-services.test.ts`.
- [x] **les deux écritures envoient exactement les requêtes de la capture** — tests « creation and reset send exactly
      the requests of the capture » et « LSU mark : write of "15,00", erasure » : `deepEqual` sur le corps complet
      (`estPourElementCompetence: false`, `positionnement` `{N "93#…", G, L}` / `{N: 0, G: 0, L: "Aucun"}`, `classe` G 1
      de l'élève, `periode` G 2, `eleve` G 4, `service` `{N, L}` sans G, `posLSUNote {_T: 10, V}`), onglet 25, aucune
      fonction `ValidationAuto*`/`CalculAuto*` ni `estCalculAuto` ; non éditable, période close, refus relayé et
      simulation : aucune requête `Saisie*` envoyée (assertions sur `fake.calls`).
- [x] **aucun test existant ne change (hors refus a priori)** — seuls changent les deux tests qui affirmaient le refus
      a priori de l'appréciation générale (`not_principal`) : `test/comments-general.test.ts` (« an account that is not
      main teacher… », devenu « …are read when Pronote answers them » + un test neuf du refus) et
      `test/real-shapes.test.ts` (« an account that is not main teacher gets no report card read… », devenu « …has the
      read tried, then the report cards by pages »). Le test de `competency-services` est un **ajout** en fin de fichier.
      `npm test` 431/431, `npm run typecheck` vert.
- [x] **contrats et `CHANGELOG.md` à jour, version 0.17.0** — `contracts/routes/reports-{periods,grid,positioning}
      .schema.json`, fixtures, `requests.json` (le test « requests.json is up to date » passe), `CHANGELOG.md` 0.17.0,
      `package.json` 0.17.0.
- [x] **aucune route existante n'a perdu un champ** — comparaison des clés (récursive) de chaque fixture de
      `contracts/fixtures` régénérée contre la version d'avant le lot : 0 clé perdue ; seule clé ajoutée : `routes`
      dans `health.json` (les autres différences sont des valeurs volatiles : version, horodatages, identifiants). Les
      schémas stricts des routes existantes valident toujours leurs réponses (`test/contracts.test.ts`).

## Reste

- Relevé réel (hors de ce lot) : membre du positionnement actuel d'une ligne ; forme d'un `RapportSaisie` de refus
  sur période close.
- Passerelle `local_pronoteio` 0.26.0 (lot NP) : consommer les trois routes, `routes` de `/health`, codes neufs.

## Prochaine action

Revue de la PR brouillon `suivi03/NS-sidecar` → `claude/gallant-turing-lu9vxj` ; l'orchestrateur met la ligne NS de
`TABLEAU.md` à « en revue ». Ne rien fusionner vers `main` (déploiement).
