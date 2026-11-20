# Journal des versions — pronoteio-sidecar

## 0.12.0 — vue du professeur principal : bulletins, vie scolaire, fiche élève, photos

Cas du 20/11/2026 (T06, 31 élèves, sessions mobile et web ouvertes) : le connecteur ne rendait qu'une partie de ce que
le professeur principal voit dans Pronote web. Notes : le seul service du compte ; appréciations générales absentes sans
explication ; absences limitées aux cours du compte, puis `rate_limited` et délai dépassé ; photos non transmises ;
32 membres de `FicheEleve` non associés. Contrat : `docs/pronoteio/vue-pp.md` (dépôt `mood_prod`), client
`local_pronoteio` 0.20.0. Lecture seule. Rétrocompatible : les réponses 0.11 gardent leurs membres.

**Aucune fonction ajoutée n'a été appelée sur un vrai serveur** (développement sans connexion à Pronote). Une forme non
reconnue répond `available:false`, `reason:"format_unknown"` et `shape` (chemins et types, jamais une valeur) ;
`GET /pp/check` donne ces formes en une fois.

- **Fonctions** (`src/teacher/functions.ts`, modifiables par `PRONOTEIO_FUNCTIONS_FILE`) : `transcript`
  (`PageReleve`, 12), `classResults` (`ResultatsClasses`, 64), `studentLifeRecap` (`RecapitulatifVSEleve`, 19),
  `studentNotebook` (`PageSaisieCarnetCorrespondance`, 78), `studentMemos` (`ListeMemosEleves`, 105). Coût 2 jetons
  pour `PageReleve` et `RecapitulatifVSEleve`.
- **`GET /reports`** : `student`, `offset`, `limit` (40 au plus), `source` (`reportcard`, `transcript`). Réponse
  paginée `{available, reason, source, total, offset, items, read, remaining, partial, retry_after}` ; refus de
  Pronote en `available:false` avec `onglet` et `space`. Bulletin enrichi : `state` (`published`, `unpublished`,
  `empty`), `rank`, `classSize`, `publication`, et par matière `rank`, `group`, `subservices[]`, `assessments[]`
  (relevé). Noms de membres lus sans tenir compte de la casse. Sans paramètre de page : toute la classe, comme avant.
- **`GET /reports/results`** : résultats de la classe (`ResultatsClasses`), décodage tolérant d'un tableau colonnes
  (matières) × lignes (élèves).
- **`GET /reports/comments`** : seule la rubrique nommée « globale » (ou de genre 0) était lue, et tout échec était
  silencieux : rien ne revenait dans un établissement qui la nomme autrement. Toutes les rubriques non pères sont
  lues (8 au plus) ; `general {available, reason, kind, kinds}` dit pourquoi rien ne revient (`not_principal`,
  `access_denied`, `no_kind`, `format_unknown` + `shape`) ; `students[].generals[]` ; un professeur principal sans
  service dans la classe reçoit `service:null` et les appréciations générales au lieu de `404 service_not_found`.
- **`GET /classlife`** (`src/teacher/classlife.ts`) : vie scolaire d'une page d'élèves sur une période (400 jours au
  plus). Sources : `recap` (récapitulatif de l'élève, toutes matières), `carnet` (carnet de correspondance, forme
  relevée sur la démo), `callsheets` (feuilles d'appel des cours du compte, semaine par semaine, `own_lessons`, en repli
  quand `recap` ne répond pas). Événements typés (absence, retard, exclusion, punition, observation, infirmerie,
  dispense), dédoublonnés entre sources ; `totals` calculé sur `events`. Motifs des absences, retards, dispenses et
  passages à l'infirmerie seulement avec `include=motives` ; jamais le commentaire de l'infirmerie. Les semaines de
  feuilles d'appel lues restent dix minutes en mémoire : un `429` faute de temps avance d'autant au renvoi.
