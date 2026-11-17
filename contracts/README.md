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

## Couverture des réponses

Routes avec schéma de réponse strict : `/health/public`, `/health`, `/errors`, `/roster`, `/students/files` (page et
liste d'identifiants), `/timetable`, `/homework`, `/session/login`, `/jobs`, `/jobs/:id`, `/admin/update`, et le corps de
toute erreur. Les autres routes ont leur schéma de requête dans `requests.json` ; leurs schémas de réponse restent à
écrire (leurs types sont dans `src/normalise.ts`).
