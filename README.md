# pronoteio-sidecar

Service Node.js (Fastify, Pawnote) qui fait le pont entre le plugin Moodle **local_pronoteio** (olution.info) et le
Pronote du lycée, avec le compte enseignant lié. Version **0.16.0** — voir [CHANGELOG.md](CHANGELOG.md).

- Hébergement : o2switch, cPanel « Setup Node.js App » (Phusion Passenger), fichier de démarrage `app.cjs`, code
  compilé versionné dans `dist/` (pas d'étape de build sur l'hôte).
- Mise à jour : cron cPanel `tools/cpanel-update.sh` (ou `POST /admin/update`), sortie gardée
  (`>>$HOME/logs/pronoteio-sidecar-cron.log 2>&1`, jamais `>/dev/null`) — voir
  [docs/deploiement-o2switch.md](docs/deploiement-o2switch.md).
- Échange signé : chaque requête porte `X-Pronoteio-Timestamp`, `X-Pronoteio-Nonce` et `X-Pronoteio-Signature`
  (HMAC-SHA256 du secret partagé), et `X-Pronoteio-Session` une fois connectée. 0.15.0 : `X-Pronoteio-Origin` et
  `X-Pronoteio-Account` (facultatifs, hors signature) nomment l'appelant et le compte dans le journal d'accès.

## Développement

```
npm ci
npm run dev          # tsx watch, lit .env
npm test             # node:test + tsx, fixtures anonymisées, jamais de connexion à Pronote
npm run typecheck
npm run build        # met à jour dist/ (à committer)
npm run contracts:fixtures && npm run contracts:requests   # après un changement de format
npm run contracts:export                                     # archive des contrats pour local_pronoteio
```

Node 20 ou plus récent (o2switch : choisir la version la plus récente proposée dans « Setup Node.js App »).

## Configuration (variables d'environnement ou `.env`)

