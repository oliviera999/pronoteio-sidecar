# olutionsuivi — contrat du sidecar (copie)

Copie de la section 7 de `docs/olutionsuivi/CONTRATS.md` du dépôt `mood_prod` (branche `suivi/integration`), figée le
22/11/2026 et précisée le même jour (7.4 bis). L'original fait foi ; cette copie n'est modifiée que par l'orchestratrice du chantier. Le lot qui
l'applique est décrit dans `docs/olutionsuivi/lots/L01.md`.

Le chantier : un module de suivi des classes dans olution (`local_olutionsuivi`) collecte chaque semaine, pour chaque
classe d'un enseignant, les données que son profil Pronote laisse lire. Le collecteur de Moodle
(`\local_pronoteio\collector`) consomme les routes ci-dessous. Version visée du sidecar : 0.16.0.

## 7. Sidecar (L01 produit, L02 consomme)

Conventions inchangées (`docs/pronoteio/vue-pp.md`) : objet JSON direct, `validated: false`, refus jamais contourné,
erreurs `{error, code, message}`. Ajouts de la 0.16.0 :

**7.1 `GET /classlife/absences`** — `RecapAbsencesEleves` (138). Requête : `resource`, `from`, `to` (facultatifs,
année scolaire par défaut). Un appel par classe.

```
{ available, reason, validated: false, class: {id, name}, from, to, shape?: string[],
  items: [ { studentid, label, lastname, firstname,
             totals: { absences, absenceHalfDays, unjustifiedAbsences, lateness, missedHours },
             events: [ { id, kind: "absence"|"lateness", start, end, local: {start, end}, justified: bool|null,
                         halfDays: number|null, hours: number|null, minutes: number|null, subject, reasons: [] } ] } ] }
```

Si la fonction ne donne que des cumuls sans dates, `events` est vide, `totals` et `bySubject: [ { subject, hours,
lateness } ]` sont remplis, et `reason` vaut `"totals_only"` avec `available: true`.

**7.2 `GET /students/plans`** — `DetailsPIEleve` (105). Requête : `resource`, puis `student` ou `offset`/`limit`
(1 à 40, défaut 10). Réponse paginée (`PartialRead`) ; item : `{ studentid, label, plans: [ { type:
"PAI"|"PAP"|"PPS"|"PPRE"|"accommodation"|"other", label, title, start, end, comment, accommodations[],
examAccommodations: bool } ] }`. Jamais en cache, jamais au journal.

**7.3 `GET /students/history`** — `LivretScolaire` (83) et `PageSuiviPluriannuel` (44). Requête : `resource`,
`student` ou `offset`/`limit`, `sources` (`livret,multiyear` par défaut). Réponse paginée ; item :

```
{ studentid, label, sources: { livret: {available, reason, shape?}, multiyear: {available, reason, shape?} },
  years: [ { year: "2025-2026", label, level, average: number|null, classAverage: number|null,
             subjects: [ { subject, average: number|null, classAverage: number|null, comment } ] } ] }
```

**7.4 Lecture groupée.**

- `POST /collect` — corps `{ resource, period?, blocks: [ … ], options?: { <bloc>: { … } } }`. Blocs : `files`,
  `reportcards`, `results`, `comments`, `classlife`, `absences`, `plans`, `history`, `grades`. Réponse `202
  { collectid, status, progress }`. Une seule lecture groupée par compte : une seconde demande répond `409
  collect_running` avec `collectid` de celle en cours.
- `GET /collect/:id` — `{ collectid, status: "queued"|"running"|"waiting"|"done"|"partial"|"failed", created,
  finished, expires, progress: { done, total, block, student }, retry_after, session: { mobile: "open"|"closed", web:
  "open"|"closed"|"reopen_required"|"backoff"|"pin_required", reason }, blocks: { <bloc>: { status:
  "pending"|"running"|"done"|"partial"|"unavailable"|"failed", reason, validated, read, total, remaining } } }`.