- **`GET /students/files`** : tous les membres vus en production le 20/11/2026 sont associés (`unmappedKeys` vide sur
  la fixture complète). Toujours : `birthplace`, `adult`, `groups` / `options` / `groupDetails` tirés de
  `listeRessources` (nature devinée du libellé : spécialité, langue, option, groupe). `include` : `contact` (adresse,
  portable avec indicatif), `school` (délégué, engagements, sortie, transport, casier, self, AESH, tuteurs, professeurs
  principaux, équipe pédagogique, préférences de communication), `memos` (`ListeMemosEleves`, mémos puis
  valorisations ; refus : ceux de la fiche). Responsables : `order`, `authority`, `mail`, `sms`, `emailAllowed`,
  `phoneDetails` ; `unmappedGuardianKeys`. Santé : `planDetails` (type normalisé, intitulé, dates, aménagements,
  documents), `allergies` ; `plans` et `medical` inchangés.
- **`GET /students/photos`** : photos d'une page (10 au plus) ou d'un élève, une seule lecture de la liste. Ni cache
  ni tâche.
- **`GET /pp/check`** : statut (`ok`, `access_denied`, `tab_closed`, `format_unknown`, `error`) et forme de la réponse
  de chaque fonction du lot sur le premier élève ; aucune valeur.
- File et cache : `/reports`, `/classlife`, `/students/photos`, `/pp/check` en priorité « lot » (lecture unitaire avec
  `student=`) ; `/classlife` (120 s) et `/reports/results` (60 s) en cache ; une réponse partielle n'est plus mise en
  cache ; `/classlife`, `/reports/results`, `/reports/comments` permises dans une tâche.
- `contracts/` : `studentFile`, `guardian` et `GET /students/files` mis à jour (contrat strict).
- Non fait : bulletins des années précédentes (`ListeElevesBIA`), dossiers (`PageDossiers`), `regime` (aucun membre
  de la fiche ne le porte dans le relevé du 20/11/2026) ; l'écriture des appréciations générales
  (`commentsWrite.ts`) cherche encore la rubrique par son libellé.
- Tests : `test/report-cards.test.ts`, `test/comments-general.test.ts`, `test/classlife.test.ts`,
  `test/students-full.test.ts` ; fixtures `report-card-terminale`, `student-file-full`, `student-life-recap`,
  `student-notebook` (noms fictifs).

## 0.11.5 — compétences : nom des élèves

- Première lecture réelle des compétences sur l'Espace Professeurs web (20/11/2026, 6-SC-603 : 4 évaluations, 66
  niveaux) : aucun niveau ne portait le nom de l'élève (`L` et `eleve.V.L` absents des lignes de
  `ListeElevesCompetences`), donc aucun rapprochement avec Moodle, et une écriture n'aurait trouvé personne. Le nom
  est maintenant cherché dans `L`, `eleve`/`Eleve` (enveloppé ou non), `libelle`, nom + prénom, puis dans la liste
  d'élèves voisine (`listeEleves`…) par identifiant ; à l'écriture, une ligne sans nom est complétée par la liste de
  la classe de la même session. Sans nom trouvé, le journal d'accès porte `shape` : les noms des membres de la ligne et
  de la page, jamais leurs valeurs.
- Tests : `test/competencies.test.ts`.

## 0.11.4 — connexion web : fin de connexion tolérante

- Cas du 20/11/2026 (journal de 0.11.3) : liaison de l'Espace Professeurs web avec le code PIN, PIN accepté et appareil
  enregistré, puis `TypeError` à l'étape `web:finish` : le décodeur de pawnote (`ParametresUtilisateur`) casse sur la
  réponse de l'espace web. L'identité de l'utilisateur (`ressource` : identifiant, genre, nom, établissement) est
  désormais relevée au passage, et la session web est terminée avec elle quand le décodeur échoue, après le PIN
  (`web:finish-tolerant:…`) comme à une connexion suivante sans PIN (`web:login-tolerant:…`). Le journal donne le
  champ en cause (`reading:<propriété>`), jamais de donnée.
