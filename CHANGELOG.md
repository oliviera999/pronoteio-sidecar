# Journal des versions — pronoteio-sidecar

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
