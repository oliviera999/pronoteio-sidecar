# Contrats pronoteio-sidecar ↔ local_pronoteio

Référence commune entre le sidecar et le plugin Moodle `local_pronoteio` (0.9.0, lot P10).

| Fichier | Contenu |
| --- | --- |
| `requests.json` | Schémas des **requêtes** de toutes les routes (querystring, body, params), extraits du code (`npm run contracts:requests`). Le test échoue s'il n'est pas à jour. |
| `common.schema.json` | Définitions partagées : `localTimes`, `timestamp`, `error` (corps de toute erreur), `stableCode`, `lesson`, `homework`, `student`, `studentFile`, `guardian`. |
| `routes/*.schema.json` | Schéma strict de la **réponse** d'une route (`properties.response`) : tout membre non décrit ou tout membre requis manquant fait échouer les tests (et donc l'intégration continue). |
| `fixtures/*.json` | Réponses du sidecar aux fixtures anonymisées (noms fictifs), régénérées par `npm run contracts:fixtures`. |
| `export.sh` | Archive versionnée `pronoteio-contracts-<version>.tar.gz` (+ `MANIFEST.json`, `.sha256`) à copier dans les tests du plugin (`npm run contracts:export`). |

## Champs ajoutés en 0.9.0 (tous facultatifs pour un client 2026112100)

- `local` : heures murales de Pronote, par nom du champ horodatage (`{ "start": "2026-11-12 17:10" }`), sur les
  séances, devoirs, cahier de textes, évaluations, notes, compétences, absences et rendez-vous. **En écriture**, tout
  objet du corps peut porter `local` (mêmes clés que ses horodatages) : il est préféré à l'horodatage et retiré avant la
  validation (il n'apparaît donc pas dans `requests.json`).
- Erreurs : `code`, `message`, et selon le cas `retry_after`, `candidates`, `fields`, `reason`, `function`, `field`,
  `pronoteversion` (voir `GET /errors`).
- `students/files?ids=…` : `read`, `remaining`, `notFound`, `partial`, `retry_after`.
- `session/login` : `reused` quand la session ouverte du compte est rendue.
- En-têtes : `X-Cache`, `Retry-After`, `X-Pronoteio-Pronote-Version`, `X-Pronoteio-Pronote-Validated`,
  `X-Pronoteio-Duplicate`.

## Champs ajoutés en 0.12.0 (vue du professeur principal)

- `studentFile` : `birthplace`, `adult`, `groupDetails` (toujours) ; `contact`, `school`, `memos` (sur `include`) ;
  `health.allergies`, `health.planDetails` ; `guardian` : `order`, `authority`, `mail`, `sms`, `emailAllowed`,
  `phoneDetails`.
- `students/files` : `unmappedGuardianKeys` (noms seulement).
- Routes nouvelles ou étendues sans schéma de réponse strict pour l'instant (`/reports` paginé, `/reports/results`,
  `/reports/comments`, `/classlife`, `/students/photos`, `/pp/check`) : leur forme est décrite dans
  `docs/pronoteio/vue-pp.md` du dépôt `mood_prod` et leurs types dans `src/normalise.ts` et `src/teacher/`.

## Champs ajoutés en 0.15.0 (garde des connexions web)

- `session/login` avec `space: web` : `reused: true` quand la session web encore ouverte du compte est rendue sans
  appel à Pronote (connexion sans `pin`, avec le mot de passe qui a ouvert cette session) ; `navigator` décrit (présent depuis 0.11.1). Fixtures
  `session-login-web.json`, `session-login-web-reused.json`.
- Erreur `web_login_backoff` (429) : `retry_after` (secondes, ≥ 1), `backoff_until` (secondes Unix), en-tête
  `Retry-After`. Fixture `error-web-login-backoff.json`.
- Erreur `web_session_required` (409) pendant le délai de reprise du compte : `retry_after` et `backoff_until` en plus
  de `onglet` et `function`. Fixture `error-web-session-required-backoff.json`.
- `health` : `webLogin` (`accountsInBackoff`, `failuresLast10Min`).
- `session/info` (sans schéma de réponse strict) : `weblogin` (`failures`, `recentFailures`, `backoffUntil`,
  `retryAfter`, `lastFailureAt`, `lastKind`), type `WebLoginStatus` de `src/webLoginGuard.ts`.
- En-têtes de requête facultatifs, hors signature : `X-Pronoteio-Origin` (`^[a-z0-9][a-z0-9_.:/-]{0,79}$`),
  `X-Pronoteio-Account` (`^[0-9a-f]{8,32}$`), recopiés dans le journal d'accès.

## Couverture des réponses

Routes avec schéma de réponse strict : `/health/public`, `/health`, `/errors`, `/roster`, `/students/files` (page et
liste d'identifiants), `/timetable`, `/homework`, `/session/login`, `/jobs`, `/jobs/:id`, `/admin/update`, et le corps de
toute erreur. Les autres routes ont leur schéma de requête dans `requests.json` ; leurs schémas de réponse restent à
écrire (leurs types sont dans `src/normalise.ts`).