- `GET /collect/:id/results?block=<bloc>&offset=&limit=` — le résultat du bloc a **la forme de la réponse de sa
  route** (table ci-dessous), comme si elle avait lu toute la classe sans limite de débit : `items` fusionnés,
  `read`, `remaining`. `offset`/`limit` paginent `items` (40 au plus). Lisible dès qu'un bloc est `done` ou `partial`,
  y compris pendant que les autres tournent.
- `DELETE /collect/:id` — annule.
- File interne par compte, priorité « lot », cadence sous la limite ; après `rate_limited`, attente de `retry_after`
  puis reprise au premier élève non lu ; une fonction refusée ou en erreur rend son bloc `unavailable` ou `failed`
  sans arrêter les autres ; session web fermée en cours de série : `status: "waiting"`, `session.web:
  "reopen_required"`, reprise quand elle revient, `partial` à l'expiration.
- Résultats en mémoire, durée de vie 30 minutes après la fin ; après un redémarrage, `404 collect_not_found` : le
  collecteur relance la lecture.

| Bloc | Route équivalente |
|---|---|
| `files` | `GET /students/files` (`options.files.include`) |
| `reportcards` | `GET /reports` (`source=reportcard`) |
| `results` | `GET /reports/results` |
| `comments` | `GET /reports/comments` |
| `classlife` | `GET /classlife` (`options.classlife.include`, `sources`, `from`, `to`) |
| `absences` | `GET /classlife/absences` |
| `plans` | `GET /students/plans` |
| `history` | `GET /students/history` |
| `grades` | `GET /grades/overview` (`options.grades.classes`) |

