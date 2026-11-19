# Déploiement chez o2switch (cPanel, Passenger) — sidecar 0.9.0

Ce document décrit les réglages d'hébergement dont dépendent la file d'attente, le cache, les tâches et la session
Pronote, qui vivent **dans la mémoire d'un seul processus Node**. Rien ici n'a pu être vérifié sur l'hébergement
lui-même pendant le développement : chaque point porte une case « à vérifier ».

## 1. Un seul processus, toujours vivant

| Réglage | Où | Effet |
| --- | --- | --- |
| `PassengerMinInstances 1` | `.htaccess` du sous-domaine du sidecar (au-dessus du bloc généré par cPanel) | Passenger garde au moins un processus. |
| `PassengerMaxPoolSize 1` | **configuration serveur uniquement** (non autorisé dans un `.htaccess`) | Hors de portée sur un hébergement mutualisé. |
| Appel de `/health/public` toutes les 5 min | cron cPanel (le script de mise à jour le fait, voir §3) | Évite l'arrêt du processus après inactivité (`PassengerPoolIdleTime`, réglage serveur). |
| Verrou `~/tmp/pronoteio-sidecar.lock` | sidecar (automatique) | Si Passenger lance malgré tout un second processus, celui-ci le signale (`/health` : `process.primary=false`) et n'appelle jamais Pronote (503 `pronote_unavailable`, `reason: second_process`). |

Pour Node.js, Passenger envoie plusieurs requêtes simultanées au même processus et n'en lance un second que sous
forte charge : avec un seul utilisateur (Moodle), un seul processus est la situation normale. Le verrou est le
filet de sécurité, et la santé dit si un second processus est apparu (`process.conflicts`).

- [ ] Vérifier qu'o2switch accepte `PassengerMinInstances` dans le `.htaccess` (sinon, le retirer : le cron suffit).
- [ ] Après déploiement, `GET /health` signé : `process.primary = true`, `process.conflicts = 0`.

## 2. Délai du serveur web devant le sidecar (doublons)

Apache + Passenger renvoient parfois une requête longue une seconde fois (constat : fiches élèves d'une classe de
30, une fois sur deux). Le sidecar sert la seconde livraison avec la réponse de la première, sans rappeler Pronote,
et **mesure l'écart** entre les deux livraisons : `GET /health` → `proxy.medianDelayMs`, `proxy.minDelayMs`. Cet écart
est l'estimation du délai du proxy.

- [ ] Relever `proxy.minDelayMs` après quelques jours ; le reporter ici. Les requêtes plus longues doivent passer par
  `POST /jobs` (le plugin) ou être découpées (`students/files?ids=…` rend des résultats partiels).

## 3. Mise à jour (cron et bouton)

```
*/5 * * * * /bin/bash /home/<compte>/<dossier-du-sidecar>/tools/cpanel-update.sh https://<sous-domaine-du-sidecar> >>$HOME/logs/pronoteio-sidecar-cron.log 2>&1
```

- Garder la sortie dans `~/logs/pronoteio-sidecar-cron.log`, jamais `>/dev/null` : le script n'écrit rien quand il n'y a
  rien à faire, et une erreur de bash lui-même (variable non définie, commande introuvable) n'apparaît que là
  (19/11/2026 : la 0.10.0 fusionnée, mais ni `npm ci` ni redémarrage, sans aucune trace).

- Toutes les 5 minutes : `git fetch` ; rien de nouveau → simple appel de `/health/public` (maintien en vie).
- Nouveau commit sur `main` : fusion, `npm ci --omit=dev` si `package.json` ou `package-lock.json` ont changé,
  redémarrage (`tmp/restart.txt`), puis attente (90 s au plus) que `/health/public` réponde **la nouvelle version et le
  nouveau commit**. Sinon : retour au commit précédent, redémarrage, nouvelle vérification.
