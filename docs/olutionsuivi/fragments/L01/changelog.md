## 0.16.0 — suivi des classes : absences de classe, plans d'accompagnement, années précédentes, lecture groupée

Lot L01 du chantier olutionsuivi (contrat : `docs/olutionsuivi/CONTRAT_SIDECAR.md`). Tout est en lecture seule.
**Aucune des quatre fonctions de Pronote lues ici n'a été vue répondre avec ses valeurs** : les décodeurs sont des
suppositions à noms candidats (`validated: false`), et une forme non reconnue répond `available: false`,
`reason: "format_unknown"` et `shape` (jamais une valeur).

- **`GET /classlife/absences`** (`RecapAbsencesEleves`, 138) : absences et retards de toute une classe, toutes matières,
  en un appel ; année scolaire par défaut. Événements datés quand la fonction en donne, sinon `reason: "totals_only"`
  avec `totals` et `bySubject`. Les motifs ne sont jamais lus (`reasons: []`).
- **`GET /students/plans`** (`DetailsPIEleve`, 105) : plans d'accompagnement d'une page d'élèves. Donnée de santé :
  jamais dans le cache des lectures ; ligne du journal sans taille de réponse ni forme ; `shape` sans les noms
  sensibles.
- **`GET /students/history`** (`LivretScolaire`, 83 et `PageSuiviPluriannuel`, 44) : résultats des années précédentes,
  fusionnés par année scolaire ; l'état de chaque source est rendu par élève et pour la page.
- **Lecture groupée** : `POST /collect`, `GET /collect/:id`, `GET /collect/:id/results`, `DELETE /collect/:id`. Neuf
  blocs (`files`, `reportcards`, `results`, `comments`, `classlife`, `absences`, `plans`, `history`, `grades`), chacun
  rendu dans la forme de la réponse de sa route. Une seule par compte (`409 collect_running`). Priorité « lot » de la
  file vers Pronote ; après `rate_limited`, attente de `retry_after` puis reprise au premier élève non lu ; un bloc
  refusé ou en erreur n'arrête pas les autres ; session fermée en cours de série : `waiting`, reprise quand elle
  revient, `partial` à l'expiration (`PRONOTEIO_COLLECT_WAIT`, 900 s). Résultats en mémoire, 30 minutes.
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
