# CLAUDE.md — pronoteio-sidecar

Guide pour Claude Code sur **pronoteio-sidecar** : service Node.js (Fastify, Pawnote) qui relie le
plugin Moodle `local_pronoteio` (olution.info, dépôt `mood_prod`) au Pronote du lycée Lyautey.
Répondre, commenter et documenter en **français**. Référence détaillée : `README.md` et `docs/`.

## Où ce dépôt s'inscrit

- **Projet Claude Code** : « olution — plateforme et enseignement ». Il regroupe les dépôts
  `mood_prod`, `pronoteio-sidecar`, `question_diagnostic`, `audit_bdd` et `index_olution` ;
  ses instructions s'ajoutent à ce fichier.
- **Projet de chat claude.ai** : « Projet olution.info ». Les contenus de cours, la banque de
  questions et les décisions pédagogiques s'y travaillent ; le code se fait ici.
- **Connecteur MCP `olution`** : il agit sur la **prod** de olution.info (plans d'écriture,
  déploiement, Pronote). À utiliser pour vérifier l'effet d'un changement, pas pour le contourner.

## Commandes

```
npm ci
npm test             # node:test + tsx, fixtures anonymisées, jamais de connexion à Pronote
npm run typecheck
npm run build        # met à jour dist/ — à committer (pas de build sur l'hôte o2switch)
npm run contracts:fixtures && npm run contracts:requests   # après un changement de format
npm run contracts:export                                     # contrats pour local_pronoteio
```

## Règles

- `dist/` est versionné : tout changement de `src/` s'accompagne de `npm run build` dans le même commit.
- Monter la version et compléter `CHANGELOG.md` à chaque livraison.
- Un changement de format de requête ou de réponse se fait **aussi** côté `local_pronoteio`
  (dépôt `mood_prod`, `docs/pronoteio/communication.md`), contrats régénérés.
- Les tests ne se connectent **jamais** à Pronote ; fixtures anonymisées uniquement.
- `PRONOTEIO_WRITE_MODE=simulate` par défaut : ne pas passer en `live` sans accord d'Oliv.
- Aucun secret, identifiant Pronote ou donnée d'élève dans le dépôt, les tests ou les journaux.
- Déploiement (cron cPanel `tools/cpanel-update.sh`) : seulement avec le feu vert d'Oliv.
