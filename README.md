# pronoteio-sidecar

Service Node.js (Fastify, Pawnote) qui fait le pont entre le plugin Moodle **local_pronoteio** (olution.info) et le
Pronote du lycée, avec le compte enseignant lié. Version **0.9.0** — voir [CHANGELOG.md](CHANGELOG.md).

- Hébergement : o2switch, cPanel « Setup Node.js App » (Phusion Passenger), fichier de démarrage `app.cjs`, code
  compilé versionné dans `dist/` (pas d'étape de build sur l'hôte).
- Mise à jour : cron cPanel `tools/cpanel-update.sh` (ou `POST /admin/update`), sortie gardée
  (`>>$HOME/logs/pronoteio-sidecar-cron.log 2>&1`, jamais `>/dev/null`) — voir
  [docs/deploiement-o2switch.md](docs/deploiement-o2switch.md).
- Échange signé : chaque requête porte `X-Pronoteio-Timestamp`, `X-Pronoteio-Nonce` et `X-Pronoteio-Signature`
  (HMAC-SHA256 du secret partagé), et `X-Pronoteio-Session` une fois connectée.

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
| Refus des compétences | `available:false`, `reason:"access_denied"`, + `onglet`, `space`. |

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
| `web_session_required` | 409 | Onglet absent de la session mobile (0.10.0) | Ouvrir la session web, renvoyer avec `X-Pronoteio-Web-Session` | `onglet`, `function` |
| `web_session_expired` | 401 | Session de l'Espace Professeurs web expirée (0.10.0) | Rouvrir la session web, renvoyer | |
| `internal` | 500 | Erreur interne | Réessayer, voir `/health` | |

## Données personnelles (RGPD)

Le sidecar manipule des données de mineurs (fiches, notes, absences) pour le compte d'un enseignant.

- Cache des lectures, sessions Pronote, résultats des tâches : **en mémoire uniquement**, 60 s par défaut pour le cache,
  10 min au plus pour les tâches, tout est perdu au redémarrage. Jamais écrits sur disque.
- Journaux : route-modèle, statut, code, durée, taille ; **jamais** d'URL (sa requête peut nommer un élève), de corps,
  d'en-tête, d'identifiant de session ni de message de Pronote. Les erreurs consignées ne gardent que code, route et
  heure.
- Fichiers écrits : chaîne de jetons chiffrée, état non personnel, verrou, journaux (voir
  [docs/deploiement-o2switch.md](docs/deploiement-o2switch.md)).
- Fixtures de test et de contrats : noms fictifs, aucune donnée réelle.
