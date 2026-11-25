# Lot N9s — Corrections de la relecture d'ensemble (sidecar)

Vague 5, session séparée. Dépôt **`pronoteio-sidecar`**, branche d'intégration `claude/gallant-turing-lu9vxj`.
Version **0.17.1** (correctif). Le lot N9 corrige en parallèle le côté Moodle (`mood_prod`).

## À lire, et rien d'autre

`docs/olutionsuivi/lots/N-contrat.md` sections 1, 6.1, 7 (copie dans ce dépôt) ; `src/teacher/positioningWrite.ts`,
`src/teacher/commentsWrite.ts`, `src/routes/reports.ts`, `contracts/`.

## Règles

Ajouts seulement : aucune route ne perd un champ ; aucun test existant ne change de sens. Jamais le vrai Pronote.

## À corriger

1. Identifiant d'élève : `POST /reports/positioning` et `POST /reports/comments` acceptent aussi la forme
   `e:NOM Prénom` (et le suffixe `~n` d'un homonyme) en plus du nom nu (comparaison après retrait du préfixe). Tests.
2. `POST /reports/comments` : champ facultatif `service` (id stable) qui choisit le service de la cellule quand le
   compte a plusieurs services dans la classe ; sans lui, comportement d'aujourd'hui ; `404 service_not_found` s'il
   n'existe pas. Schéma de requête (`npm run contracts:requests`), tests.
3. Journal : `requestShape` (`positioningWrite.ts` ~219, ~224) ne garde pas le genre `G` de `positionnement` (c'est
   la valeur saisie). Test.

## Terminé quand

- [ ] les trois points sont corrigés et testés ;
- [ ] `npm test` et `npm run typecheck` verts ; contrats à jour ; `CHANGELOG.md` et `package.json` en 0.17.1 ;
- [ ] passation `docs/olutionsuivi/passations/N9s.md` dans ce dépôt ; PR en brouillon vers
      `claude/gallant-turing-lu9vxj`.