**7.4 bis. Précisions du 22/11 (L01 et L02 s'y alignent).**

- `collectid` : `[A-Za-z0-9_-]{8,64}`.
- Erreurs : le client lit `code` (stable), puis le préfixe de `error` avant `:`. `409` : `code: "collect_running"`,
  avec `collectid` de la lecture en cours.
- `options` : objet par bloc ; une liste est acceptée en tableau JSON **ou** en chaîne à virgules. `from` et `to` en
  secondes Unix. `period` (identifiant de période) vaut pour tous les blocs qui en prennent un.
  `options.absences.{from,to}`, `options.classlife.{include,sources,from,to}`, `options.files.include`,
  `options.grades.classes` (noms de classe, comme `GET /grades/overview`), `options.history.sources`.
- `GET /collect/:id/results` : la réponse porte toujours `total` (nombre d'items du bloc), `offset` et `limit`. Elle
  est lisible aussi pour un bloc `unavailable` ou `failed` : c'est alors la réponse de la route (`available: false`,
  `reason`, `shape` éventuel), `items` vide.
- `DELETE /collect/:id` : annule une lecture en cours **ou purge une lecture finie** ; idempotent (`404
  collect_not_found` si elle est inconnue).
- Session web : le client qui lit `session.web: "reopen_required"` rouvre la session web et transmet le nouvel
  identifiant par l'en-tête `X-Pronoteio-Web-Session` au sondage suivant ; le sidecar l'adopte pour la lecture en
  cours et reprend.
- `GET /classlife/absences` rend aussi `total`.
- Dans un résultat de bloc, `total` est le nombre d'**items du bloc** ; le nombre d'élèves de la classe se lit dans
  `GET /collect/:id` (`blocks.<bloc>.total`). Un bloc dont la route n'a pas d'`items` (`results`, `comments`,
  `grades`) est rendu entier, `total` à 0 : le client y lit `students`, `services`… comme dans la réponse de la route.
- Résultats demandés pour un bloc pas encore lu : `409`, `error: "collect_block_not_ready"`, `code:
  "collect_running"`. Le client distingue ce cas par `error` et repasse au sondage.

**7.4 ter. Précisions du 22/11 après la relecture de L01 (L01 et L02 s'y alignent).**

- `GET /collect/:id` porte `students` (effectif de la classe). `blocks.<bloc>.total` et `read` comptent les **unités
  de travail du bloc** (élèves pour un bloc lu élève par élève, 1 pour un bloc lu en une demande) : le client ne lit
  jamais l'effectif dans `blocks`. `progress.student` = nombre d'élèves lus du bloc en cours.
- État final : `done` si tous les blocs sont `done` ; `failed` si aucun bloc n'est `done` ni `partial` ; `partial`
  sinon. Un client se fie à l'état de chaque bloc, pas au seul état global.
- Session web manquante : dès qu'un bloc attend une session web que le sidecar n'a pas (jamais ouverte, ou
  perdue), l'état est `waiting`, `session.web: "reopen_required"`, `session.reason: "web_session_required"`.
  `closed` n'est jamais rendu pendant une attente.
- Blocs demandés : `options.classlife.sources` n'accepte que `recap`, `carnet`, `callsheets` ; toute autre valeur
  (`summary`) est refusée par `400`. La lecture groupée n'appelle jamais une fonction refusée au profil.
- Erreur de Pronote sur un élève : l'élève est mis dans `remaining`, la lecture du bloc continue ; le bloc finit
  `partial` s'il reste des élèves non lus après une reprise.
- Plans (`GET /students/plans`, bloc `plans`) : une réponse vide pour un élève vaut « aucun plan » (`plans: []`),
  jamais un refus. Si aucun élève de la classe n'a de plan lisible, le bloc est `done` avec `reason: "all_empty"` :
  le client ne peut alors pas distinguer « aucun plan » de « détail non lisible », et s'en tient à la fiche élève.
- `GET /students/history` : quand une source se ferme en cours de page, la réponse est `partial: true` et
  `remaining` liste les élèves non lus.
- Durée de vie : les résultats sont effacés 30 minutes après la fin par un minuteur, sans attendre une requête ; la
  déconnexion d'un compte (`POST /session/logout`) et l'oubli d'une session effacent ses lectures groupées ; un
  ancien identifiant de session n'ouvre plus aucun résultat. Les routes `/students/plans` et
  `/collect/:id/results` sont exclues du cache des doubles livraisons.
- Autres codes : `429 rate_limited` au-delà de dix lectures actives ; `404 collect_block_not_found` pour un bloc
  non demandé ; `400` si un seul de `from`/`to` est donné. `period` absent = période courante. Une lecture vit au
  plus 60 minutes.

**7.5 État de session.** `GET /session/info` ajoute `state: { mobile, web, reason, retry_after }`, mêmes valeurs
qu'en 7.4.

**7.6 Formes inconnues.** Tout décodeur qui ne reconnaît pas la forme répond `available: false`, `reason:
"format_unknown"`, `shape` (`shapeOf`, jamais une valeur). Pour les fonctions de santé (`DetailsPIEleve`), `shape`
est rendu avec le filtre `SENSITIVE` par défaut.

## 0.17.0 (chantier 0.3.0, lot NS)

Routes neuves et changements du contrat N (`docs/olutionsuivi/lots/N-contrat.md`, section 6.1), tous des ajouts :

| Route | Rôle | Schéma |
|---|---|---|
| `GET /reports/periods?resource=<c:…\|g:…>` | périodes de la classe ou du groupe (onglet 25), `kind`/`code` de la section 2 | `contracts/routes/reports-periods.schema.json` |
| `GET /reports/grid?resource&period&service` | grille de l'onglet 25 : positionnement, note LSU, appréciation | `contracts/routes/reports-grid.schema.json` |
| `POST /reports/positioning` | `SaisiePositionnement` / `SaisieNoteLSU` cellule par cellule, simulation, relecture | `contracts/routes/reports-positioning.schema.json` |

- `GET /reports/comments` : l'appréciation générale est tentée pour tout compte et pour un groupe ; refus de Pronote
  → `general: {available: false, reason: "access_denied"|"pronote_refused"}` ; `not_principal` n'est plus rendu.
- `GET /grades/overview`, `GET /competencies` : `services=<id,id>` facultatif.
- `GET /health` : `routes`. Un sidecar plus ancien répond 404 aux routes neuves (`sidecar_outdated` côté passerelle).
- `period` des routes neuves : identifiant stable (`p:Trimestre 1`) ou code (`T1`, `BB1`…).
- Écritures : `403 write_mode_simulate` hors simulation quand `writeMode` n'est pas `live` (comme toute écriture du
  sidecar) ; `dryRun: true` rend `before`/`after`/`requests` sans rien envoyer.

