# Journal des versions — pronoteio-sidecar

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
