# Journal des versions — pronoteio-sidecar

## 0.16.6 — appréciations : une cellule vide est créée, pas modifiée

Capture dans le navigateur, le 24/11/2026, sur le serveur réel (Pronote 2026.2.8) : saisie d'appréciations par le
client web, scénarios décrits dans `docs/pronoteio/prompt_capture_navigateur.md` (mood_prod). La cause du refus
« erreur modification libellé appréciation » est trouvée : pour une cellule vide, le client **crée** l'appréciation,
alors que le sidecar demandait la **modification** d'une appréciation qui n'existait pas.

- Cellule vide d'une matière ou de la classe (pas de `N` dans la grille) : `appreciation { N: <négatif>, G, L, E: 1 }`,
  avec un numéro provisoire décroissant comme le client (`-1001`, `-1002`…).
- Appréciation générale vide (`N "0"` dans la grille) : `{ N: 0, G, L, E: 1 }`.
- Appréciation existante (`N "10#…"`) : `{ N, G, L, E: 2 }`. Pour l'effacer, `L` n'est pas envoyé (et non envoyé vide).
- Appréciation de classe : `eleve: null` est envoyé, comme le client.
- Une cellule dont le texte ne change pas n'est plus envoyée.

## 0.16.5 — appréciations : éléments envoyés avec leur libellé

Essais réels du 24/11/2026 avec la 0.16.4, sur T11, T06, 6-SC-603 et 205, un élève dont la cellule était vide. Pronote
répond partout « erreur modification libellé appréciation », y compris avec un texte sans accent : la cause n'est ni le
mode exclusif (le refus est maintenant explicite), ni la classe, ni le texte.

- Le client web sérialise chaque élément avec `ObjetElement.toJSON` : `N`, `G` **et `L`**. La requête
  `SaisieAppreciation` envoie maintenant `classe`, `periode`, `eleve` et `service` avec leur libellé (et le genre de
  l'élève lu dans la grille), comme le client (`_interfacesaisieapprrelevebulletin.js`, `_saisirAppreciation`).
  Les lectures ne changent pas.
- Diagnostic : quand Pronote refuse l'écriture, la forme de la requête (noms des membres, genres, présence de `N` et
  `L`, jamais une valeur) est écrite dans le journal d'accès (`shape`).

## 0.16.4 — mode exclusif de Pronote : saisie annulée sans message

Les appréciations envoyées le 23/11/2026 étaient ignorées par Pronote sans message d'erreur. Le client web de Pronote
(démo 2026.2.8, `ObjetRequeteJSON`) lit `ModeExclusif` dans la signature de **chaque** réponse. Tant que ce champ vaut
`true`, il tient toute saisie pour annulée (« Saisie impossible, consultation seulement ») et n'en envoie plus. Le
sidecar ne lisait pas ce champ.

- Toute réponse : `ModeExclusif` est relevé ; `GET /health` le rend dans `pronote.exclusiveMode` (`value`, `seenAt`,
  `function`, `lastTrueAt`, `refusedWrites`), sans aucune donnée personnelle.
- Toute écriture (`sendWrite`) dont la réponse dit `ModeExclusif: true` est maintenant un refus explicite
  (`409 exclusive_mode`) au lieu d'une écriture « non retrouvée » à la relecture.
- Hypothèse à confirmer sur le compte réel : une lecture suffit pour voir la valeur (`pronote.exclusiveMode.value`).

## 0.16.3 — refus de Pronote relayé, cellules en lecture seule

- **Écriture refusée par Pronote** : essai réel sur T06 avec la 0.16.1 : HTTP 200, rapport de saisie `{ _messagesErreur_ }`
  seul, rien d'enregistré. Pour le client, des messages d'erreur dans le rapport annulent la saisie
  (`traiterReponseSaisie`) même sans `_erreurSaisie_` : une liste non vide est maintenant un refus (`pronote_refused`
  avec le texte de Pronote), pour toutes les écritures ; une liste vide reste une saisie acceptée.
- Appréciations : les messages du rapport (ou leur nombre) sont joints au diagnostic d'une écriture non retrouvée ; une
  cellule marquée en lecture seule par Pronote (`editable` / `estEditable` à `false`) est refusée dès le plan
  (`comment_not_editable:<élève>`).

## 0.16.2 — appréciations des groupes de 6e : passage en session web