- Tests : `test/web-space.test.ts`.

## 0.11.3 — diagnostic des erreurs de connexion web

- Journal d'accès : une erreur inattendue (502 `pronote_error`) porte maintenant `kind` (nom de l'erreur, jamais son
  message) et, pour une connexion à l'Espace Professeurs web, `step` : `web:login`, `web:security`, `web:pin-check`,
  `web:pin-save`, `web:source-save`, `web:finish` ou `web:session`. Cas du 20/11/2026 : liaison web avec le code PIN
  refusée en 326 ms par `pronote_error`, sans aucune indication de l'étape (le chemin après le PIN n'avait jamais été
  parcouru en production).
- Test : `test/web-space.test.ts`.

## 0.11.2 — compétences lues sans la session web : refus explicite

- `GET /competencies` : sans l'onglet 65 (session mobile lue sans la session web, par exemple quand l'Espace
  Professeurs web demande le code PIN), les services de l'onglet 65 ne sont pas listés et la réponse était
  `available: true` avec 0 service, ce qui se lisait comme « rien à évaluer ». Elle est maintenant
  `available: false`, `reason: "access_denied"`, `onglet: 65`, `space: "mobile"` ; `local_olutionmcp` 0.49.2 donne
  alors la marche à suivre (mot de passe et PIN). Constat en production du 20/11/2026 (classe 6-SC-603).
- Test : `test/web-space.test.ts`.

## 0.11.1 — appareil de confiance du web, classes des cours, heures des rencontres

- **Connexion web** (`POST /session/login`, `space: "web"`) : nouveau champ facultatif `navigator`, renvoyé dans la
  réponse. C'est l'identifiant de navigateur (`identifiantNav`) que Pronote donne à la session web : l'Espace
  Professeurs web reconnaît un appareil de confiance par lui, et non par `deviceuuid` comme l'application mobile.
  Sans lui, chaque connexion web venait d'un nouveau navigateur et la double authentification demandait le code PIN à
  chaque fois (`pin_required`), même après un enregistrement de l'appareil. `local_pronoteio` 0.19.1 le conserve et le
  renvoie. Non vérifié sur un vrai serveur Pronote.

- **Emploi du temps** (`GET /timetable`) : un cours d'une classe entière arrivait sans groupe (`groups: []`), pawnote
  ne gardant que les groupes (genre 2) d'un cours. `tools/patch-pawnote.mjs` y ajoute les classes (genre 1) et les
  parties de classe (genre 57), dans l'ordre de la réponse, comme `src/teacher/timetable.ts`. Cas du 20/11/2026 : les
  absences du cours d'enseignement scientifique de T06 et T11 (`get_pronote_attendance`) ne trouvaient aucun cours.
- **Rencontres** (`GET /meetings`) : la session et les lignes du planning portent `local` (heures murales). Sans lui,
  Moodle croyait parler à un sidecar antérieur à 0.9.0 (avertissement `sidecartimelegacy`).
- `tools/cpanel-update.sh` : `npm ci` aussi quand `tools/patch-pawnote.mjs` change (le correctif de pawnote est
  appliqué par le `postinstall`).
- Tests : `test/timetable-classes.test.ts`, `test/meetings.test.ts`, `test/web-space.test.ts` (`navigatorOf`).

## 0.11.0 — dates des périodes dans le contexte des notes

- `GET /grades/context` : chaque période porte `start` et `end` (premier et dernier jours, dates « murales »
  `2026-09-01`), lus dans les périodes des paramètres de l'instance (`session.instance.periods` de pawnote), rapprochées
  par identifiant puis par libellé ; absents quand Pronote ne les donne pas. `local_pronoteio` 0.19.0 s'en sert pour
  proposer la période du service qui contient la date de l'évaluation (tiroir « Destination Pronote » de push.php,
  plans `fromitem` du connecteur) ; sans elles, la période en cours. Rétrocompatible.
