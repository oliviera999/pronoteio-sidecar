# Lot L01 — renvoi après relecture (22/11/2026)

Verdict du relecteur : **à fusionner après corrections mineures**. Rejoué dans une copie : `typecheck` sans erreur,
396 tests sur 396, `dist` identique à `src`, `package.json` et `CHANGELOG.md` intacts. Contrat, garde par compte,
reprise, refus jamais contournés, absence de données personnelles dans les journaux : conformes.

À faire sur `suivi/L01-sidecar` (fusionne d'abord `origin/suivi/integration` : `docs/olutionsuivi/CONTRAT_SIDECAR.md`
porte le paragraphe **7.4 ter**, qui fait foi), puis passation complétée (section « Renvoi du 22/11 »), tests, `dist`
reconstruit, branche poussée.

## Corrections

1. **`students` dans `GET /collect/:id`** (effectif de la classe) ; `blocks.<bloc>.total` reste en unités de travail.
2. **Session web manquante = `reopen_required`**, même si aucune session web n'a jamais été ouverte depuis le
   démarrage : `waiting`, `session.web: "reopen_required"`, `session.reason: "web_session_required"`. Sinon le
   collecteur de Moodle n'ouvre rien et la lecture attend 15 minutes pour finir `partial`.
3. **Durée de vie réelle.** Un minuteur (sans retenir le processus) efface les lectures finies depuis 30 minutes ;
   plus de dépendance au passage d'une requête.
4. **Déconnexion.** `POST /session/logout` et l'oubli d'une session effacent les lectures groupées du compte ; un
   ancien identifiant de session n'est plus une clé de lecture des résultats.
5. **`options.classlife.sources`** : seulement `recap`, `carnet`, `callsheets` ; `summary` (qui appelle
   `ListePunitions` et `PageSuivisAbsenceRetard`, refusées au profil) est rejeté par `400` dans la lecture groupée.
6. **Erreur de Pronote sur un élève** : l'élève va dans `remaining`, les élèves déjà lus de la page sont gardés, la
   lecture continue ; reprise des `remaining` une fois en fin de bloc ; `partial` s'il en reste.
7. **Plans : réponse vide = aucun plan.** Plus de refus déduit d'une réponse vide (la plupart des élèves n'ont aucun
   plan : le bloc serait presque toujours refusé). Aucun élève avec plan lisible : bloc `done`, `reason:
   "all_empty"`.
8. **État final** : `done` si tous les blocs sont `done` ; `failed` si aucun n'est `done` ni `partial` ; `partial`
   sinon (README et code alignés).
9. **`GET /students/history`** : source fermée en cours de page → `partial: true`, `remaining` rempli.
10. **Cache des doubles livraisons** : `/students/plans` et `/collect/:id/results` en sont exclus.

## Tests à ajouter

Un par point ci-dessus, plus : purge à 30 minutes et expiration à 60 minutes (horloge simulée), deux `POST /collect`
simultanés, plafond de dix lectures actives, requête interactive pendant une lecture, perte de la session mobile.

## Rappel

Champ `version` de `package.json` et `CHANGELOG.md` : toujours intacts (fragment). `dist` reconstruit et commité.
