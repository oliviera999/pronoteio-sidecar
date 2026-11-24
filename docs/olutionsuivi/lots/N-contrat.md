# Chantier 0.3.0 — contrat commun des lots N

Rédigé le 24/11/2026 par l'orchestrateur (vague 0). Il fait foi pour tout ce qui est neuf en 0.3.0, comme
`M-mode-enseignant.md` pour la 0.2.0 ; pour le reste, `CONTRATS.md` reste valable. Décisions : `DECISIONS.md`, D1 à
D38 (D24 à D38 pour la 0.3.0). Un écart jugé nécessaire se **propose dans la passation** ; on applique le contrat tel
quel si c'est possible, on s'arrête sinon.

`S/` = `plugins/local_olutionsuivi/`, `P/` = `plugins/local_pronoteio/`, `M/` = `plugins/local_olutionmcp/`,
`SC/` = dépôt `pronoteio-sidecar`.

## 1. Règles de travail (tous les lots)

- **Branche** : ta session te donne ta branche. Commence par `git fetch origin claude/gallant-turing-lu9vxj && git
  merge --no-edit FETCH_HEAD` (branche d'intégration, la même dans les deux dépôts). Pousse ta branche, ouvre une PR
  **en brouillon** vers `claude/gallant-turing-lu9vxj`, note le nom de ta branche dans ta passation.
- **Banc** : `BANC.md`. `bash tools/olutionsuivi/banc.sh init` une fois (10 à 15 min), puis `banc.sh up <lot>`
  depuis ton dépôt ; PHPUnit et phpcs (`moodle-extra`, zéro erreur, zéro avertissement sur tes fichiers) par
  `banc.sh phpunit|phpcs <lot> …`. PHP 8.3 sur le banc, 8.4 en production : aucune syntaxe propre à 8.4.
  Sidecar : `npm ci`, `npm test`, `npm run typecheck`. `bash scripts/check-secrets.sh` avant de pousser.
- **Jamais** le connecteur olution, la production ni le vrai Pronote. Données générées, noms « ELEVE E01 ». Aucune
  donnée d'élève dans un commit, une PR, un journal, une passation.
- **Propriété des fichiers** (section 9) : tu ne modifies que tes fichiers. Les fichiers partagés sont à
  l'orchestrateur : `version.php`, `db/*`, `lang/*`, `settings.php` (admin), `lib.php`, `CHANGELOG.md`,
  `docs/olutionsuivi/` hors passations et fragments. Besoin d'y toucher : un **fragment** dans
  `docs/olutionsuivi/fragments/<lot>/` :
  - chaînes : `lang_<composant>.md`, tableau `| clé | fr | en |` (outil `tools/olutionsuivi/assemble_lang.py`), et
    pour le banc un `lang_<composant>.php` (lignes `$string['clé'] = '…';`, en français) que `banc.sh sync` ajoute à
    sa copie ; un test ne doit pas échouer pour une chaîne absente du fichier de langue réel ;
  - tout autre besoin (colonne, capacité, ligne dans un gabarit d'un autre lot, entrée de registre d'outils) :
    `<sujet>.md`, ce qu'il faut ajouter, où, et pourquoi.
- **Base** : toutes les tables et colonnes de la 0.3.0 sont posées par le socle (section 4). Un lot n'écrit **aucun**
  pas de mise à niveau. Une colonne manquante : fragment, et tu continues sans elle si tu peux.
- **Compatibilité** : champs ajoutés, jamais renommés ni supprimés ; `schemaversion` reste 1 ; `EXPORT_VERSION` reste
  1 (blocs neufs en fin de liste) ; un instantané de la 0.1.0 (`tests/collect/fixtures/etat_eleve_v010.json`) et de
  la 0.2.0 se lisent et se recalculent ; sans aucune surcharge de réglage, les scores de la fixture de 31 (annexe A de
  `SPEC.md`) et ceux des tests de la 0.2.0 ne changent pas.
- **Accès** : tout passe par `local\access` ; ce qui touche un élève exige `access::DETAIL` ; un bloc neuf de l'état
  élève reste hors de `redact::OVERVIEW`. Journaux sans valeur, texte ni nom d'élève. Santé : jamais dans un réglage
  ni dans un texte engendré.
- **Pronote** : aucune écriture réelle ; toute écriture passe par un plan (section 7) ; jamais de calcul en masse
  (`estCalculAuto: true`, `ValidationAutoPositionnement`, `ValidationAutoCompetences`,
  `CalculAutoNotesSelonCompetences`, boutons « Σ ») ; une fonction refusée au profil n'est jamais contournée.
- **Contexte** : lis ton fichier de lot et les sections de ce contrat qu'il cite, pas la feuille de route. Cherche
  avant de lire. Sous-agents en arbres isolés pour les parties indépendantes (trois au plus). Vers les deux tiers du
  contexte : passation, commit, push, arrêt ; reprise par « Reprends le lot <lot> du chantier 0.3.0 ».
- **Commits** petits, en français, préfixés par le lot (`N2a : …`), poussés à chaque étape.
- **Passation** `docs/olutionsuivi/passations/<lot>.md` : état (terminé, partiel, bloqué) ; branche ; fait ;
  décisions ; écarts proposés ; fragments déposés ; tests (commande exacte, nombre de tests et d'assertions, phpcs) ;
  la liste « Terminé quand » de ta fiche **recopiée et cochée**, chaque case avec sa preuve ; reste ; prochaine
  action. Un critère non coché = lot **partiel**. Mets ta ligne de `TABLEAU.md` à jour (début : « en cours » ; fin :
  « en revue »), c'est le seul endroit de `docs/olutionsuivi/` hors passation et fragments où tu écris.

## 2. Périodes : une forme pour tous

Clé de période du module = **code court stable** (`code`), jamais l'identifiant Pronote seul :

| Genre Pronote | `kind` | `code` | Dans la moyenne de période |
|---|---|---|---|
| trimestre (`G: 2`, `GenreNotation: 1`, nom « Trimestre n ») | `trimester` | `T1`, `T2`, `T3` | oui |
| semestre (nom « Semestre n ») | `semester` | `S1`, `S2` | oui |
| bac blanc, CCF (`G: 4`, `GenreNotation: 0`) | `exam` | `BB1`, `BB2`, `CCF` (par le nom ; sinon `X<rang>`) | non (réglage `periods.exams_in_average`) |
| autre | `other` | `P<rang>` | non |

Forme d'une période (instantané, tables, outils) :

```json
{"code": "S1", "key": "<id Pronote stable>", "name": "Semestre 1", "kind": "semester", "rank": 1,
 "start": "2026-09-01", "end": "2027-01-24", "current": true, "closed": false, "inaverage": true}
```

`start` / `end` : `AAAA-MM-JJ` ou `null`. Le code de l'année entière est `Y` (score annuel). `note.period` accepte
désormais `T1`…`T3`, `S1`, `S2` (`defaults::PERIODS` devient `['T1','T2','T3','S1','S2']`, `defaults::PERIODS_V2`
garde l'ancienne liste). **Type de période d'une classe** (D26) : réglage `periods.type` s'il n'est pas `auto` ;
sinon les périodes de la classe (route `GET /reports/periods`) ; sinon celles où le service du compte a des
devoirs ; sinon la période `current`. Fonctions communes, posées par le socle dans `S/classes/local/periods.php`
(propriété `N2b` ensuite) : `periods::code(array $pronoteperiod, int $rank): string`, `periods::kind(...)`,
`periods::normalize(array $list): array` (liste ci-dessus, triée), `periods::containing(array $list, int $time):
?string`.

## 3. Réglages : registre et magasin à quatre niveaux (`N1`)

### 3.1 Niveaux

`site` (ligne `ownerid = 0`, capacité `manage`) → `profile` (`pp` ou `teacher`, par propriétaire) → `class` →
`student`. Le plus précis l'emporte. Le profil d'une classe est son **mode effectif** calculé sur les seuls niveaux
site et classe (`teacher.mode` n'est pas permis au niveau profil). Le propriétaire d'une classe règle ses profils, sa
classe et ses élèves **sans** `manage` (D30). Ancien niveau « toutes mes classes » (`classid: 0`, colonne `scope`
vide) : la mise à niveau le copie dans les deux profils du propriétaire (origine `upgrade`) ; la ligne d'origine reste
et n'est plus lue. `plan_suivi_settings` avec `classid: 0` écrit les deux profils ; avec `classid: n`, la classe ;
paramètres neufs `level` (`site|profile|class|student`), `profile` (`pp|teacher`), `studentid`.

### 3.2 Table (colonnes ajoutées à `local_olutionsuivi_settings`)

`scope` char(10) null (`site|profile|class|student` ; null = ligne de la 0.2.0), `scopekey` char(40) null (`pp` /
`teacher` pour un profil, id de `local_olutionsuivi_student` pour un élève, vide sinon), `origin` char(10) null
(`page|mcp|upgrade|preset|import`). Index `scopekey`(ownerid, classid, scope, scopekey). Une ligne par changement et
par portée, comme aujourd'hui ; la ligne courante est celle d'id le plus grand.

### 3.3 Registre

`S/classes/local/registry.php` (N1) : chaque réglage feuille déclaré une fois.

```php
['key' => 'teacher.results.min_items', 'type' => 'count', 'default' => 2, 'min' => 0, 'max' => 1000,
 'allowed' => null, 'levels' => ['site', 'profile', 'class'], 'effect' => 'recompute', // recompute|collect|display
 'sensitive' => false, 'section' => 'scores', 'label' => 'set_teacher_results_min_items',
 'help' => 'set_teacher_results_min_items_help']
```

Types : `bool`, `enum`, `count`, `int`, `number`, `percent`, `positive`, `string`, `tag`, `date` (`AAAA-MM-JJ`),
`monthday` (`MM-JJ`), `ids`, `list`, `set`, `map`, `weights`, `json`. API : `registry::all(): array`,
`registry::get(string $key): ?array`, `registry::defaults(): array` (arbre complet = `defaults::settings()`),
`registry::allowed_at(string $key, string $level): bool`, `registry::sections(): array`. Les entrées viennent de
fournisseurs `S/classes/local/registry/keys_<nom>.php` (classe `keys_<nom>`, méthode statique `entries(): array`),
lus dans cet ordre : `core` (N1, toutes les clés de la 0.2.0 et les clés neuves de la section 3.5 sans fournisseur
propre), `courses` (N2a), `periods` (N2b), `collect` (N3), `bilan6` (N5), `appraisal` (N6), `voice` (N7), `student`
(N1b), `misc` (N8a) ; un fournisseur absent est ignoré. Les **défauts** sont tous posés par le socle dans
`local\defaults` (section 3.5) : un lot ne change pas un défaut, il déclare la métadonnée. Test de N1 : toute feuille
de `defaults::settings()` a une entrée (les clés d'un fournisseur pas encore écrit sont tolérées par une liste
`registry::PENDING` que chaque lot vide pour ses clés).

### 3.4 Magasin (`S/classes/store/settings_repository.php`, N1)

Signatures existantes inchangées (`effective(int $classid)`, `origins(int $classid)`, `errors`, `save`, `history`,
`restore`, `modes`, `origins_many`). Ajouts :

- `effective(int $classid, ?int $studentid = null): array` — défauts → site → profil → classe → élève ;
  `version` = `"<site>.<profil>.<classe>[.<élève>]"` (ids de lignes, `0` si absente) ;
- `effective_students(int $classid): array` — `[studentid => réglages complets]` pour les seuls élèves surchargés ;
- `trace(int $classid, ?int $studentid = null): array` — `[clé feuille => ['value', 'level', 'inherited' => valeur
  du niveau au-dessus]]` ;
- `save_scope(string $level, int $ownerid, int $classid, string $scopekey, array $patch, int $userid, string
  $origin): int`, `errors_scope(...)`, `history_scope(...)`, `current_scope(...)`, `reset_key(string $level, …,
  string $key, int $userid, string $origin): int` (retour à l'hérité) ;
- `origins()` garde sa forme ; la valeur `site` y signifie toujours « réglage du propriétaire » (profil), `class` la
  classe, `default` le défaut ; `site_admin` est ajouté pour le niveau site.

Préréglages : `S/classes/store/preset_repository.php` (N1), table `local_olutionsuivi_preset` ; méthodes `list(int
$ownerid)`, `save(...)`, `apply(int $presetid, string $level, int $ownerid, int $classid, string $scopekey, int
$userid): int` (une ligne de réglages d'origine `preset`), `export(int $presetid): string` (JSON
`{"format":"olutionsuivi-preset","version":1,"name","label","settings"}`), `import(int $ownerid, string $json):
int`. Les cinq préréglages fournis (D31, `builtin = 1`, `ownerid = 0`) sont créés à l'installation et à la mise à
niveau par `S/classes/local/presets.php::builtin()` (N1 ; le socle appelle `presets::install()` s'il existe).

### 3.5 Clés neuves et leurs défauts (posées par le socle dans `defaults::settings()`)

Niveaux par défaut : `site, profile, class` ; `+student` quand c'est dit. Rien ne change un calcul sans surcharge.

```text
categories (N2a)
  enabled: true
  cohort_pattern: '^(\d{2})[#!]'
  optional_categories: [1]            archive_categories: [55]     (archives : chemin /…/55/…)
  level_map: {'6 S':'6', '2 SNT':'2', '1 SVT':'1', '0':'T', 'TES1':'T', 'TES 2':'T', 'TES 3':'T'}
  school_start: '08-20'               (MM-JJ, rentrée : sert à dater une inscription sans cohorte)
  rule_order: ['manual_student','manual_class','include','exclude','archive','tag','optional','cohort','enrol_date']
  optional_mode: 'display'            (display|bonus|course ; +student)
  optional_bonus_weight: 0.5          (poids de la composante O dans INV quand optional_mode = bonus)
  past_display: 'collapsed'           (collapsed|expanded|hidden)
  overrides: {}                       (courseid => current|past|optional|excluded ; class, +student, pas site/profil)
periods (N2b)
  type: 'auto'                        (auto|trimester|semester ; class)
  default_view: 'current'             (current|year)
  exams_in_average: false
  olution_method: 'points'            (points|gradebook)
  olution_explicit: {activities:{}, sections:{}, tags:{}, gradecategories:{}}   (id ou nom => code de période)
  trends_on: 'current'                (current|year)
calendar (existant) : periods: [] devient [{code, start, end}] (correction des dates) ; councils: [] [{code, date}] (class)
collect (N3 ; carry_days existe)
  pass_minutes: 60    pass_budget: 40     (site seulement : fréquence d'une passe, appels Pronote par passe)
  discovery_retry_days: 14                rare_days: 30          current_hours: 24
  blocks_off: []                      (blocs coupés : health, history, guardians, comments… ; class)
  prefer_class_grid: true             (grille de classe tant que le bulletin n'est pas publié)
display (N3, N2a)
  colleague_comments: 'collapsed'     (collapsed|small|expanded|hidden)
  print_council_comments: false       (appréciations des collègues dans l'impression « conseil »)
  export_comments: false              (appréciations dans l'export)
bilan6 (N5)
  enabled: 'auto'                     (auto = si la grille de l'onglet 25 porte Pos. ou N. LSU ; on|off ; class)
  positioning_rule: 'mean_points'     (mean_points|mode|last_n)
  lsu_rule: 'mean_points'             (mean_points|mastery_share)
  last_n: 0                           (0 = toutes les évaluations)
  statuses: 'ignore'                  (ignore|count_as_lowest : Absent, Non évalué, Dispensé, Non rendu)
  lsu_scale: 20                       (note LSU calculée sur 20 ; 100 possible)
  lsu_decimals: 2
  only_empty_cells: false
  in_R: false     in_C: false
appraisal (N6)
  enabled: true     maxlength: 500    propose_after_collect: true
  profile: ''                         (nom d'un profil de rédaction ; class, +student ; '' = selon le service)
  context_note: ''                    (student seulement ; jamais de santé)
voice (N7)
  enabled: true
  campaigns: [{key:'rentree', from:'09-01', to:'10-15'}, {key:'t1', from:'12-01', to:'01-31'}, {key:'t2', from:'03-01', to:'04-30'}]
  campaign_mode: 'activity'           (activity|reopen)
  feedback_cmids: []                  (class)
  mappings: {}                        (cmid => {question id => rubrique} ; class)
  import_mappings: {}                 (nom de source externe => {colonne => rubrique} ; profile, class)
  alert_question: ''    alert_enabled: false    in_export: false
student (N1b ; student seulement)
  newcomer_until: null    exclude_from_medians: false    alerts_muted: {}  (code => date|'always')
  dispense: []            (lettres de scores)            adjustment: {exists: false, effect: 'none'}  (none|time|weights)
alerts (existant) : unconfirmed: 'mark'   (mark|close|keep ; N1b)
notify (N3) : collect_end: true    proposals: true
```

Clés existantes rendues permises au niveau `student` : `scores.*` poids, `teacher.results.weights`,
`teacher.online.weights`, `teacher.courses.include|exclude`, `scores.d.steps.*.expected`, `alerts.*` seuils.

## 4. Tables neuves (posées par le socle ; préfixe `local_olutionsuivi_`)

Toutes : `id` clé primaire ; dates en entier ; colonnes neuves des tables existantes acceptant le vide. Chaque table
neuve est déclarée dans `privacy\provider::TABLES` et les trois listes des tests (`provider_test`, `skeleton_test`,
`purge_test`) ; celles qui portent des données d'élèves sont ajoutées à `M/classes/sql/masking.php` `CLOSED_TABLES`
(marquées « fermée »). Propriétaire du code qui la lit et l'écrit entre parenthèses.

| Table | Colonnes | Clés | |
|---|---|---|---|
| `preset` (N1) | ownerid int NN, name char(100) NN, label char(255), payload text, builtin int NN 0, usermodified int NN 0, timecreated, timemodified | U(ownerid, name) | |
| `period` (N2b) | classid NN, code char(10) NN, pronotekey char(100), name char(100) NN, kind char(10) NN, rank int NN 0, timestart int, timeend int, iscurrent int NN 0, closed int NN 0, inaverage int NN 1, source char(20) NN (`pronote.class`, `pronote.grades`, `settings`), timemodified | U(classid, code) | |
| `gradeperiod` (N2b) | studentid NN, courseid NN, itemid NN (`grade_items.id`), code char(10) NN, origin char(10) NN (`push`, `explicit`, `default`, `legacy`, `manual`), autocode char(10) (ce que donnerait l'automatique), timegraded int, usermodified int NN 0, timecreated, timemodified | U(studentid, itemid) ; I(courseid, itemid) | fermée |
| `gradeperiodhist` (N2b) | gradeperiodid NN, fromcode char(10), tocode char(10) NN, origin char(10) NN, usermodified int NN 0, timecreated | I(gradeperiodid) | fermée |
| `pscore` (N2b) | runid NN, studentid NN, code char(10) NN (code de période, ou `Y`), r, a, e, d, v, inv, c number(10,3), partial int NN 0, detail text, timecreated | U(runid, studentid, code) ; I(studentid, code) | fermée |
| `blockstate` (N3) | classid NN, block char(30) NN, code char(10) NN '' , state char(12) NN `unknown` (`readable`, `refused`, `empty`, `failed`, `off`), freshness char(10) NN `current` (`frozen`, `rare`, `current`), reason char(100), lastread int, lastrunid int, nextread int, attempts int NN 0, calls int NN 0, timemodified | U(classid, block, code) | |
| `bilan` (N5) | runid NN, studentid NN, service char(100) NN, code char(10) NN, lsu number(10,2), level int (genre Pronote), rule char(40) NN, nbevals int NN 0, pronotelsu char(10), pronotelevel int, gap int NN 0, detail text, timecreated | U(runid, studentid, service, code) | fermée |
| `proposal` (N5 ; N6 s'en sert) | classid NN, studentid NN, kind char(20) NN (`positioning`, `lsu`, `appraisal_service`, `appraisal_general`), code char(10) NN, service char(100) NN '', value text, currentvalue text, rule char(60), state char(12) NN `pending` (`planned`, `sent`, `dismissed`, `superseded`), planid char(40), runid int NN 0, usermodified int NN 0, timecreated, timemodified | U(studentid, kind, code, service) ; I(classid, state) | fermée |
| `wprofile` (N6) | ownerid NN, name char(60) NN, kind char(10) NN (`subject`, `pp`), label char(255) NN, services text (liste JSON), payload text (JSON), version int NN 1, builtin int NN 0, usermodified int NN 0, timecreated, timemodified | U(ownerid, name) | |
| `wprofilehist` (N6) | profileid NN, version int NN, payload text, usermodified int NN 0, timecreated | U(profileid, version) | |
| `voice` (N7) | classid NN, studentid NN, campaign char(40) NN, source char(10) NN (`feedback`, `import`), sourceref char(60) NN (cmid ou id de lot d'import), questionkey char(60) NN, rubric char(40) NN, question text, answer text, timeanswered int, timecreated | U(studentid, sourceref, questionkey) ; I(classid, campaign) | fermée |

Colonnes ajoutées à des tables existantes : `settings.scope`, `settings.scopekey`, `settings.origin` (section 3.2) ;
`run.calls` int null, `run.duration` int null (passes, N3) ; `run.passkind` char(10) null (`full`, `pass`, `manual`).
La table `settings` entre dans `CLOSED_TABLES` (elle porte désormais des réglages par élève).

## 5. Instantané : champs et blocs neufs

Tous facultatifs, ajoutés à `S/schema/etat_eleve.schema.json` par le socle ; absents d'un instantané ancien.

- `period` (existant `{key, name}`) : + `code`, `kind`, `start`, `end`.
- `periods` (neuf, N3 l'écrit, N2b le lit) : `{type: 'trimester'|'semester', source: 'pronote.class'|'pronote.grades'|
  'current', list: [période, section 2]}`.
- `moodle.courses[]` (N2a) : + `catpath` (`/78/55/…`), `catidnumber`, `enrolments: [{method, cohortid, cohortname,
  cohortidnumber, parentcourseid, timecreated}]`, puis, décidés au calcul et non stockés dans l'instantané :
  `category`, `category_rule`, `category_note` (rendus par le moteur).
- `moodle.items[]` (N2b) : `{courseid, itemid, cmid, name, grade, max, timegraded, gradecategory, section, tags}` —
  notes olution par élément du carnet.
- `bulletin` (N3) : `{code, published: bool, publishedat, general: {text}|null, council: {text}|null, subjects:
  [{service, name, average, classaverage, min, max, comment, sub: [...]}], rank, generalaverage, source:
  'reportcards'|'classresults'}` — appréciations visibles du seul propriétaire, hors `OVERVIEW`, hors export par
  défaut.
- `bilan6` (N3 l'écrit, N5 le lit) : `{code, service: {id, name}, levels: [{id, genre, name, status: bool}],
  levelssource: 'grid'|'school'|'fallback', positioning: {genre, name}|null, lsu: '15'|null, positioningeditable,
  lsueditable, nbevals, closed}`.
- `sources.<source>` (existant) : + `blockstate` (`readable|refused|empty|failed|off`) et `structural: bool`.

## 6. Pronote : sidecar (`NS`) et passerelle (`NP`)

### 6.1 Routes neuves du sidecar (ajouts seulement ; version 0.17.0)

Aucune route existante ne change de forme ni ne perd un champ. Chaque route neuve : schéma strict dans
`SC/contracts/routes/`, fixture, entrée dans `requests.json`, tests Node sur des fixtures à la forme capturée
(`docs/pronoteio/capture-saisies-2026-11-24.md` du dépôt `mood_prod`).

1. `GET /reports/periods?resource=<c:…|g:…>` — `ListePeriodes` avec `ressource` (onglet 25) :
   `{resource: {id, name, genre}, current: "<id>"|null, periods: [{id, name, genre, notation, kind, code, rank,
   start, end, current, closed}]}` (`kind`, `code` : section 2 ; dates par `periodDates()` si connues, sinon `null`).
2. `GET /reports/comments` (existant) : l'appréciation générale **n'est plus refusée a priori** à un non professeur
   principal ni pour un groupe : la lecture est tentée ; un refus de Pronote donne `general: {available: false,
   reason: "pronote_refused"|"access_denied", …}`. `reason: "not_principal"` n'est plus jamais rendu par la lecture.
   L'écriture de l'appréciation générale reste réservée (`403 not_main_teacher`).
3. `GET /reports/grid?resource&period&service` — grille de l'onglet 25 (`PageApprBulletin`) :
   `{class: {id, name}, period: {id, name}, service: {id, name}, closed, positioningType, levels: [{id, genre, name,
   status}], rows: [{student, classe: {id, name}, positioning: {id, genre, name}|null, lsu: "15"|null,
   positioningEditable, lsuEditable, nbEvals, comment: {text, editable}|null}], available, reason}`. Colonnes
   absentes (classe sans Pos. ni N. LSU) : `positioning`/`lsu` à `null`, `positioningType` `null`.
4. `POST /reports/positioning` — corps `{resource, period, service, items: [{student, kind: "positioning"|"lsu",
   value}], dryRun}` (1 à 100 items) ; `value` : genre du niveau (1, 2, 4, 6…) ou `null` (remise à vide) pour
   `positioning` ; chaîne `"15,00"` (0,00 à 100,00, virgule) ou `""` (effacement) pour `lsu`. Déroulé : lecture de la
   grille (avant) ; écarts : `unchanged`, `not_editable`, `student_not_found`, `period_closed` (dans `skipped`) ;
   requêtes **exactement** celles de la capture (`SaisiePositionnement` avec `estPourElementCompetence: false`,
   remise à vide `{N: 0, G: 0, L: "Aucun"}` ; `SaisieNoteLSU` avec `posLSUNote {_T: 10, V}`) ; en simulation
   (`dryRun` ou `writeMode` différent de `live`), rien n'est envoyé ; sinon une requête par cellule, **dans l'ordre,
   arrêt à la première dont le `RapportSaisie` ne porte pas la valeur demandée** ; puis relecture de la grille.
   Réponse : `{class, period, service, before: [cell], after: [cell], skipped: [{student, kind, reason}], requests,
   written, dryRun, done: n, stoppedAt: {student, kind}|null, validated: false}` avec `cell = {student, kind,
   value}`. Erreurs : `409 exclusive_mode`, `409 period_closed`, `409 pronote_refused:<messages>`, `502
   positioning_not_saved:<student>` (avec `done`), `400 lsu_out_of_range`, `403 write_mode_simulate`, `404
   service_not_found`, `404 student_not_found:<nom>`. Journal sans valeur.
5. Devoirs et évaluations d'un service pour une période : `GET /grades/overview` et `GET /competencies` acceptent un
   paramètre neuf facultatif `services=<id,id>` (filtre) ; sans lui, réponse identique à aujourd'hui.

`GET /health` : ajouter `routes: ["reports/periods", "reports/grid", "reports/positioning"]` pour que la passerelle
sache ce que le sidecar sert.

### 6.2 Passerelle (`local_pronoteio` 0.26.0)

`connector_interface` et `sidecar_connector`, méthodes neuves :

- `get_class_periods(string $resourceid): array` → forme de la route 1 ; sidecar ancien (404) :
  `{available: false, reason: 'sidecar_outdated'}`.
- `get_report_grid(string $resourceid, string $periodid, string $serviceid): array` → route 3 (même repli).
- `write_positioning(string $resourceid, string $periodid, string $serviceid, array $items, bool $dryrun = false):
  array` → route 4 ; `assert_write_allowed()` hors simulation.
- `get_grade_overview` / lecture des compétences : paramètre facultatif `services`.

Codes d'erreur neufs dans la table de `signed_request` : `exclusive_mode` → `error_exclusivemode`,
`comment_not_editable` → `error_commentnoteditable`, `comment_not_saved` → `error_commentnotsaved`,
`positioning_not_editable` → `error_positioningnoteditable`, `positioning_not_saved` → `error_positioningnotsaved`,
`period_closed` → `error_periodclosed`, `lsu_out_of_range` → `error_lsuoutofrange` (détail après `:` gardé).

Collecteur (`P/classes/collector.php`) :

- `RESERVED` n'est plus un refus : un bloc est **tenté** ; Pronote refuse → `result::UNAVAILABLE` avec la raison
  `access_denied` ou `pronote_refused` ; rien → `result::OK` avec `meta.empty = true`. Seule raison structurelle
  restante : une classe **non enseignée** par le compte (`not_taught`, qui remplace `not_principal` pour ce cas).
  `result::meta['structural'] = true` pour `not_taught` et pour un refus de Pronote. La constante `RESERVED` reste
  (liste des blocs « coûteux ») mais ne bloque plus.
- Blocs neufs : `periods` (route 1 ; items vides, `meta.periods` = la liste) et `grid` (route 3 pour la classe ou le
  groupe et la période `options['period']`, service `options['service']` ou chaque service du compte dans la
  ressource ; items par élève : `['bilan6' => …]`, section 5).
- Option `period` respectée par tous les blocs qui lisent une période (lecture d'une période donnée) ;
  `context()['periods']` porte `start`, `end` (de `get_grade_context()`).

### 6.3 Outils Pronote du connecteur (`local_olutionmcp` 0.59.0, NP)

- `plan_pronote_positioning` (neuf, `M/classes/tool/people/`, opération `M/classes/plan/op/pronote_positioning.php`) :
  paramètres `class` (ou groupe `g:…`), `period`, `service`, `items[{student, kind: positioning|lsu, value}]`
  (100 au plus). Toujours risque élevé ; plan conforme à la section 7 ; `apply()` appelle `write_positioning(…,
  false)` et s'arrête à la première écriture non relue (erreur `positioning_not_saved` relayée avec ce qui a été
  fait) ; `inverse()` resaisit les valeurs d'avant.
- `plan_pronote_report_comment` : même forme de plan (section 7) ; `confirmrisk` et `confirmvolume` restent acceptés
  mais **ne sont plus exigés** (le plan est le seul garde-fou, D35). Descriptions de `plan_pronote_report_comment` et
  `get_pronote_report_comments` corrigées : l'écriture des appréciations est validée en réel le 24/11 (création,
  effacement) ; la **modification** d'une appréciation existante n'a jamais été essayée.
- `get_pronote_report_comments` : `general.reason` peut valoir `pronote_refused` (plus `not_principal`).

## 7. Plan d'écriture dans Pronote : ce qu'il montre (D35)

Commun à `plan_pronote_positioning`, `plan_pronote_report_comment` et au bouton « Préparer l'envoi » du module. Le
plan (`item->after` et le résumé rendu à Claude) porte, en tête :

```json
{"summary": {"class": "…", "service": "…", "period": "…", "students": 27, "writes": 41,
             "replaces": 3, "skipped": 2, "audience": "familles à la publication du bulletin ; export LSU",
             "rollback": "resaisie des valeurs d'avant tant que la période est ouverte",
             "irreversible": "une valeur lue par une famille ou exportée vers le LSU avant le retour arrière",
             "notvalidated": ["modification d'une appréciation existante"]},
 "replaced": [{"student": "…", "kind": "…", "before": "…", "after": "…"}],
 "skipped": [{"student": "…", "kind": "…", "reason": "not_editable|period_closed|student_not_found|unchanged"}],
 "cells": [{"student": "…", "kind": "…", "before": "…", "after": "…"}]}
```

Accepté une fois, le plan s'applique en entier ; chaque écriture est relue par le sidecar ; arrêt à la première non
retrouvée, en disant où ; refus de Pronote relayé tel quel ; retour arrière par resaisie. Réglage `bilan6.only_empty_
cells` (faux par défaut) : ne propose que les cellules vides.

## 8. Module de suivi : interfaces neuves entre lots

- **Catégories (N2a)** : `S/classes/engine/categories.php` : `categories::decide(array $course, array $student,
  array $class, array $settings): array` → `['category' => current|past|optional|excluded, 'rule' => code de règle,
  'note' => '' | 'other_level' | 'pre_030']`. `engine\teacher::courses()` s'en sert (un cours `past`, `optional` ou
  `excluded` n'entre pas dans `R` ni dans `E` par défaut ; `optional` en `bonus` ajoute la composante `O` à `INV`).
  Instantané sans `enrolments` : comportement de la 0.2.0, note `pre_030`.
- **Périodes (N2b)** : `S/classes/store/period_repository.php` (périodes d'une classe, table `period`),
  `S/classes/store/gradeperiod_repository.php` (`freeze(...)`, `move(int $studentid, int $itemid, string $code, int
  $userid)`, `move_activity(int $classid, int $itemid, string $code, int $userid)`, `release(...)` — rendre à
  l'automatique, `history(...)`) ; `S/classes/store/pscore_repository.php`. Le score de la table `score` reste la
  **lecture principale** (période en cours par défaut, `periods.default_view`) ; `pscore` porte chaque période et `Y`.
- **Mode enseignant et collecte (N3)** : `S/classes/store/blockstate_repository.php` (`get`, `mark(int $classid,
  string $block, string $code, string $state, string $reason, int $nextread)`, `due(int $classid, int $now)`,
  `retry(int $classid, string $block)`), `S/classes/collect/pass.php` (une passe : budget, plus en retard d'abord,
  reprise). `outcome::STRUCTURAL` couvre `not_taught`, `access_denied`, `pronote_refused` : ces sources ne sont plus
  listées par `get_suivi_health`, les pages ni les notifications (elles restent dans l'instantané).
- **Propositions (N5, N6)** : `S/classes/store/proposal_repository.php` (`upsert(...)` : une proposition `pending`
  survit à la collecte suivante tant qu'elle n'est ni envoyée ni écartée ; une valeur recalculée différente remplace
  la valeur proposée et garde l'état ; `dismiss`, `mark_planned`, `mark_sent`, `pending_count(int $classid)`) ;
  `S/classes/collect/proposals.php` (fin de collecte : appelle les fournisseurs `proposals\bilan6` (N5) et
  `proposals\appraisal` (N6), classes de `S/classes/collect/proposals/`) ; `S/classes/local/pronote_plan.php` (N5) :
  construit les paramètres de `plan_pronote_positioning` / `plan_pronote_report_comment` et crée le plan au nom de
  la personne connectée (`M/classes/plan/manager::create`), **sans l'appliquer**.
- **Appréciations (N6)** : saisie `appraisal`, `itemkey` : `''` (0.2.0 : service principal du propriétaire),
  `general`, `s:<id de service>` ; un projet engendré a l'origine `generator` ; un texte d'origine `page` ou `mcp`
  n'est jamais écrasé.
- **Pages de réglages (N4)** : page `S/reglages.php?level=&classid=&studentid=&profile=&section=` ; bouton partiel
  `S/templates/settings_button.mustache` ; aide `S/classes/view/settings_link.php::url(string $level, array $ids,
  string $section): \moodle_url` et `::context(...)` pour le gabarit. Les autres lots appellent cette aide et
  incluent le partiel dans **leurs** gabarits neufs.
- **Voix de l'élève (N7)** : `S/classes/source/feedback.php` (lecture d'un Feedback nominatif par l'API du cœur ;
  anonyme → refus `feedback_anonymous`), `S/classes/store/voice_repository.php`, `S/classes/local/voice_rubrics.php`
  (rubriques stables : `school`, `helps`, `hinders`, `dropped`, `subjects`, `interests`, `project`, `expectations`,
  `unsaid`).

## 9. Propriété des fichiers

Un fichier existant n'a qu'un propriétaire par vague. Fichiers neufs : celui qui les crée. Tout le reste de `S/`, `P/`,
`M/` : personne (fragment).

| Vague | Lot | Possède |
|---|---|---|
| 0 | N0 | `db/*`, `version.php`, `lang/*`, `local/defaults.php`, `local/periods.php` (création), schéma, `privacy/provider.php` (TABLES), listes de tables des trois tests, `M/classes/sql/masking.php`, `docs/olutionsuivi/` |
| 1 | NS | `SC/**` |
| 1 | NP | `P/classes/**` (hors `db`, `lang`, `version`), `P/tests/**`, `M/classes/tool/people/*pronote*`, `M/classes/plan/op/pronote_*`, `M/classes/tool/registry.php`, `M/classes/plan/operation_registry.php`, `M/tests/tool/people/**`, `docs/pronoteio/**` |
| 1 | N1 | `S/classes/local/registry*`, `S/classes/local/presets.php`, `S/classes/engine/settings.php`, `S/classes/store/settings_repository.php`, `S/classes/store/preset_repository.php`, `M/classes/tool/suivi/plan_suivi_settings.php`, `M/classes/plan/op/suivi_settings.php`, `M/classes/plan/op/suivi_base.php`, leurs tests, `S/tools/` (documentation engendrée) |
| 2 | N2a | `S/classes/source/moodle*`, `S/classes/engine/teacher.php`, `S/classes/engine/categories.php`, `S/classes/local/registry/keys_courses.php`, vues neuves `view/classroom/courses.php`, `view/student/pastcourses.php` et leurs gabarits, tests |
| 2 | N3 | `S/classes/collect/**`, `S/classes/source/pronote.php`, `S/classes/source/registry.php`, `S/classes/store/blockstate_repository.php`, `S/classes/view/classroom/sources.php`, `view/student/bulletin.php` (neuf), `keys_collect.php`, `M/classes/tool/suivi/get_suivi_health.php`, tests |
| 2 | N4 | `S/reglages.php`, `S/classes/view/settings*`, `S/templates/settings*`, `S/classes/view/class_view.php`, `student_view.php`, `classes_view.php`, `S/templates/class.mustache`, `classes.mustache`, `student.mustache` (inclusion des partiels déposés en fragment par N2a et N3), e2e des réglages |
| 3 | N2b | `S/classes/engine/calculator.php`, `S/classes/engine/input.php`, `S/classes/local/periods.php`, `S/classes/source/moodle*`, `S/classes/collect/assembler.php`, `S/classes/collect/pipeline.php`, `S/classes/store/note_repository.php`, dépôts `period`, `gradeperiod`, `pscore`, `keys_periods.php`, vues et gabarits principaux (`class_view`, `student_view`, `class.mustache`, `student.mustache`), tests |
| 3 | N5 | `S/classes/engine/bilan6.php`, `S/classes/store/proposal_repository.php`, `S/classes/collect/proposals*`, `S/classes/local/pronote_plan.php`, `keys_bilan6.php`, vues neuves `view/classroom/bilan6.php`, `view/student/bilan6.php` + gabarits, AMD neuf, tests |
| 3 | N7 | `S/classes/source/feedback.php`, `S/classes/store/voice_repository.php`, `S/classes/local/voice_rubrics.php`, `keys_voice.php`, `view/student/voice.php` + gabarit, `S/classes/source/external*` (import vers rubriques), `docs/olutionsuivi/formes/questionnaire_eleve.md` (neuf), tests |
| 4 | N1b | `S/classes/engine/calculator.php`, `S/classes/engine/alerts.php`, `S/classes/engine/stats.php`, `S/classes/engine/input.php`, `S/classes/collect/pipeline.php`, `S/classes/collect/recompute.php`, `keys_student.php`, tests du moteur |
| 4 | N6 | `S/classes/engine/appraisal*.php`, `S/classes/store/wprofile_repository.php`, `S/classes/collect/proposals/appraisal.php`, page `S/profiles.php`, vues et gabarits `profile*`, `S/classes/store/note_repository.php`, `view/student/followup.php`, `view/student/note_fields.php`, `keys_appraisal.php`, tests |
| 4 | N8a | `S/classes/collect/**` (hors `proposals*`, `pipeline.php`, `recompute.php`), `S/classes/view/classroom/refresh.php`, `S/classes/store/purge*`, `S/classes/store/student_repository.php`, `S/classes/source/registry.php`, `keys_misc.php`, outils `M/classes/tool/suivi/*` hors `plan_suivi_settings`, tests |
| 4 | N8c | `S/classes/view/**` (hors `student/followup.php`, `student/note_fields.php`, `classroom/refresh.php`), gabarits `class*`, `classes*`, `student*` (hors ceux de N6), `S/styles.css`, pages `index.php`, `class.php`, `student.php`, `print.php`, e2e `class/` et `student/`, tests des vues |

Insertion dans un gabarit principal ou une vue principale qui n'est pas à toi : fragment `wiring.md` (quoi, où, avec
quelles données) ; l'orchestrateur l'assemble entre deux vagues.

## 10. Ce que chaque lot rend

Branche poussée, PR en brouillon vers `claude/gallant-turing-lu9vxj`, passation (section 1), ligne de `TABLEAU.md`,
fragments. Et quinze lignes au plus en fin de session : état, branche, tests (commande et nombres), critères cochés ou
non, fragments.