Toutes sont décrites dans [.env.example](.env.example). Principales :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PRONOTEIO_SECRET` | — | Secret partagé avec Moodle (≥ 16 caractères, 32+ recommandés). |
| `PRONOTEIO_SECRET_PREVIOUS` | — | Ancien(s) secret(s) acceptés pendant une rotation. |
| `PRONOTEIO_MAX_SKEW` | 60 | Fenêtre d'une signature (s). |
| `PRONOTEIO_ALLOWED_IPS` | (toutes) | Adresses du serveur Moodle (IP ou CIDR IPv4). |
| `PRONOTEIO_WRITE_MODE` | simulate | `live` autorise les écritures dans Pronote. |
| `PRONOTEIO_TIMEZONE` | Africa/Casablanca | Fuseau de l'établissement (heures de Pronote). |
| `PRONOTEIO_MAX_CALLS_PER_MINUTE`, `PRONOTEIO_RATE_BURST`, `PRONOTEIO_MIN_SPACING_MS`, `PRONOTEIO_QUEUE_MAX_WAIT` | 120, 30, 150, 20 | Débit vers Pronote et attente maximale dans la file. |
| `PRONOTEIO_CACHE_TTL`, `PRONOTEIO_CACHE_TTLS`, `PRONOTEIO_CACHE_MAX_MB` | 60, —, 20 | Cache mémoire des lectures. |
| `PRONOTEIO_VALIDATED_VERSIONS`, `PRONOTEIO_ALLOW_UNVALIDATED_WRITES` | 2026.2.8, false | Versions de Pronote validées. |
| `PRONOTEIO_PUBLIC_URL` | — | URL publique (vérifications de la mise à jour). |
| `PRONOTEIO_LOG_FILE`, `PRONOTEIO_STATE_FILE`, `PRONOTEIO_LOCK_FILE`, `PRONOTEIO_TOKEN_STORE` | voir .env.example | Fichiers écrits (aucune donnée d'élève). |
| `PRONOTEIO_WEB_ROUTING` | on | 0.10.0 : `off` désactive le passage par l'Espace Professeurs web (comportement 0.9.0). |
| `PRONOTEIO_MOBILE_WITHOUT_TAB` | ListePeriodes,PageTrombinoscope,listeQCM | 0.10.0 : fonctions laissées sur la session mobile bien que leur onglet n'y soit pas listé. |
| `PRONOTEIO_COLLECT_PAUSE_MS`, `PRONOTEIO_COLLECT_WAIT` | 250, 900 | 0.16.0 : pause entre deux lectures internes d'une lecture groupée (ms) ; attente maximale d'une session fermée avant `partial` (s). |
| `PRONOTEIO_REFERENTIAL_GENRE` | 1 | 0.10.0 : `genreReferentiel` de `CompetencesGrilles` pour « par matière » (non validé). |

## Routes

Les schémas de requête de toutes les routes sont dans [contracts/requests.json](contracts/requests.json), les schémas
de réponse principaux dans [contracts/routes](contracts/routes). Nouveautés 0.9.0 :

| Route | Exemple |
| --- | --- |
| `GET /health/public` (publique) | → `{"ok":true,"version":"0.9.0","commit":"36c0657"}` |
| `GET /health` (signée) | → rapport complet : versions, fuseau, session, file d'attente, cache, doublons du proxy, version de Pronote, 20 dernières erreurs. Sans signature : comme `/health/public`. |
| `GET /errors` (publique) | → `{"version":"0.9.0","codes":[{"code":"rate_limited","status":429,"message":"…","action":"…","members":["retry_after"]}, …]}` |
| `GET /timetable?from=…&to=…` | items : `…,"start":1794503400,"end":1794506700,"local":{"start":"2026-11-12 17:10","end":"2026-11-12 18:05"}` |
| `GET /students/files?resource=c%3AT06&ids=e%3AMARTIN%20L%C3%A9a,e%3APETIT%20Hugo` | → `{…,"items":[…],"read":["e:MARTIN Léa"],"remaining":["e:PETIT Hugo"],"notFound":[],"partial":true,"retry_after":2}` |
| `POST /jobs` `{"requests":[{"url":"/roster?resource=c%3AT06"},…]}` | → `202 {"jobid":"…","status":"queued","progress":{"done":0,"total":10}}` ; `GET /jobs/{jobid}` → avancement puis `results` |
| `POST /admin/update` (signée) `{}` | → `{"running":false,"old":{"commit":"…","version":"0.8.0"},"new":{"commit":"…","version":"0.9.0"},"result":"ok","health":"0.9.0@…"}` |
| Toute écriture `…"dryrun":true` | résolution et validation complètes, `after` = ce qui serait écrit, aucun appel d'écriture |
| Toute écriture, champ `local` | `{"assessment":{"title":"DS","local":{"date":"2026-11-12 08:00"}}}` : préféré à l'horodatage |

### Espace Professeurs web (0.10.0)

Une connexion par Pawnote ouvre l'**espace mobile** de Pronote (`mobile.professeur.html`) : 38 onglets le 18/11/2026,
sans compétences (55, 56, 65, 199, 200), bulletins (4, 13, 25, 27) ni relevé (12), que l'Espace Professeurs web
(`professeur.html`, mode Domicile) ouvre. Détail et contrat : `docs/pronoteio/espace-web.md` du dépôt `mood_prod`.

| Route ou en-tête | Exemple |
| --- | --- |
| `POST /session/login` `{"url":"…","username":"…","deviceuuid":"…","password":"…","space":"web"}` | → `{"sessionid":"…","space":"web","login":"credentials","tabs":[…158…],"displayname":"…","version":"2026.2.8"}` (pas de jeton). Avec `token` au lieu de `password` : `401 web_token_refused`, sans appel à Pronote (le jeton mobile n'est pas consommé). PIN : `pin_required`, `bad_pin` comme pour l'espace mobile. |
| En-têtes `X-Pronoteio-Web: 1`, `X-Pronoteio-Web-Session: <id>` | Client capable d'ouvrir la session web (local_pronoteio 0.18.0). Une fonction dont l'onglet manque à la session mobile s'arrête **avant d'être envoyée** : la requête entière est rejouée sur la session web si elle est donnée, sinon `409 {"error":"web_session_required","onglet":65,"function":"ListeEvaluations"}`. Sans ces en-têtes, comportement 0.9.0. |
| `401 web_session_expired` | Session web inconnue ou expirée (jamais reconnectée : pas de chaîne de jetons) ; la session principale est gardée. |
| `GET /session/info` | + `"space":"mobile"`, `"login":"token"`, `"webtabs":[…]` (session web envoyée). |
| `GET /competencies/referential/subjects?cycle=Cycle%203&subject=SCIENCES%20ET%20TECHNOLOGIE` | Référentiel d'une matière (onglet 200, `ListePaliers`, `ListeTousPiliersDeCompetence`, `CompetencesGrilles`, **non validé**) : `elements[]` (`id` `rs:…`, `name`, `domains[]`, `reportElement`, `items[]` (`id` `ri:…`, `name`, `evaluable`, `levels`)) dans l'ordre de Pronote ; sans matière : `subjects[]` (`cycle`, `name`, `elements`, `items`, `classes`). Forme inconnue : `available:false`, `reason:"format_unknown"`, `shape`. |
| `GET /competencies?period=&classes=` | Évaluations par compétences des services (0.13.0, **non validé**) : `ListeEvaluations` en onglet 56 (« Saisie des évaluations »), sinon onglet 65 filtré par la classe de chaque évaluation ; `levels` (niveaux actifs de l'établissement), `statuses`, `levelsSource` (`school`, `fallback`), `services`, `items[]` (id `cp:…`, compétences, niveaux par élève). |
| `POST /competencies` | Création, niveaux, suppression d'une évaluation par compétences (0.13.0, **non validé**) : création sans élève, relecture par `RapportSaisie.listeEvaluationsCreees`, puis niveaux ; `created`, `publicationDefault`, `ratingsSent`, `ratingsSaved`, `warnings`, `requests`. Sans `publication` à la création : date par défaut de Pronote. Niveau refusé sans la liste de l'établissement (`levels_unknown`). |
| `GET /grades/context?competencies=1` | Contexte des notes avec les services de l'onglet Compétences (0.13.0) : `services[].kinds`. |
| Refus des compétences | `available:false`, `reason:"access_denied"`, + `onglet`, `space`. |

#### Garde des connexions web et origine des requêtes (0.15.0)

Incident du 21/11/2026 : une connexion web refusée par Pronote (`RateLimitedError`) toutes les 3 à 4 secondes pendant
près de trois minutes, sans que le journal dise qui appelait. Depuis 0.15.0, **aucun appelant ne peut produire une
telle rafale** : chaque connexion web passe par une garde tenue par compte (`src/webLoginGuard.ts`).

| Règle | Comportement |
| --- | --- |
| Une connexion en vol | Les `POST /session/login` `space: web` simultanés d'un compte (même mot de passe, même `pin`, même `navigator`) attendent la première et reçoivent **la même réponse** (même `sessionid` ou même erreur) : une seule connexion envoyée à Pronote. Une demande avec `pin` n'est jamais fusionnée avec une demande sans `pin` : elle passe après. |
| Session rendue | Sans `pin`, si la session web du compte est encore ouverte dans le sidecar : `200 {"sessionid":"…","displayname":"…","version":"…","space":"web","login":"credentials","tabs":[…],"navigator":"…","reused":true}`, sans appel à Pronote. Avec `pin`, ou avec un autre mot de passe que celui qui a ouvert la session : toujours une vraie connexion, qui remplace la session. Une session web que Pronote déclare perdue est oubliée aussitôt. |
| Reprise prudente | Après un refus de Pronote (limitation, adresse suspendue, page indisponible, compte désactivé, erreur réseau ou de décodage : échec répondu en 5xx), plus aucune connexion web sans `pin` vers Pronote pour ce compte avant **60 s, puis 2 min, 5 min, 15 min** (plafond). Pendant ce délai, réponse immédiate `429 {"error":"web_login_backoff","retry_after":57,"backoff_until":1795249577,"code":"web_login_backoff","message":"…"}` et en-tête `Retry-After: 57`. Une connexion avec `pin` passe ; refusée, elle allonge le délai. `pin_required`, `bad_pin`, `security_setup_required`, `double_auth_required`, `web_token_refused`, `bad_credentials` ne déclenchent pas de délai. Un succès efface tout. L'état survit à un redémarrage (`var/state.json`). |
| `409 web_session_required` pendant le délai | `{"error":"web_session_required","onglet":56,"function":"ListeEvaluations","retry_after":57,"backoff_until":1795249577,"code":"web_session_required","message":"…"}` : ne pas tenter de connexion web avant `retry_after` secondes. Sans délai en cours, ces deux champs sont absents. |
| `GET /session/info` | + `"weblogin":{"failures":1,"recentFailures":1,"backoffUntil":1795249577,"retryAfter":57,"lastFailureAt":1795249517,"lastKind":"RateLimitedError"}` pour le compte de la session : refus consécutifs de Pronote, connexions web échouées (toutes causes) des 10 dernières minutes, fin du délai (secondes Unix, `null` sans délai), secondes restantes (0 sans délai), dernier échec, nom ou code de sa cause (jamais un message). |
| `GET /health` (signée) | + `"webLogin":{"accountsInBackoff":1,"failuresLast10Min":3}`, sans identité de compte. |
| En-têtes `X-Pronoteio-Origin`, `X-Pronoteio-Account` | Facultatifs, sur **toute** requête, hors signature. `X-Pronoteio-Origin` : qui déclenche l'appel (`mcp:get_pronote_health`, `task:sync_task`, `page:local/pronoteio/push.php`), `^[a-z0-9][a-z0-9_.:/-]{0,79}$`. `X-Pronoteio-Account` : identifiant de compte haché par Moodle, `^[0-9a-f]{8,32}$`. Recopiés dans `origin` et `account` de chaque ligne du journal d'accès (secondes livraisons comprises) ; une valeur hors format est ignorée. Sans `X-Pronoteio-Account` valide, `account` porte 12 caractères hexadécimaux dérivés de la clé de compte du sidecar (compte de la connexion, sinon compte de la session) ; absent si aucun compte n'est connu. |

Ligne du journal d'accès : `{"t":"…","method":"POST","route":"/session/login","status":429,"origin":"mcp:get_pronote_health","account":"3f2a9c01d4e5b6a7","code":"web_login_backoff","ms":1,"bytes":190}`.

### Vue du professeur principal (0.12.0)

Bulletins de toutes les matières, vie scolaire de la classe, fiche élève complète, photos. Contrat et marche à suivre
pour la validation : `docs/pronoteio/vue-pp.md` du dépôt `mood_prod`. **Aucune de ces lectures n'a été validée sur un
vrai serveur** : quand la forme d'une réponse n'est pas reconnue, la route répond `available:false`,
`reason:"format_unknown"` et `shape` (chemins et types des membres, jamais une valeur). Fonctions ajoutées,
modifiables par `PRONOTEIO_FUNCTIONS_FILE` : `transcript` (`PageReleve`, 12), `classResults` (`ResultatsClasses`, 64),
`studentLifeRecap` (`RecapitulatifVSEleve`, 19), `studentNotebook` (`PageSaisieCarnetCorrespondance`, 78),
`studentMemos` (`ListeMemosEleves`, 105).

Les routes qui lisent un élève à la fois acceptent `student` (un élève) ou `offset` / `limit` (une page de la liste),
renvoient `total`, et, quand la file vers Pronote est pleine, les élèves déjà lus avec `partial:true`, `remaining` et
`retry_after` (un 429 seulement si aucun élève n'a pu être lu). Une réponse partielle n'est jamais mise en cache.

| Route | Exemple |
| --- | --- |
| `GET /reports?resource=c%3AT06&period=p%3ATrimestre%201&offset=0&limit=10` | Page de bulletins (`PageBulletins`) : `{available, source:"reportcard", total:31, offset:0, items:[{studentid, state:"published", average, rank, classSize, subjects:[{subject, teachers, coefficient, average, classAverage, min, max, rank, group, subservices[], comments[]}], comments[], attendance, publication}], read, remaining, partial, retry_after}`. `source=transcript` : relevé de notes (`PageReleve`), avec `assessments[]` par matière. Sans `student`, `offset`, `limit` ni `source` : toute la classe d'un coup, `{items}`, comme avant. |
| `GET /reports/results?resource=c%3AT06&period=…` | Résultats de la classe (`ResultatsClasses`) : `subjects[]` (moyenne de classe, min, max, enseignants), `students[]` (moyenne générale, rang, une moyenne par matière). |
| `GET /reports/comments?resource=c%3AT06&period=…` | + `general: {available, reason, kind, kinds[]}` (`not_principal`, `access_denied`, `no_kind`, `format_unknown`), `students[].generals[]` (toutes les rubriques non pères lues) ; professeur principal sans service dans la classe : `service:null` au lieu de `404 service_not_found`. |
| `GET /classlife?resource=c%3AT06&from=…&to=…&include=absences,lateness,observations&limit=10` | Vie scolaire par élève : `totals` (absences, demi-journées, non justifiées, heures manquées, retards, exclusions, punitions, infirmerie, dispenses, observations par type) et `events[]` datés. `include` : `absences`, `lateness`, `exclusions`, `punishments`, `observations`, `infirmary`, `exemptions`, `motives`. `sources` : `recap` (récapitulatif de l'élève, toutes matières), `carnet` (carnet de correspondance), `callsheets` (feuilles d'appel des cours du compte, `scope:"own_lessons"`, en repli quand `recap` ne répond pas). Année entière permise (400 jours). |
| `GET /students/files?…&include=contact,school,memos` | + adresse et portable de l'élève, délégué, engagements, AESH, tuteurs, professeurs principaux, équipe pédagogique, mémos ; toujours : `birthplace`, `adult`, `groupDetails[]` ; responsables : `order`, `authority`, `mail`, `phoneDetails[]` ; santé : `planDetails[]`, `allergies[]` ; `unmappedGuardianKeys`. |
| `GET /students/photos?resource=c%3AT06&offset=0&limit=10` | Photos d'une page d'élèves (10 au plus, ou `student=`) : `items:[{student, label, available, reason, mime, size, base64}]`. Jamais en cache ni dans une tâche. |
| `GET /pp/check?resource=c%3AT06` | Une lecture de chaque fonction du lot sur le premier élève : `checks:[{key, function, onglet, variant, group, status, detail, shape[]}]`, **aucune valeur**. Sert à valider ou corriger les décodeurs. 0.14.0 : `groups=core,life,reports,misc` (groupes de sondes), `function=<clé>` (une fonction, toutes ses variantes, forme entière par pages : `shapeoffset`, `shapelimit` ≤ 300, `shapeTotal`, `shapeMore`). 0.14.1 : un contrôle complet ne tient pas dans une requête ; il cesse de lancer des sondes après `budget` secondes (25 par défaut, 1 à 50) et nomme la première non faite (`next`), à redemander avec `from=<clé>`. Un seul contrôle à la fois par compte. |

#### 0.14.0 : corrections d'après le premier contrôle réel (20/11/2026)

Formes réelles relevées par `GET /pp/check` sur une classe de 31 élèves, lues avec le client web qui les affiche
(PRONOTE 2026.2). Rien n'est encore validé sur des valeurs réelles (`validated:false` partout).

- `GET /reports/results` : grille réelle de `ResultatsClasses` (`resultats[]`, `titresColonnes[]`, `moyennes[]`).
  `subjects[]` + `median`, `groupAverage`, `heading`, `detail` ; `students[]` + `lateness`, `absenceHalfDays`,
  `averages[].column`, `periods[]` (année) ; `general` (moyennes de la classe). Colonnes sans titre :
  `columnsUnnamed:true`, `subject:""` et `shape` (jamais un libellé deviné). Numéro national, date de naissance,
  dernier établissement et redoublement ne sont jamais lus.
- `GET /classlife` : `RecapitulatifVSEleve` donne des **totaux**, pas un détail daté : `items[].official`
  (`counts[]`, `bySubject[]`, `summary`), année scolaire, toutes matières. `totalsScope` (`all`, `own_lessons`, `none`)
  dit ce que couvrent `events` et `totals` ; `sources.*.detail`. Source `summary` (sur demande) : détail daté toutes
  matières par `DetailAbsences` (sans `professeur`), `ListePunitions`, `PageSuivisAbsenceRetard`, un état par fonction
  (`parts[]`), jamais vues répondre.
- `GET /reports/comments` : rubriques lues dans `liste` ; quatre variantes de requête essayées (`general.variant`) ;
  sans rubrique pour un professeur principal, appréciations générales lues dans les bulletins, par pages
  (`general.source:"reportcards"`, `general.page`, `offset`, `limit`) ; `general.reason` garde la cause première.
- `POST /reports/comments` : même résolution de rubrique que la lecture ; `generalKind` pour choisir ;
  `409 general_kind_ambiguous` et `404 general_kind_not_found` avec `candidates`, `404 no_kind`.
- `GET /students/files` : responsables (`responsibility`, `classDelegate`, `boardMember`, `emergency`, `emailReason` ;
  profession et situation jamais renvoyées) ; `groupDetails[].source` (`file`, `team`, `rosters`, `reportcard`),
  `groupsReason`, `regimeSource`, `regimeReason`, `memosReason` ; `include=groups` (listes d'élèves des groupes du
  niveau, gardées dix minutes, puis groupes des services du bulletin) ; mémos demandés avec `eleve` puis `Eleve` sur
  les onglets 105, 113 et 78.
- `GET /students/photos` : `reason:"download_refused"` quand le trombinoscope (`PageTrombinoscope`, 77) dit qu'une
  photo existe et que le téléchargement ne rend pas d'image ; `no_photo` sinon.
- Formes (`shape`) : membres des cinq premiers éléments d'une liste réunis, premier élément qui remplit un membre vide,
  classe de longueur des listes (`list[0]`, `list[1]`, `list[2+]`), types multiples (`object|null`).
- Fonctions ajoutées (sondées, `PRONOTEIO_FUNCTIONS_FILE`) : `lifeAbsenceDetail`, `lifePunishments`, `lifeFollowUp`,
  `lifeGrid`, `lifeAbsencesRecap`, `lifeCallSheetRecap`, `lifePunishmentsRecap`, `lifeIncidents`, `regimesList`,
  `transcriptCommentsPage`, `studentComments`, `pastReportStudents`, `pastReports`, `schoolingRecap`, `schoolRecord`,
  `studentFolders`, `multiYear`, `classPhotos`, `supportPlanDetails`, `teacherOpinions`.

Vie scolaire, à savoir : `totals` est calculé sur `events` (ils se recoupent toujours) ; les demi-journées d'une
absence sont celles que Pronote donne, sinon une estimation d'après ses heures (coupure à 13 h, dimanches exclus) ;
les motifs d'une absence, d'un retard, d'une dispense ou d'un passage à l'infirmerie ne sortent qu'avec
`include=motives`, le commentaire d'un passage à l'infirmerie jamais. Les feuilles d'appel d'une longue période
demandent beaucoup d'appels : les semaines lues restent dix minutes en mémoire, et une requête refusée faute de temps
dans la file (`429 rate_limited`, `retry_after`) avance d'autant quand elle est renvoyée.

### Suivi des classes (0.16.0)

Ce que le module de suivi des classes de Moodle (`local_olutionsuivi`, collecteur de `local_pronoteio`) lit chaque
semaine. Contrat : [docs/olutionsuivi/CONTRAT_SIDECAR.md](docs/olutionsuivi/CONTRAT_SIDECAR.md). Lecture seule.
**Aucune des quatre fonctions n'a été vue répondre avec ses valeurs** (`validated:false`). Leurs formes (noms et types
des membres) ont été relevées le 22/11/2026, dans [docs/olutionsuivi/formes/](docs/olutionsuivi/formes/) : le suivi
pluriannuel est décodé sur sa forme réelle ; pour les absences, la requête ne rend que le cumul de la classe, aucune
ligne par élève ; le livret scolaire n'était pas rempli (cadre seul) ; la forme des plans d'accompagnement reste
inconnue. Ce qui n'a pas été relevé est décodé par supposition, à listes de noms candidats. Une forme non reconnue donne
`available:false`, `reason:"format_unknown"` et `shape`, un refus de Pronote `reason:"access_denied"` avec l'onglet, sans
aucun autre appel à la place.
`GET /pp/check` dit pour chacune si son décodeur comprend la réponse (`ok` ou `format_unknown` avec la forme).
Fonctions (`PRONOTEIO_FUNCTIONS_FILE`) : `lifeAbsencesRecap` (`RecapAbsencesEleves`, 138), `supportPlanDetails`
(`DetailsPIEleve`, 105), `schoolRecord` (`LivretScolaire`, 83), `multiYear` (`PageSuiviPluriannuel`, 44) ; chacune
coûte 2 jetons de la file vers Pronote.

| Route | Exemple |
| --- | --- |
| `GET /classlife/absences?resource=c%3AT06[&from=…&to=…]` | Absences et retards de toute la classe, toutes matières, en **un** appel (année scolaire par défaut) : `{available, reason, validated:false, class, from, to, total, unmatched, items:[{studentid, label, lastname, firstname, totals:{absences, absenceHalfDays, unjustifiedAbsences, lateness, missedHours}, events:[{id, kind:"absence"\|"lateness", start, end, local, justified, halfDays, hours, minutes, subject, reasons:[]}], bySubject:[{subject, hours, lateness}]}]}`. `classTotals:{students, absences, missedHours, lateness, latenessMinutes, absenteeismRate}` : cumul de la classe (`LigneCumul`), `null` s'il manque. **Constat du 22/11/2026 : avec la requête envoyée, Pronote ne rend aucune ligne par élève** : `reason:"totals_only"`, `items:[]`, `classTotals` seul ; les absences datées de toutes les matières ne sont donc pas acquises (critères de requête à trouver, aucun n'est inventé). Cumuls par élève sans dates : `reason:"totals_only"`, `events:[]`. Un élément par élève qui a une ligne dans la réponse de Pronote ; `reasons` toujours vide (motifs jamais lus ici). Classe seulement (`409 resource_not_class` pour un groupe). Cache 120 s. |
| `GET /students/plans?resource=c%3AT06&offset=0&limit=10` | Plans d'accompagnement (ou `student=`, 40 élèves au plus) : `{available, reason, validated:false, class, total, offset, items:[{studentid, label, plans:[{type:"PAI"\|"PAP"\|"PPS"\|"PPRE"\|"accommodation"\|"other", label, title, start, end, comment, accommodations[], examAccommodations}]}], read, remaining, partial, retry_after}` ; Une réponse vide de Pronote vaut `plans:[]` (jamais un refus). `unreadable[]` et `shape` quand la réponse d'un élève n'est pas comprise alors que la fonction répond pour les autres ; `failed[]` (aussi dans `remaining`, `partial:true`) pour les élèves dont Pronote a répondu une erreur. Refus ou forme inconnue en cours de page : les élèves déjà lus sont rendus, les autres dans `remaining`, avec `reason`. **Donnée de santé** : jamais en cache ; au journal, ni taille de réponse ni forme. |
| `GET /students/history?resource=c%3AT06&offset=0&limit=10[&sources=livret,multiyear]` | Résultats des années précédentes (ou `student=`) : `{available, reason, sources:{livret:{available, reason, shape?}, multiyear:{…}}, items:[{studentid, label, sources, years:[{year:"2025-2026", label, level, average, classAverage, subjects:[{subject, average, classAverage, comment}]}]}], read, remaining, partial, retry_after}`. `PageSuiviPluriannuel` est lu sur sa forme relevée (`listeDonnees[]` par année, `listeSuivis[]` par matière ; barème et coefficient non rendus) ; un livret pas encore rempli est `available:true` sans année. Les deux sources sont fusionnées par année scolaire ; quand toutes les sources demandées se ferment en cours de page, `partial:true` et `remaining` ; `failed[]` pour un élève en erreur de Pronote ; une source refusée ou non comprise ne masque pas l'autre (`not_asked`, `resource_not_class` pour le livret d'un groupe). Cache 120 s. |
| `POST /collect` `{"resource":"c:T06","period":"p:Trimestre 1","blocks":["files","reportcards","results","comments","classlife","absences","plans","history","grades"],"options":{"files":{"include":"guardians"},"classlife":{"include":"absences,lateness","sources":"recap"},"grades":{"classes":"T06"}}}` | Lecture groupée d'une classe → `202 {"collectid":"…","status":"running","progress":{"done":0,"total":0,"block":null,"student":0}}`. Une seule par compte : sinon `409 collect_running` avec le `collectid` en cours. `collectid` : `[A-Za-z0-9_-]{8,64}`. `period` vaut pour tous les blocs qui prennent une période (absent : période courante). `options` : un objet par bloc ; listes en tableau JSON ou en chaîne à virgules ; `from`/`to` en secondes Unix. |
| `GET /collect/{id}` | `{collectid, status:"queued"\|"running"\|"waiting"\|"done"\|"partial"\|"failed", created, finished, expires, students, progress:{done, total, block, student}, retry_after, session:{mobile:"open"\|"closed", web:"open"\|"closed"\|"reopen_required"\|"backoff"\|"pin_required", reason}, blocks:{plans:{status:"pending"\|"running"\|"done"\|"partial"\|"unavailable"\|"failed", reason, validated, read, total, remaining}, …}}`. `read`/`total` comptent des élèves, ou 1 pour un bloc lu en une demande. |
| `GET /collect/{id}/results?block=plans&offset=0&limit=40` | Résultat du bloc, **dans la forme de la réponse de sa route**, comme si elle avait lu toute la classe : `items` fusionnés, `read`, `remaining`, `partial`. Porte toujours `total` (nombre d'`items` du bloc : il remplace ici le `total` de la route), `offset` et `limit` ; `offset`/`limit` paginent `items` (40 au plus). Lisible dès que le bloc est `done` ou `partial`, pendant que les autres tournent, et aussi quand il est `unavailable` ou `failed` : c'est alors le refus de sa route (`available:false`, `reason`, `shape` éventuel) avec `items:[]`. Un bloc dont la route n'a pas d'`items` (`results`, `comments`, `grades`) est rendu entier, `total:0`. Avant la fin du bloc : `409 collect_block_not_ready` (code `collect_running`). |
| `DELETE /collect/{id}` | Annule une lecture en cours, ou purge une lecture finie : `{collectid, cancelled:true}`. Idempotent : `404 collect_not_found` si elle est inconnue (ou déjà purgée). |
| `GET /session/info` | + `"state":{"mobile":"open","web":"reopen_required","reason":"web_session_expired","retry_after":0}` : mêmes valeurs que `session` d'une lecture groupée. |

Blocs et routes équivalentes : `files` → `/students/files` (`options.files.include`), `reportcards` → `/reports`
(`source=reportcard`), `results` → `/reports/results`, `comments` → `/reports/comments`, `classlife` → `/classlife`
(`options.classlife.include`, `sources`, `from`, `to` ; année scolaire par défaut), `absences` →
`/classlife/absences` (`options.absences.from`, `to`), `plans` → `/students/plans`, `history` → `/students/history`
(`options.history.sources`), `grades` → `/grades/overview` (`options.grades.classes`, la classe demandée par défaut).

Lecture groupée, à savoir (contrat 7.4, 7.4 bis, 7.4 ter) :

- le sidecar interroge ses propres routes, page par page (20 élèves), avec la priorité « lot » de la file vers Pronote
  (les écritures et les lectures unitaires de l'enseignant passent devant) et une pause entre deux demandes
  (`PRONOTEIO_COLLECT_PAUSE_MS`, 250 ms). Dix lectures actives au plus dans le processus (`429 rate_limited` au-delà) ;
- `students` est l'effectif de la classe ; `blocks.<bloc>.total` et `read` comptent les unités de travail du bloc
  (élèves, ou 1 pour un bloc lu en une demande) : ne jamais y lire l'effectif ;
- file pleine (`429`, ou page rendue partielle) : attente de `retry_after` (visible dans `GET /collect/{id}`), puis
  reprise **au premier élève non lu** : rien n'est perdu, rien n'est lu deux fois ;
- **erreur de Pronote sur un élève** : l'élève est mis de côté et la lecture du bloc continue. Les routes du suivi le
  nomment (`failed`) et gardent les élèves déjà lus de la page ; pour une route qui échoue en bloc (fiches, bulletins,
  vie scolaire), les élèves de la page sont redemandés un par un. Les élèves mis de côté sont redemandés une fois en
  fin de bloc ; s'il en reste, le bloc finit `partial` (`reason:"pronote_error"`, élèves dans `remaining`). Si
  personne ne peut être lu (fonction en erreur pour tous) ou au-delà de dix élèves en erreur, le bloc s'arrête ;
- une fonction refusée (`access_denied`), une forme inconnue (`format_unknown`), une demande refusée (4xx) : bloc
  `unavailable` (`partial` si des élèves avaient été lus) ; une erreur de Pronote sur un bloc lu en une demande
  (redemandée une fois) : `failed`. Les autres blocs continuent. `reason` est toujours un code, jamais un message de
  Pronote ;
- bloc `plans` : une réponse vide vaut « aucun plan ». Si aucun élève n'a de plan lisible, le bloc est `done` avec
  `reason:"all_empty"` : le client ne peut pas distinguer « aucun plan » de « détail non lisible » et s'en tient à la
  fiche élève ;
- `options.classlife.sources` : `recap`, `carnet`, `callsheets` seulement ; `summary` est refusé (`400
  invalid_sources:summary`) : il appelle des fonctions refusées au profil ;
- **état final** : `done` si tous les blocs sont `done` ; `failed` si aucun n'est `done` ni `partial` ; `partial`
  sinon. Se fier à l'état de chaque bloc ;
- **session manquante** (session web jamais ouverte ou fermée par Pronote, session principale perdue) : le bloc est mis
  de côté, les blocs qui n'en ont pas besoin continuent, et la lecture dit aussitôt `status:"waiting"`. Pour une
  session web : `session.web:"reopen_required"` et `session.reason:"web_session_required"`, **jamais `closed`** ;
  seuls `backoff` (avec `retry_after`) et `pin_required` remplacent `reopen_required`, parce qu'une connexion ne doit
  alors pas être envoyée. Le client rouvre la session web et envoie son identifiant dans `X-Pronoteio-Web-Session` au
  sondage suivant (`GET /collect/{id}`) : la lecture l'adopte et reprend où elle s'était arrêtée (elle retrouve aussi
  seule une nouvelle session du même compte) ; la page en cours au moment de la coupure (20 élèves au plus) est relue.
  Sans retour après `PRONOTEIO_COLLECT_WAIT` secondes (900), les blocs en attente finissent `unavailable` ou `partial` ;
- **durée de vie** : une lecture vit 60 minutes au plus ; ses résultats, en mémoire seulement, sont effacés par un
  minuteur 30 minutes après la fin, par `DELETE`, à la déconnexion du compte (`POST /session/logout`) et à la fin de
  la session à laquelle la lecture appartient. Une lecture appartient à un compte : seule une session vivante de ce
  compte la lit (`401 session_expired` avec un ancien identifiant, `404 collect_not_found` pour un autre compte) ;
  après un redémarrage, `404 collect_not_found` : relancer.

État des sessions (`state`, `session`) : `web` vaut `open` (session web du compte ouverte), `backoff` (délai de reprise
des connexions web : `retry_after`), `pin_required` (la dernière connexion web demandait l'enseignant et aucune n'a
réussi depuis), `reopen_required` (une session web était ouverte et ne l'est plus : une connexion sans PIN peut être
envoyée), `closed` (aucune depuis le démarrage). Rien n'appelle Pronote ni ne prolonge une session.

En-têtes de réponse : `X-Cache` (hit/miss), `Retry-After` (429), `X-Pronoteio-Pronote-Version`,
`X-Pronoteio-Pronote-Validated`, `X-Pronoteio-Duplicate` (seconde livraison servie). En-tête de requête facultatif
`X-Pronoteio-Contract: 2` (ou `contract=2` dans `X-Pronoteio-Client`) : un écart à la relecture d'une écriture est
renvoyé en `200 {"verified":false,"differences":[…]}` au lieu du 502 historique.

## Codes d'erreur (P7)

Toute erreur garde son champ historique `error` et porte un `code` stable et un `message` fixe en français (jamais
de donnée Pronote). Le tableau est aussi servi par `GET /errors`.

| code | Statut usuel | Sens | Conduite | Champs |
| --- | --- | --- | --- | --- |
| `rate_limited` | 429 | File d'attente vers Pronote pleine | Réessayer après `retry_after` s | `retry_after` |
| `session_expired` | 401 | Session Pronote expirée | Se reconnecter (jeton), renvoyer | |
| `session_replaced` | 401 | Session fermée par Pronote (autre poste) | Se reconnecter, renvoyer | |
| `login_failed` | 401/409 | Identifiants, jeton, PIN, double authentification | Vérifier la liaison (`error` précise) | |
| `pronote_unavailable` | 502/503 | Pronote ne répond pas, erreur, second processus | Réessayer plus tard | `reason` |
| `pronote_format_changed` | 502/409 | Format ou version de Pronote non validés | Mettre à jour le sidecar | `function`, `field`, `reason`, `pronoteversion` |
| `not_found` | 404 | Élément introuvable | Relire la liste | |
| `ambiguous` | 409 | Plusieurs éléments correspondent | Choisir dans `candidates` | `candidates` |
| `forbidden` | 403/409 | Droits, onglet fermé, mode simulation, saisie verrouillée, signature, adresse | Changer de réglage | |
| `validation_failed` | 400 | Champ manquant ou mal formé | Corriger `fields` | `fields` |
| `duplicate_write` | 401 | Requête signée déjà reçue | Ne pas renvoyer une écriture | |
| `web_session_required` | 409 | Onglet absent de la session mobile (0.10.0) | Ouvrir la session web, renvoyer avec `X-Pronoteio-Web-Session` ; si `retry_after` est présent (0.15.0), ne pas tenter de connexion web avant | `onglet`, `function`, `retry_after`, `backoff_until` |
| `web_session_expired` | 401 | Session de l'Espace Professeurs web expirée (0.10.0) | Rouvrir la session web, renvoyer | |
| `web_login_backoff` | 429 | Connexion web refusée par Pronote : délai de reprise en cours pour ce compte (0.15.0) | Ne pas tenter de connexion web avant `retry_after` s ; une connexion avec le `pin` saisi par l'enseignant reste possible | `retry_after`, `backoff_until` |
| `collect_running` | 409 | Lecture groupée du compte déjà en cours, ou bloc pas encore lu (0.16.0) | Suivre `GET /collect/{collectid}` ; lire un bloc quand il est `done` ou `partial` | `collectid` |
| `internal` | 500 | Erreur interne | Réessayer, voir `/health` | |

## Données personnelles (RGPD)

Le sidecar manipule des données de mineurs (fiches, notes, absences) pour le compte d'un enseignant.

- Cache des lectures, sessions Pronote, résultats des tâches : **en mémoire uniquement**, 60 s par défaut pour le cache,
  10 min au plus pour les tâches, tout est perdu au redémarrage. Jamais écrits sur disque.
- 0.12.0 : les photos ne passent ni par le cache ni par les tâches ; santé, mémos, coordonnées et motifs d'absence ne
  quittent le sidecar que si la requête les demande (`include`) ; les semaines de feuilles d'appel gardées dix minutes
  pour `GET /classlife` restent en mémoire et disparaissent avec la session.
- 0.16.0 : les plans d'accompagnement (`GET /students/plans`, bloc `plans`) ne passent jamais par le cache des
  lectures ; leur ligne de journal ne porte ni taille de réponse ni forme (`/collect/{id}/results` non plus) ; une forme
  non reconnue est décrite sans les noms sensibles. Les résultats d'une lecture groupée restent en mémoire 30 minutes
  après la fin, effacés par un minuteur (`DELETE /collect/{id}`, la déconnexion du compte et la fin de sa session les
  oublient aussitôt) ; ses lectures internes ne sont pas journalisées. Les réponses de `/students/plans` et de
  `/collect/{id}/results` ne sont pas gardées pour une seconde livraison de la même requête (elle est refusée). Les
  motifs d'absence ne sont jamais lus par `GET /classlife/absences`.
- Journaux : route-modèle, statut, code, durée, taille ; **jamais** d'URL (sa requête peut nommer un élève), de corps,
  d'en-tête, d'identifiant de session ni de message de Pronote. Les erreurs consignées ne gardent que code, route et
  heure. 0.15.0 : `origin` (nom de l'outil, de la tâche ou de la page appelante) et `account` (empreinte hachée du
  compte enseignant), deux en-têtes recopiés seulement s'ils respectent un format strict ; jamais d'identifiant de
  connexion. L'état de la garde des connexions web (`var/state.json`) ne désigne un compte que par une empreinte
  SHA-256.
- Fichiers écrits : chaîne de jetons chiffrée, état non personnel, verrou, journaux (voir
  [docs/deploiement-o2switch.md](docs/deploiement-o2switch.md)).
- Fixtures de test et de contrats : noms fictifs, aucune donnée réelle.