Constat en production juste après la 0.16.1 : `GET /reports/comments` sur `6-SC-603` répondait encore
`service_not_found`, après deux appels seulement (périodes, services de l'onglet 23). La recherche du service dans les
onglets 25 et 65 avalait `WebSessionRequired` : sur la session mobile (sans ces onglets), elle rendait une liste vide
au lieu de demander la session web. Elle laisse maintenant remonter l'exception : la requête est rejouée sur la session
web, où le service du groupe est trouvé. Test de bout en bout ajouté (session mobile puis web, groupe sans service de
notes).

## 0.16.1 — appréciations de bulletin : groupes de 6e, écriture refusée en silence

Constats du 23/11/2026 sur le compte réel (lecture, aperçu de plan, une écriture d'essai sur T06 restée sans effet).

- **Groupes de 6e** (évalués par compétences seulement, `6-SC-603`, `6-SC-601-602`) : `GET` et `POST
  /reports/comments` répondaient `service_not_found`, le service n'étant cherché que parmi les services de notes
  (onglet 23). Il est maintenant cherché dans l'onglet 23, puis dans la liste de la page « Saisie des appréciations »
  (`ListeServices` signée 25 avec `Ressource` et `Periode`, comme le client), puis dans les services de compétences
  (onglet 65).
- **Classe ou groupe** : Moodle envoie `c:` devant tout libellé ; un groupe y répondait `class_not_found`. L'id est
  cherché dans le genre de son préfixe, puis dans l'autre (même libellé).
- **Écriture ignorée par Pronote** (HTTP 200, rien d'enregistré, `comment_not_saved`) : l'identifiant de
  l'appréciation était envoyé en chaîne `"0"`. La grille réelle ne donne pas de `N` pour une cellule vide
  (`appA` : `{ G, estEditable }`) et `"0"` pour une appréciation générale vide ; le client renvoie un `N` absent tel
  quel et `"0"` en nombre `0`. Le sidecar fait de même. La période est envoyée avec son genre réel.
- **Appréciation de classe** (pied de la grille) : `typeGenreAppreciation` 0 (`GA_Bulletin_Professeur`, comme
  `_saisirAppreciationClasse` du client) au lieu de 1 ; texte lu dans `appreciation` (forme réelle), non dans `L`.
- Ligne d'un groupe : la classe de l'élève (`classe` de la ligne) et le service de la ligne sont renvoyés tels quels
  quand la grille les donne ; colonne du professeur : la première de `appA`, `appB`, `appC` non marquée en lecture
  seule (`editable`/`estEditable` à `false`).
- Diagnostic : une écriture non retrouvée à la relecture met la forme des réponses de Pronote (noms des membres,
  jamais les valeurs) dans le journal d'accès (`shape`) et dans l'erreur (`detail`).

Non validé : l'écriture réelle après ce correctif (à refaire sur une cellule, puis à effacer) ; l'appréciation générale
d'une classe à bulletin de compétences (onglet 224, rubriques propres) n'est pas couverte.

## 0.16.0 — suivi des classes : absences de classe, plans d'accompagnement, années précédentes, lecture groupée

Lot L01 du chantier olutionsuivi (contrat : `docs/olutionsuivi/CONTRAT_SIDECAR.md`). Tout est en lecture seule.
**Aucune des quatre fonctions de Pronote lues ici n'a été vue répondre avec ses valeurs** (`validated: false`). Leurs
formes ont été relevées le 22/11/2026 (`docs/olutionsuivi/formes/`, noms et types seulement) : le suivi pluriannuel est
décodé sur sa forme réelle ; le reste (ligne d'absences par élève, ligne de livret, plan d'accompagnement) est décodé
par supposition, à noms candidats. Une forme non reconnue répond `available: false`, `reason: "format_unknown"` et
`shape` (jamais une valeur).

- **`GET /classlife/absences`** (`RecapAbsencesEleves`, 138) : absences et retards de toute une classe, toutes matières,
  en un appel ; année scolaire par défaut. Événements datés quand la fonction en donne, sinon `reason: "totals_only"`
  avec `totals` et `bySubject`. Les motifs ne sont jamais lus (`reasons: []`). **Constat du relevé : avec la requête
  connue, Pronote ne rend aucune ligne par élève**, seulement le cumul de la classe, rendu dans `classTotals`
  (`totals_only`, `items: []`). Les absences datées de toutes les matières ne sont donc pas acquises.
- **`GET /students/plans`** (`DetailsPIEleve`, 105) : plans d'accompagnement d'une page d'élèves. Donnée de santé :
  jamais dans le cache des lectures ; ligne du journal sans taille de réponse ni forme ; `shape` sans les noms
  sensibles.
- **`GET /students/history`** (`LivretScolaire`, 83 et `PageSuiviPluriannuel`, 44) : résultats des années précédentes,
  fusionnés par année scolaire ; l'état de chaque source est rendu par élève et pour la page. Le suivi pluriannuel
  est lu sur sa forme relevée ; un livret pas encore rempli est disponible, sans année.
- **Lecture groupée** : `POST /collect`, `GET /collect/:id`, `GET /collect/:id/results`, `DELETE /collect/:id`. Neuf
  blocs (`files`, `reportcards`, `results`, `comments`, `classlife`, `absences`, `plans`, `history`, `grades`), chacun
  rendu dans la forme de la réponse de sa route. Une seule par compte (`409 collect_running`). Priorité « lot » de la
  file vers Pronote ; après `rate_limited`, attente de `retry_after` puis reprise au premier élève non lu ; un bloc
  refusé ou en erreur n'arrête pas les autres ; session fermée en cours de série : `waiting`, reprise quand elle
  revient, `partial` à l'expiration (`PRONOTEIO_COLLECT_WAIT`, 900 s). Résultats en mémoire, 30 minutes.
  Précisions 7.4 bis du contrat : les résultats d'un bloc portent toujours `total` (nombre d'`items`), `offset` et
  `limit`, et sont lisibles pour un bloc `unavailable` ou `failed` (`items: []`) ; `DELETE` annule ou purge, de façon
  idempotente ; la session web rouverte par le client est adoptée depuis l'en-tête `X-Pronoteio-Web-Session` du
  sondage suivant.
  Précisions 7.4 ter (relecture du 22/11) : `students` (effectif) dans `GET /collect/:id` ; `waiting` et
  `session.web: "reopen_required"` dès qu'un bloc attend une session web, même jamais ouverte ; une erreur de Pronote
  sur un élève ne termine plus le bloc (élève mis de côté, redemandé une fois, `partial` s'il reste) ; `plans` : une
  réponse vide vaut « aucun plan », `reason: "all_empty"` si aucun plan n'est lisible ; `options.classlife.sources`
  sans `summary` ; état final `done` / `failed` / `partial` ; résultats effacés par minuteur, à la déconnexion et à la
  fin de la session ; un ancien identifiant de session n'ouvre plus rien ; `/students/plans` et
  `/collect/:id/results` hors du cache des doubles livraisons.
- **État des sessions** : `state` (`mobile`, `web`, `reason`, `retry_after`) dans `GET /session/info`, `session` dans
  `GET /collect/:id` ; `web` vaut `open`, `closed`, `reopen_required`, `backoff` ou `pin_required`.
- Refus de Pronote : `access_denied` avec l'onglet, un seul appel, retenu dix minutes pour les pages suivantes de la
  session ; aucune autre fonction n'est demandée à la place.
- `GET /pp/check` : les sondes de `RecapAbsencesEleves`, `DetailsPIEleve`, `LivretScolaire` et `PageSuiviPluriannuel`
  disent si le décodeur comprend la réponse (`ok`, ou `format_unknown` avec la forme).
- Coût dans la file : 2 jetons pour `DetailsPIEleve`, `LivretScolaire`, `PageSuiviPluriannuel`, `RecapAbsencesEleves`.
- Code d'erreur stable ajouté : `collect_running` (409, `collectid`). Variables : `PRONOTEIO_COLLECT_PAUSE_MS` (250),
  `PRONOTEIO_COLLECT_WAIT` (900).
- Contrats : schémas et fixtures de `classlife-absences`, `students-plans`, `students-history`, `collect-create`,
  `collect-get`, `collect-results`, `error-collect-running` ; `requests.json` à jour.

Pour `local_pronoteio` : rien ne change pour un client existant (routes et champs ajoutés seulement).

## 0.15.0 — connexions à l'Espace Professeurs web : garde par compte, origine de chaque requête

Incident du 21/11/2026 (08:24:20 à 08:27:03 UTC, `logs/pronoteio-sidecar.log`) : toutes les 3 à 4 secondes, la même
suite `GET /health`, `GET /session/info`, `GET /messages/preferences`, `GET /pp/check` (409 `web_session_required`),
puis `POST /session/login` de l'Espace Professeurs web (mot de passe) refusé par Pronote (502 `pronote_unavailable`,
`kind=RateLimitedError`, `step=web:login`), livré deux fois. Une rafale de connexions par mot de passe peut bloquer le
compte de l'enseignant, et le journal ne disait pas qui appelait. Le sidecar ne se connectait pas de lui-même : chaque
`POST /session/login` reçu devenait une connexion envoyée à Pronote, et des requêtes simultanées en faisaient autant.
Client : `local_pronoteio` (la chaîne d'appel côté Moodle est corrigée séparément).

- **Garde des connexions web, par compte** (`src/webLoginGuard.ts`, clé `accountKey`), quel que soit l'appelant :
  - *une seule connexion en vol* : les demandes simultanées de la même connexion attendent la première et reçoivent la
    même réponse (même `sessionid`, ou la même erreur). 20 demandes simultanées : une seule connexion envoyée à
    Pronote (20 auparavant, mises en file). Une demande avec `pin` (l'enseignant saisit le code de double
    authentification) n'est jamais fusionnée avec une demande sans `pin`, ni l'inverse : elle passe après ;
  - *session rendue* : une connexion web **sans `pin`** d'un compte dont la session web est encore ouverte dans le
    sidecar la reçoit telle quelle (`"reused": true`, même forme sinon), sans appel à Pronote, comme une connexion par
    jeton de l'espace mobile. Avec `pin` : toujours une vraie connexion, qui remplace la session. Avec un **autre mot
    de passe** que celui qui a ouvert la session : vraie connexion aussi (Pronote le vérifie ; sinon Moodle
    enregistrerait un mot de passe jamais contrôlé) ;
  - *reprise prudente* : après un refus de Pronote (limitation `RateLimitedError`, adresse suspendue
    `SuspendedIPError`, page indisponible, compte désactivé, erreur réseau ou de décodage : tout échec de la connexion
    répondu en 5xx), **aucune** connexion web sans `pin` n'est envoyée à Pronote pour ce compte avant 60 s, puis 2 min,
    5 min et 15 min (plafond). Pendant ce délai : `429 web_login_backoff` immédiat, `retry_after` (secondes),
    `backoff_until` (secondes Unix), en-tête `Retry-After`. Une connexion avec `pin` passe (geste de l'enseignant) ;
    refusée elle aussi, elle allonge le délai. Les issues interactives (`pin_required`, `bad_pin`,
    `security_setup_required`, `double_auth_required`, `web_token_refused`, `bad_credentials`) ne déclenchent aucun
    délai. Une connexion réussie efface le délai et le compteur ;
  - pendant le délai, `409 web_session_required` porte aussi `retry_after` et `backoff_until` : le client sait qu'il ne
    doit pas tenter de connexion web. Sans délai, la réponse est inchangée ;
  - l'état (compteurs, instants, nom de l'erreur : aucune donnée personnelle, compte désigné par une empreinte SHA-256
    de sa clé) est écrit dans `var/state.json` dès un refus : un redémarrage par Passenger n'efface pas un délai de
    15 minutes. Un compte sans échec depuis 24 h est oublié (le barème repart de 60 s).
- **Session web perdue** : une session web que Pronote déclare expirée ou fermée (rejeu d'une requête, session web
  envoyée comme session principale, requête de présence) est oubliée aussitôt ; la connexion web suivante est une
  vraie connexion, jamais la session morte.
- **Origine de chaque requête dans le journal d'accès** : deux en-têtes facultatifs de `local_pronoteio`, hors
  signature (ce ne sont que des étiquettes de journal, d'où des formats stricts ; toute autre valeur est ignorée) :
  `X-Pronoteio-Origin` (`mcp:get_pronote_health`, `task:sync_task`, `page:local/pronoteio/push.php` ;
  `^[a-z0-9][a-z0-9_.:/-]{0,79}$`) et `X-Pronoteio-Account` (identifiant de compte haché par Moodle,
  `^[0-9a-f]{8,32}$`). Chaque ligne porte `origin` et `account`, y compris `/session/login` et les secondes livraisons.
  Sans `X-Pronoteio-Account` valide, `account` porte 12 caractères hexadécimaux dérivés de la clé de compte du sidecar
  (compte de la connexion pour `/session/login`, compte de la session pour les autres routes) ; absent quand aucun
  compte n'est connu. Jamais d'identifiant de connexion ni d'adresse.
- **État exposé** : `GET /session/info` → `weblogin: {failures, recentFailures, backoffUntil, retryAfter,
  lastFailureAt, lastKind}` pour le compte de la session ; `GET /health` signé → `webLogin: {accountsInBackoff,
  failuresLast10Min}` (aucune identité de compte).
- **Code d'erreur** : `web_login_backoff` (429) dans le tableau des codes stables (`GET /errors`).
- Contrats : `backoff_until` et `web_login_backoff` dans `common.schema.json`, `webLogin` dans `health.schema.json`,
  `navigator` dans `session-login.schema.json` ; fixtures `session-login-web`, `session-login-web-reused`,
  `error-web-login-backoff`, `error-web-session-required-backoff`.
- Tests : `test/web-login-guard.test.ts` (connexion web de Pawnote remplacée par un bouchon, horloge injectée ; jamais
  de connexion à Pronote).

**Limites connues** : une suite d'issues interactives (par exemple `pin_required` à chaque connexion sans `pin`)
n'est pas retardée par le sidecar : chaque demande distincte reste une connexion envoyée à Pronote (les demandes
simultanées sont fusionnées) ; c'est au client d'arrêter ses connexions automatiques sur ces réponses, et
`weblogin.recentFailures` les compte. La reprise prudente ne concerne que l'Espace Professeurs web : les connexions de
l'espace mobile (jeton, mot de passe) gardent le comportement de 0.9.0.

## 0.14.1 — vue du professeur principal : corrections d'après les premières lectures en production

Premières lectures réelles du 21/11/2026 (0.14.0 en production, classe de terminale de 31 élèves) : bulletin, grille
`ResultatsClasses`, récapitulatif de vie scolaire, fiche, photo et page des appréciations générales se lisent. Cinq
défauts relevés, corrigés ici. Client : `local_pronoteio` 0.22.1.

- **Contrôle complet** (`GET /pp/check`) : 28 sondes sur 43 revenaient `rate_limited` sans qu'aucun appel ne soit en
  trop. La file refusait tout appel demandé après l'échéance de la requête (20 s), et une quarantaine de lectures de la
  session web n'y tiennent pas. Chaque sonde a maintenant sa propre attente dans la file, et le contrôle cesse de
  LANCER des sondes quand son temps est écoulé (`budget`, 25 s par défaut, 1 à 50) : la réponse nomme la première sonde
  non faite (`next`), à redemander avec `from`. Les variantes d'une fonction ne sont jamais coupées en deux ;
  `function` n'est pas borné.
- **Résultats de la classe** : les entrées du pied et des cellules au-delà des titres, et les colonnes que Pronote
  masque (`visible: false`) ou ne nomme pas, ne sont plus des colonnes (elles sortaient « #37 » à « #40 ») ; `column`
  est le rang parmi les colonnes rendues. `title` : titre long de la colonne (son info-bulle), ce qui distingue deux
  colonnes de même titre court (deux groupes d'une matière). Une colonne de regroupement est nommée par ses lignes 1
  ou 3.
- **Appréciations générales** : l'élément réel d'une ligne (`N`, `G`, `titre`, `appreciation`, `editable`, `cloture`)
  n'a pas de `L` tant que rien n'est saisi ; le texte est lu dans `L`, puis dans `appreciation`.
- **Fiche** : le professeur principal nommé deux fois (« M. X J. » dans `listePP`, « M. X Jean » dans
  `profPrincipal`) n'est rendu qu'une fois, sous sa forme longue ; les options que la fiche liste elle-même ne sont
  plus complétées par des libellés de groupes ; `groupsReason: "partial"` quand la file a arrêté la lecture des listes
  de groupes après en avoir trouvé (redemandée, elle va plus loin).

**Relevé du 21/11/2026** (sondes une à une, session web saine, aucune valeur) : répondent et sont lues `PageBulletins`,
`PageReleve`, `ResultatsClasses`, `ListeAppreciations` (variantes `ressource+periode` et avec `listeRessources`),
`PageAppreciationsGenerales`, `RecapitulatifVSEleve` (deux variantes), `PageSaisieCarnetCorrespondance`, `FicheEleve`
(aucune clé non associée), la photo, `DetailAbsences`, `PageApprBulletin` (25 et 30), `PageTrombinoscope`. Répondent
sans décodeur : `RecapAbsencesEleves` (`ListeLignes`, `LigneCumul`), `LivretScolaire`, `PageSuiviPluriannuel`,
`ListeElevesBIA`, `DetailsPIEleve`. Refusées par le profil : `ListePunitions`, `PageSuivisAbsenceRetard`,
`AbsencesGrille`, `RecapPunitions`, `ListeRegimesEleve`, `PageDossiers`, `Incidents`, `BulletinBIA` ;
`ListeMemosEleves` répond vide sous ses six variantes. Erreur de Pronote avec la requête essayée : `RecapFeuilleAppel`,
`PageAppreciationsBulletinParEleve`, `RecapitulatifScolarite`, `ListeAvisProfesseurs`. Ne jamais lancer deux
contrôles en même temps sur un compte : chacun rouvre la session web et ferme celle de l'autre.

## 0.14.0 — vue du professeur principal : corrections d'après le premier contrôle réel

Premier contrôle réel du 20/11/2026 (`GET /pp/check`, classe de 31 élèves, sessions mobile et web) : `ResultatsClasses`,
`RecapitulatifVSEleve` et `ListeAppreciations` répondent sous une autre forme que celle supposée en 0.12.0 ;
`ListeMemosEleves` répond vide ; 8 clés des responsables n'étaient pas associées. Les formes relevées (noms et types
des membres, sans valeur) ont été relues avec le client web qui les affiche (PRONOTE 2026.2, modules
`interfacepageresultatsclasses.js`, `donneesliste_resultatsclasse.js`, `objetfenetre_recapitulatifvseleve.js`,
`objetrequetelistes.js`, `interfaceficheeleve.js`, serveur de démonstration, sans connexion). Client :
`local_pronoteio` 0.22.0.

**Toujours aucune valeur réelle vue** : les fixtures des tests sont construites sur ces formes, avec des noms et des
valeurs générés. Chaque lecture reste `validated: false`.

- **Formes** (`src/teacher/shape.ts`, sorti de `students.ts`) : `shapeOf` réunit les membres des cinq premiers éléments
  d'une liste et décrit un membre vide chez eux par le premier élément qui le remplit (la première ligne de
  `resultats` cachait `notesEleve`) ; classe de longueur des listes (`list[0]`, `list[1]`, `list[2+]`) ; types
  multiples (`object|null`). Jamais une valeur (test dédié sur chaque ligne).
- **Contrôle** (`GET /pp/check`, `src/teacher/ppcheck.ts`) : groupes de sondes (`groups` : `core`, `life`, `reports`,
  `misc`), une ligne par fonction et par variante de requête (`variant`, `group`). `function=<clé>` : une seule
  fonction, forme entière (1 500 lignes au plus) par pages de 300 (`shapeoffset`, `shapelimit`, `shapeTotal`,
  `shapeMore`) ; clé inconnue : `400 invalid_function` avec les clés. Forme d'une fonction non comprise : 150 lignes.
  Sondes ajoutées, toutes en lecture (aucune fonction `Saisie*` ni `Programmer*`, vérifié avant l'appel et par un test) :
  `DetailAbsences` (113, sans puis avec `professeur`), `ListePunitions` (192), `PageSuivisAbsenceRetard` (74),
  `AbsencesGrille` (155), `RecapAbsencesEleves` (138), `RecapFeuilleAppel` (139), `RecapPunitions` (140), `Incidents`
  (135), `ListeRegimesEleve` (138), `PageApprBulletin` (25 et 30), `PageAppreciationsBulletinParEleve` (246),
  `ListeElevesBIA` et `BulletinBIA` (227), `RecapitulatifScolarite` (161), `LivretScolaire` (83), `PageDossiers` (20,
  `eleve` puis `Eleve`), `PageSuiviPluriannuel` (44), `ListeAvisProfesseurs` (260), `PageTrombinoscope` (77),
  `DetailsPIEleve` (105) ; quatre variantes de `ListeAppreciations`, six de `ListeMemosEleves`, deux de
  `RecapitulatifVSEleve` ; photo du premier élève (`studentPhoto` : `available`, `reason`, type et taille, jamais
  l'image) ; membres de la fiche qui portent des personnes (`studentFileMembers` : `Responsables`, `listeRessources`,
  `listeEquipePeda`, `listePP`). Un refus ou une erreur d'une sonde n'arrête pas les suivantes.
- **Résultats de la classe** (`GET /reports/results`) : grille réelle (`resultats[]` par élève et période, la ligne
  `lignePere: 0` étant celle de l'élève, les autres ses sous-périodes ; `notesEleve[].ColMoy.moyenne` ; `moyennes[]` en
  pied ; `titresColonnes[].ColMoy.titre1…3`). Ajouts : `median`, `groupAverage`, `heading`, `detail`, `lateness`,
  `absenceHalfDays`, `averages[].column`, `periods[]`, `general`. `titresColonnes` n'était pas dans la forme relevée
  (coupée à 60 lignes) : s'il manque, `columnsUnnamed: true`, `subject: ""` et `shape`, jamais un libellé deviné. Le
  tableau supposé en 0.12.0 reste lu en second.
- **Vie scolaire** (`GET /classlife`) : `RecapitulatifVSEleve` = totaux par type (`listeTotal`) et par matière
  (`listeMatiere[].colonnes`) → `items[].official` (réduit aux parties de `include`), sans date. `totalsScope` dit ce
  que couvre le détail daté ; les feuilles d'appel du compte restent lues pour le détail tant qu'aucune source ne le
  donne pour toutes les matières. Source `summary` (sur demande seulement : aucune de ses fonctions n'a été vue
  répondre) : `DetailAbsences` sans `professeur` (un appel par genre demandé), `ListePunitions`,
  `PageSuivisAbsenceRetard`, décodage tolérant sur les noms des feuilles d'appel, `format_unknown` et `shape` par
  fonction (`parts[]`) ; une fonction refusée ou non comprise n'est pas redemandée pendant la session.
- **Appréciations générales** (`GET /reports/comments`) : membre `liste` ; requêtes essayées dans l'ordre
  (`ressource + periode`, `+ listeRessources`, sans paramètre, `classe + periode`), la première dont la liste n'est pas
  vide est gardée (`general.variant`) ; « aucune rubrique » est gardé dix minutes. Repli pour un professeur principal :
  `PageBulletins` de chaque élève, par pages (`student`, `offset`, `limit`), `general.source: "reportcards"`,
  `general.page` ; `general.reason` garde la cause première. Le repli ne s'applique qu'à un client qui demande une
  page d'élèves (`local_pronoteio` 0.22.0) : un client plus ancien garde la réponse d'avant.
- **Écriture des appréciations générales** (`POST /reports/comments`) : rubrique résolue comme en lecture
  (`generalKindFor`) ; `generalKind` pour choisir ; `409 general_kind_ambiguous`, `404 general_kind_not_found`
  (`candidates`), `404 no_kind` (avant : `general_rubric_not_found`). Réponse : `generalKind`.
- **Fiche élève** : responsables : `niveauResponsabilite` (libellé, nombre ou `{G, L}`) → `responsibility`, `legal`,
  `authority` (`null` quand la valeur n'est pas comprise) ; `delegueClasse` → `classDelegate`, `membreCA` →
  `boardMember`, `contactUrgence` → `emergency`, `emailReason` ; `profession`, `situation`, `couleurPanel`,
  `couleurStr`, `autoriseRecupererEnfant` connues et jamais renvoyées. Options : texte de `Scolarite.options` ;
  matières de l'équipe pédagogique qui nomment une spécialité, une langue ou une option (`source: "team"`).
  `include=groups` : listes d'élèves des groupes du niveau de la classe (30 au plus, gardées dix minutes), puis groupe
  des services du bulletin de la période en cours ; `groupsReason` quand rien ne répond. Mémos : `eleve` puis `Eleve`
  sur les onglets 105, 113 et 78, la variante qui répond gardée pour la session, sinon les mémos que la fiche porte
  (`listeMemosEleves`) et `memosReason`. Régime : celui qu'une absence d'une feuille d'appel lue dans la session nomme
  (`regimeSource: "callsheets"`), sinon `regimeReason: "not_in_file"`.
- **Photos** : `download_refused` quand `PageTrombinoscope` (`existePhoto`) dit qu'une photo existe.
- Fonctions ajoutées (voir `pronote-functions.example.json`), `callFunctionAt` (lecture avec un autre onglet, refusée
  pour une fonction qui écrit). `/reports/comments` passe en priorité « lot ».
- Contrats : `guardian` et `studentFile` de `contracts/common.schema.json`, `requests.json`, fixtures des fiches.
- Tests : `test/real-shapes.test.ts` (15 tests), `test/classlife.test.ts` (4 tests ajoutés), attendus des tests
  existants mis au nouveau format des formes. `package.json` : seule la version change (aucune dépendance).

## 0.13.0 — évaluations par compétences : écriture reprise sur le client web, groupe réel de chaque évaluation, niveaux de l'établissement

Premier essai réel du 20/11/2026 (6e, « SCIENCES ET TECHNOLOGIE », groupes 6-SC-601-602 et 6-SC-603) : la création
d'une évaluation répondait `200` sans rien créer (`assessment_not_saved`) ; la lecture rendait les quatre mêmes
évaluations pour les deux groupes ; les niveaux annoncés étaient l'énumération du client (10 niveaux), pas les quatre
niveaux de l'établissement. Les trois causes ont été relues dans le code du client professeur (PRONOTE 2026.2, modules
`interfacepagelisteevaluations.js`, `objetrequetesaisieevaluations.js`, `objetfenetre_evaluation.js`,
`objetfenetre_competences.js`, `objetutilitaireevaluation.js`, `parametres.js`). Client : `local_pronoteio` 0.21.0.

**Toujours aucune écriture validée sur un vrai serveur** : Pronote est simulé en mémoire dans les tests
(`test/helpers/fake-skills-pronote.ts`, écrit d'après le client web et d'après ce que le vrai serveur a répondu le 20/11).

- **Onglet** (`src/teacher/functions.ts`) : `ListeEvaluations`, `SaisieEvaluations` et `ListePiliers` sont signés avec
  l'onglet **56** (« Saisie des évaluations ») au lieu de 65 (« Liste des évaluations »). En onglet 65 le client
  n'envoie ni service ni classe : Pronote rend toutes les évaluations du professeur et n'y crée rien. Nouvelle clé
  `competencyListAll` (`ListeEvaluations`, onglet 65), lue quand l'onglet 56 est refusé. Un fichier
  `PRONOTEIO_FUNCTIONS_FILE` qui fixe encore `competencyList` ou `competencySave` à 65 doit être corrigé.
- **Lecture** (`GET /competencies`) : chaque évaluation est gardée seulement si sa classe ou son groupe (membre `classe`
  de `ListeEvaluations`) est celui du service demandé, quel que soit l'onglet ; ses niveaux sont lus avec sa propre
  classe et sa propre période (`PageCompetencesParEvaluation`, comme le client). Deux évaluations de même titre et de
  même date dans un groupe ont deux identifiants (`~2`). Les identifiants Pronote étant propres à une session,
  l'identifiant public reste construit (`cp:<date>|<groupe>|<titre>`) ; l'identifiant Pronote sert à l'intérieur d'une
  même requête (relecture après écriture).
- **Écriture** (`POST /competencies`), en suivant le client pas à pas :
  1. création de l'évaluation **sans élève** : compétence = copie de l'élément du référentiel (`N`, `G`, `L` de
     `ListePiliers`) en état `E: 1`, avec une relation nouvelle (`relationESI: {N: -1002, E: 1}`), son `palier`,
     `coefficient: 1`, `ordre` à partir de 1. Jusqu'en 0.12.0 l'identifiant de l'élément partait dans `relationESI`, la
     compétence en `N: 0`, sans palier ; coefficients et descriptif partaient typés (`_T`) au lieu de nombres et de
     texte ; `DatePublication` pouvait partir à `null` ;
  2. l'identifiant créé est lu dans `RapportSaisie.listeEvaluationsCreees`, l'évaluation relue par cet identifiant
     (sinon par son titre, son jour et son groupe) ;
  3. les niveaux partent dans un second `SaisieEvaluations`, sur l'évaluation relue (sans état quand seuls des niveaux
     changent), élèves et compétences en état `E: 2`, avec la relation que Pronote a donnée à la compétence ;
  4. relecture : niveaux comptés (`ratingsSent`, `ratingsSaved`, `warnings` : `ratings_not_saved`,
     `ratings_partly_saved:n/m`). Une évaluation créée dont les niveaux manquent n'est pas cachée derrière une erreur.
  Comme le client, chaque niveau part avec son observation : celle donnée, sinon celle que Pronote a déjà (jamais
  effacée par un changement de niveau), sinon une observation vide non publiée.
  Réponse : `created`, `publicationDefault`, `requests` (toutes les requêtes envoyées). Dates envoyées à minuit (ce sont
  des jours). `avecSaisie` faux ou `messageCreationImpossible` de `ListeEvaluations` : `409 pronote_refused:<texte de
  Pronote>` avant tout envoi. `RapportSaisie` en erreur : `409 pronote_refused:<messages>`. Sauvegarde ignorée :
  `assessment_not_saved` avec `detail` (noms des membres de la réponse de Pronote, jamais une valeur), aussi écrit dans
  le journal d'accès (`shape`).
- **Publication** : sans date à la création, la date par défaut de Pronote est calculée comme le client
  (`General.NbJDecalageDatePublicationParDefaut` jours après l'évaluation, 1 si absent, puis prochain jour ouvré de
  `General.JoursOuvres` ; jours fériés non pris en compte) et annoncée dans la simulation (`after.publication`,
  `publicationDefault: true`). Une date donnée est envoyée telle quelle (date lointaine : publication ultérieure) ;
  jamais avant le jour de l'évaluation.
- **Niveaux de maîtrise** : la liste de l'établissement est `General.ListeNiveauxDAcquisitions` de
  `FonctionParametres` (le client la lit dans `GParametres`), pas `ParametresUtilisateur.listeNiveauxDAcquisitions` où
  elle était cherchée, donc jamais trouvée. `GET /competencies` : `levels` = niveaux **actifs** de l'établissement
  (`code`, `name`, `abbreviation`, `color`, `points`, `brevetPoints`, `positions`), `statuses` = annotations actives
  (Absent, Non évalué, Dispensé, Non rendu), `levelsSource` = `school` ou `fallback` (énumération du client ;
  `shape: "levels:missing"` au journal). `GET /session` donne aussi `levelsSource`. Écriture d'un niveau : seulement
  avec la liste de l'établissement (`409 levels_unknown` sinon, simulation comprise), `400 level_unknown:<code>` pour
  un niveau absent de la liste, `400 level_inactive:<code>` pour un niveau que l'établissement n'utilise pas.
- **Services de compétences** : `GET /grades/context?competencies=1` ajoute les services de l'onglet Compétences
  après ceux des notes (ordre et identifiants des services de notes inchangés), chacun avec `kinds`.
- **Référentiel** : `ListePiliers` rend une liste à plat par domaine, chaque élément avec son `pere` ; `element` d'un
  item est le libellé de son père. Un code de domaine quelconque est accepté (`SCIE/13.4`, `Comp/9.1`), plus seulement
  `D1`…`D5` et `CT`.
- Tests : `test/competencies-web-client.test.ts` (rejeu du plan du 20/11, deux groupes, niveaux, publication, refus),
  `test/competencies-write.test.ts`, `test/competencies.test.ts`, `test/competency-services.test.ts`,
  `test/web-space.test.ts` mis à jour.
## 0.12.1 — fiche élève : les responsables ne sortent plus dans les groupes

- Première lecture réelle d'une fiche (20/11/2026, `GET /students/files`, sidecar 0.12.0) : `groups` et `groupDetails`
  portaient les **noms des responsables** de l'élève. `listeRessources` de `FicheEleve`, pris en 0.12.0 pour la liste
  des classes et groupes, est en réalité la liste des responsables ; tout élément dont le genre n'était pas 1 y devenait
  un groupe. Les noms sortaient donc sans la partie `guardians`, contre la règle « responsables sur demande seulement ».
- `listeRessources` n'est plus lu du tout : membre connu (jamais dans `unmappedKeys`), aucune valeur n'en sort. Les
  responsables viennent toujours de `listeResponsables`, avec `include=guardians`.
- `groups`, `options` et `groupDetails` reviennent **vides** sur les fiches réelles, faute de membre qui porte les
  groupes de l'élève (seuls `listeGroupes`, `groupes`, `listeOptions`, jamais vus, sont encore lus). `class` ne vient
  plus que du membre `classe`. Les vraies sources des groupes sont au programme du lot suivant.
- Tests : `test/students-full.test.ts` (aucun libellé de `listeRessources` dans une réponse, avec ou sans `guardians` ;
  fixture corrigée : responsables dans `listeRessources`, classe dans `classe`).

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