- Test : `test/grades.test.ts` (`periodDates`).

## Non publié — mise à jour automatique : plus d'arrêt silencieux (`tools/cpanel-update.sh`)

Cas du 19/11/2026 : la 0.10.0 change `package.json` ; le script fusionne, puis `source ~/nodevenv/…/bin/activate`
sous `set -u` : l'activation de CloudLinux lit `CL_VIRTUAL_ENV` et `BKP_PS1` sans valeur par défaut, bash s'arrête
(« unbound variable »). Ni `npm ci`, ni redémarrage, ni journal, ni `var/update-result.json` ; au passage suivant,
HEAD = origin, le script se croit à jour : le sidecar reste sur la 0.9.0. Fin faite à la main le 19/11.

- **Activation hors `set -u`** ; si elle échoue, `bin/` de l'environnement en tête du `PATH`
  (`activate failed (<code>): PATH fallback`).
- **Rattrapage** : à jour mais `/health/public` répond une autre version ou un autre commit que `package.json` @ HEAD →
  `npm ci`, redémarrage, vérification ; `<commit> half-finished update: resumed`, résultat `resumed` ou
  `resume_failed`. Pas de retour arrière. Une tentative par commit (pas de redémarrage toutes les 5 minutes).
- **Trace de toute sortie précoce** : piège `EXIT` ; arrêt après la fusion sans résultat → `aborted after merge
  (step: …, command: …, exit …)` et résultat `aborted` (renvoyé par `GET`/`POST /admin/update`). Le verrou de repli
  (`mkdir`, hôte sans `flock`) est libéré à toute sortie.