- Journal : `~/logs/pronoteio-sidecar-update.log` (ancien → nouveau commit, versions, résultat) ; dernier résultat
  dans `var/update-result.json` (`ok`, `not_checked`, `rolled_back`, `rollback_failed`, `merge_failed`, `fetch_failed`,
  `resumed`, `resume_failed`, `aborted`).
- Mise à jour à moitié faite (code fusionné, processus resté sur l'ancienne version ou l'ancien commit) : le passage
  suivant refait `npm ci`, redémarre et vérifie (`resumed`), sans retour arrière ; une seule tentative par commit
  (`resume_failed` : intervention à la main, voir ci-dessous).
- Arrêt du script après la fusion : ligne `aborted after merge (step: …, command: …)` et résultat `aborted`.
- Activation de l'environnement Node de cPanel (`~/nodevenv/…/bin/activate`) faite hors `set -u` ; si elle échoue, son
  `bin/` est mis en tête du `PATH` (`activate failed: PATH fallback` dans le journal).
- Fin de mise à jour à la main : `source ~/nodevenv/<dossier>/22/bin/activate`, `npm ci --omit=dev` (lance le
  `postinstall` `patch-pawnote`), `touch tmp/restart.txt`, puis `curl https://<sous-domaine>/health/public`.
- Une seule mise à jour à la fois (`flock` sur `~/tmp/pronoteio-sidecar-update.lock`).
- Bouton (tool_olutiondeploy) : `POST /admin/update` signé lance le même script tout de suite et renvoie l'ancienne et
  la nouvelle version et le résultat ; `GET /admin/update` relit le dernier résultat (utile si le processus a été
  remplacé avant la réponse). Variable `PRONOTEIO_PUBLIC_URL` = l'URL publique donnée au script.

- [x] Remplacer l'ancienne ligne de cron par celle ci-dessus (fait le 19/11/2026, sortie vers
  `~/logs/pronoteio-sidecar-cron.log`).
- [ ] Ajouter `PRONOTEIO_PUBLIC_URL` dans « Setup Node.js App » (ou le `.env`).
- [ ] Première mise à jour vers 0.9.0 : les paquets `tzdata` et `timezonecomplete` sont nouveaux ; vérifier dans le
  journal que `npm ci` a réussi (sinon « Run NPM Install » dans cPanel).

## 4. Fuseau horaire

Le sidecar ne dépend plus du fuseau du serveur : il passe le processus en UTC et lit les heures de Pronote dans
`PRONOTEIO_TIMEZONE` (défaut `Africa/Casablanca`) avec la base de fuseaux la plus récente (celle de Node ou la base
embarquée `tzdata`). `GET /health` → `time` donne le fuseau, le décalage actuel, la base utilisée et le fuseau de
l'hôte d'origine (`hostTimezone`, `hostTzEnv`) : ce dernier confirme la cause du décalage d'une heure de la 0.8.0.

- [ ] Après déploiement : `time.offsetMinutes = 0` (Casablanca, novembre 2026), `time.source`, `time.hostTimezone`.

## 5. Fichiers écrits par le sidecar

| Fichier | Contenu | Données personnelles |
| --- | --- | --- |
| `var/tokens.json` | chaîne des jetons Pronote, chiffrée (déjà en 0.6.0) | jetons chiffrés |
| `var/state.json` | compteurs de débit, 20 dernières erreurs (code, route, heure), reconnexions, version de Pronote | non |
| `var/update-result.json` | résultat de la dernière mise à jour | non |
| `~/tmp/pronoteio-sidecar.lock` | PID et heure de démarrage | non |
| `~/logs/pronoteio-sidecar.log` (+ `.1` … `.4`) | une ligne JSON par requête : route-modèle, statut, code, durée, taille | non (jamais d'URL ni de corps) |
| `~/logs/pronoteio-sidecar-update.log` | journal des mises à jour | non |

Le cache des lectures, les sessions Pronote et les résultats des tâches restent **en mémoire uniquement** et sont
perdus à chaque redémarrage.