- **Plus de boucle après un retour arrière** : HEAD restait derrière origin, chaque passage refusionnait le même
  commit, redémarrait et revenait en arrière (un redémarrage toutes les 5 minutes, file et session perdues). Le commit
  revenu en arrière est noté dans `var/update-rejected` et n'est plus fusionné ; ligne `<commit> will not be merged
  again` ; résultat `rejected` pour le bouton (`PRONOTEIO_UPDATE_RESULT_WHEN_UP_TO_DATE`). Le commit suivant passe
  normalement et efface la marque. Nouvel essai : `rm var/update-rejected` ou `PRONOTEIO_UPDATE_RETRY_REJECTED=1`.
  Rien n'est noté après `rollback_failed` (aucune version ne répond : l'hôte plutôt que le commit).
- Cron documenté avec `>>$HOME/logs/pronoteio-sidecar-cron.log 2>&1` (en-tête du script, README, déploiement).
- Le cron exécute l'ancienne copie du script une dernière fois, pour la fusion de ce correctif : elle ne change ni
  `package.json` ni `package-lock.json`, elle passe donc sans `install_dependencies`. Les fusions suivantes (dont la
  prochaine release, version montée) passent par le nouveau script.
- Tests (`test/update.test.ts`) : faux `curl` qui imite Passenger (code chargé au dernier redémarrage) ; activation qui
  lit des variables non définies, activation qui échoue, mise à jour à moitié faite (rattrapée ; rien quand le bon
  commit répond ; `resume_failed` une seule fois), arrêt après la fusion (`aborted`, puis `resumed`), commit revenu en
  arrière (pas refusionné, `rejected`, commit suivant fusionné, nouvel essai forcé, rien noté après `rollback_failed`).

## 0.10.0 — 2026-11-19 — Espace Professeurs web : seconde session pour les onglets absents de l'espace mobile

Cas du 18/11/2026 : la connexion par Pawnote ouvre l'espace mobile (`mobile.professeur.html`, 38 onglets), sans
compétences (55, 56, 65, 199, 200), bulletins (4, 13, 25, 27) ni relevé (12), que l'Espace Professeurs web ouvre
(`professeur.html`, mode Domicile, 158 onglets) : `GET /competencies` répondait `access_denied`, les groupes de 6e
évalués par compétences restaient invisibles. Contrat : `docs/pronoteio/espace-web.md` (dépôt `mood_prod`), client
`local_pronoteio` 0.18.0. Rétrocompatible : un client qui n'annonce rien garde le comportement 0.9.0.

- **Connexion web** : `POST /session/login` avec `space: "web"` et le mot de passe ; `tools/patch-pawnote.mjs` ajoute à
  Pawnote `pronoteioLoginWeb` (copie de `loginCredentials` : page `professeur.html`, sans `bydlg` ni demande de jeton
  mobile ; double authentification relayée en `pin_required`) ; navigateur de bureau (`webFetcher`). Le jeton mobile
  n'est pas accepté (`401 web_token_refused`, sans appel à Pronote). Une session web par compte, gardée à côté de la
  principale, jamais reconnectée (`401 web_session_expired`).
- **Choix de la session par onglet** (`src/space.ts`) : pour un client qui l'annonce (`X-Pronoteio-Web: 1` ou
  `X-Pronoteio-Web-Session`), un appel dont l'onglet manque à la session mobile s'arrête avant d'être envoyé ; la
  requête entière est rejouée sur la session web, ou `409 web_session_required` (`onglet`, `function`). Fonctions qui
  répondent sans leur onglet laissées sur la session mobile (`PRONOTEIO_MOBILE_WITHOUT_TAB`) ; `PRONOTEIO_WEB_ROUTING=off`.
  Les services de l'onglet 65 restent un enrichissement de `GET /grades/overview` (jamais de session web demandée pour
  eux). Plus de refus déduit de la seule liste d'onglets mobile (`PageBulletins`, contexte des bulletins).
- `GET /session/info` : `space`, `login`, `webtabs`. Refus des compétences : `onglet`, `space`. Codes stables
  `web_session_required`, `web_session_expired` ; `web_token_refused` → `login_failed`. Tâches (`POST /jobs`) : en-têtes
  web transmis à chaque lecture.
- **Référentiel par matière** (onglet 200, **non validé**) : `GET /competencies/referential/subjects?cycle=&subject=`
  (`ListePaliers`, `ListeTousPiliersDeCompetence`, `CompetencesGrilles`), éléments signifiants et items dans l'ordre de
  Pronote, identifiants stables par rang ; sans matière, matières par cycle ; forme inconnue : `format_unknown` et `shape`.
- Tests : `test/web-space.test.ts` (38 et 158 onglets du 18/11, session web pour l'onglet 65, onglet 16 sur la session
  mobile, client ancien, aperçu des notes sans session web, onglet absent des deux espaces, session web expirée, page
  `professeur.html` sans `bydlg` et navigateur de bureau, aucun identifiant dans les journaux, référentiel de 14 éléments
  et 74 items).
- **À valider sur le vrai serveur** : connexion web (PIN demandé ou non pour cette source), forme de `CompetencesGrilles`.

## 0.9.0 — 2026-11-17 — horaires, débit, cache, session, santé, mise à jour, contrats

Flux P (« sidecar plus robuste, plus rapide, observable »). Tout est rétrocompatible avec local_pronoteio 2026112100 :
aucun champ retiré ni renommé, les valeurs historiques de `error` sont conservées.

### Horaires (P1, bloquant)
- Les heures de Pronote étaient lues dans le fuseau de l'**hôte** : sur un hôte en UTC+1, ou avec une base de fuseaux
  antérieure au retour du Maroc à GMT (20/09/2026), une séance de 17:10 sortait à 16:10. Le processus passe en UTC et
  les heures sont converties dans `PRONOTEIO_TIMEZONE` (défaut `Africa/Casablanca`) avec la base la plus récente (Node
  ou paquet `tzdata` embarqué, via `timezonecomplete`). Aucun décalage codé en dur.
- Nouveau champ `local` (heure murale de Pronote, sans conversion) sur les séances, devoirs, cahier de textes,
  évaluations, notes, compétences, absences et rendez-vous ; en écriture, `local` est accepté et préféré.
- Identifiants inchangés (séances, évaluations prévues : heure murale ; compétences : horodatage hérité).

### Débit (P2, bloquant)
- Seau à jetons par session avec file d'attente à priorités (écritures, lectures unitaires, lectures de masse) au lieu
  d'un refus immédiat ; attente jusqu'à 20 s ; au-delà `429 rate_limited` avec `retry_after` et `Retry-After`.
- Coût par fonction Pronote ; plafonds réglables. `students/files?ids=…` : lecture de masse cadencée, résultats partiels.

### Cache (P3)
- Cache mémoire (jamais sur disque) des lectures, 60 s par défaut, invalidé par les écritures ; `X-Cache: hit|miss`.

### Requêtes longues (P4)
- Doublons du proxy : réponse partagée (inchangé depuis 0.6.1), en-tête `X-Pronoteio-Duplicate`, délai mesuré.
- Tâches asynchrones `POST /jobs`, `GET /jobs/{id}`.

### Session et processus (P5, bloquant)
- Verrou de processus unique (second processus : 503 `pronote_unavailable`, sans appel à Pronote).
- Une session par compte, réutilisée ; maintien de session (présence) ; reconnexion transparente avec la chaîne de
  jetons et rejeu unique de la requête (jamais pour une écriture déjà envoyée).
- État non personnel conservé au redémarrage (`var/state.json`).

### Changement de Pronote (P6)
- Version validée (2026.2.8) exposée partout ; version inconnue : écritures refusées sauf option.
- Format des réponses vérifié : `pronote_format_changed:<fonction>:<membre>` au lieu de données fausses.

### Erreurs (P7)
- `code` stable, `message` en français, champs du cas (`retry_after`, `candidates`, `fields`, `reason`) ; `GET /errors`.

### Santé et journaux (P8)
- `GET /health/public` (ok, version, commit court) ; `GET /health` signée : rapport complet sans donnée personnelle.
- Journal d'accès JSON sans URL ni donnée personnelle, avec rotation (`~/logs/pronoteio-sidecar.log`).

### Mise à jour (P9)
- `tools/cpanel-update.sh` : cron toutes les 5 min, `npm ci` si besoin, vérification de la nouvelle version et du
  nouveau commit, retour arrière automatique, verrou, journal ; `POST /admin/update` et `GET /admin/update`.

### Contrats (P10)
- `contracts/` : schémas des requêtes (toutes les routes) et des réponses principales, fixtures anonymisées, export
  versionné ; CI GitHub Actions (types, tests Node 20/22, dist à jour, npm audit, archive des contrats).

### Sécurité (P11)
- Fenêtre de signature 60 s, nonce obligatoire, rejeux refusés, rotation de clé (`PRONOTEIO_SECRET_PREVIOUS`), adresses
  autorisées (`PRONOTEIO_ALLOWED_IPS`), dépendances mises à jour (node-forge 1.4.3).

### Écritures vérifiées (P12)
- `verified` et `after` sur les écritures ; écart → `verified: false` pour un client du contrat 2 (502 sinon) ;
  `dryrun` en alias de `dryRun` ; filet de sécurité contre tout appel d'écriture pendant une simulation.

## 0.8.0 — 2026-11-17
- Compétences des groupes de collège : services de l'onglet 65, référentiel, niveau par défaut.

## 0.7.0 — 2026-11-16
- Cours en double au même créneau : identifiant unique, résolution, filtre des classes.

## 0.6.x
- 0.6.3 date de naissance à minuit UTC ; 0.6.2 clé opaque par élève ; 0.6.1 doublons du serveur web : réponse de la
  première livraison ; 0.6.0 chaîne des jetons Pronote.
