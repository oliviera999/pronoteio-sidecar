# Saisies du client web Pronote capturées sur le serveur réel (24/11/2026)

Pronote 2026.2.8, lycée Lyautey, Espace Professeurs, Chrome (Claude in Chrome). Méthode et scénarios :
`prompt_capture_navigateur.md`. Le contenu des requêtes a été intercepté avant le chiffrement
(`JSON.stringify`) et la réponse après le déchiffrement (`JSON.parse`). Les élèves sont anonymisés et les
identifiants donnés par leur forme. Toutes les cellules d'essai ont été remises à vide.

## Constat principal

Une cellule vide est **créée** (`N` négatif provisoire, `E: 1`) ; le serveur répond le vrai `N` (`"10#…"`) dans
`RapportSaisie.appreciation`. Le sidecar ≤ 0.16.5 envoyait une modification (`E: 2`, sans `N`) : d'où « erreur
modification libellé appréciation ». Corrigé en sidecar 0.16.6.

## `SaisieAppreciation`

| Cas | Onglet | `classe` | `periode` | `eleve` | `service` | `appreciation` | `typeGenreAppreciation` |
|---|---|---|---|---|---|---|---|
| Élève, création | 25 | N/G/L, G 1 (classe de l'élève, même pour un groupe) | N/G/L, G 2 | N/G/L, G 4 | N/L (pas de G) | N négatif (nombre : -1001…), G 1, L, E 1 | 0 |
| Élève, modification | 25 | idem | idem | idem | idem | N `"10#…"`, G 1, L, E 2 | 0 |
| Élève, effacement | 25 | idem | idem | idem | idem | N `"10#…"`, G 1, E 2, **sans L** | 0 |
| Classe ou groupe, création | 25 | N/G/L, G 1 | idem | `null` | N/L | N négatif, G 9, L, E 1 | 0 |
| Classe, effacement | 25 | idem | idem | `null` | N/L | N `"10#…"`, G 9, E 2, sans L | 0 |
| Générale, création | 27 | N/G/L, G 1 | idem | N/G/L, G 4 | **absent** | N `0` (nombre), G 3, L, E 1 | 1 |
| Générale, effacement | 27 | idem | idem | idem | absent | N `"10#…"`, G 3, E 2, sans L | 1 |
| 6e en groupe | 25 | classe de l'élève (`23#`, G 1), pas le groupe (`60#`, G 2) | idem | idem | N/L | comme « élève » | 0 |

- Réponse : `{"data":{},"nom":"SaisieAppreciation","RapportSaisie":{service, periode, [eleve], appreciation}}` ;
  après effacement, `appreciation` vaut `{G}` seul. Aucune réponse de saisie ne porte `Signature` ni `ModeExclusif`.
- Grille (`PageApprBulletin`, `{ressource, periode, service}`) : appréciation vide `{G:1, estEditable:true}` sans N
  ni L ; existante `{L, G, estEditable, N:"10#…"}` (N stable). Appréciation de classe : G 9. Pour un groupe de 6e,
  chaque ligne porte `classe` (la classe de l'élève).
- Appréciations générales (`PageAppreciationsGenerales`, onglet 27, `{classe, periode, appreciation:{G:2,
  L:"Appréciation globale"}, estUneRubrique:false}`) : vide = `{N:"0", G:3, appreciation:""}` ; la rubrique n'est pas
  renvoyée dans la saisie ; le `RapportSaisie` rend `service {N:"0"}`.
- Le texte part en UTF-8 dans le JSON. Le champ est limité à 500 caractères côté client (`maxlength`).
- Deux validations rapides : deux requêtes successives, même N, toutes deux acceptées.

## Périodes, services

- `ListePeriodes` (onglet 25, `{ressource, listeRessources}`) : T1 à T3 (`"105#…"`, G 2, `GenreNotation` 1), BAC
  BLANC, BAC BLANC 2, CCF (G 4, `GenreNotation` 0). T11 et T06 n'ont pas de semestres. `periodeParDefaut` sans G.
- `ListeServices` (onglet 25) : service `"131#…"` **sans G**, avec `classe` (lycée) ou `groupe` (6e) ; en PP, tous
  les services de la classe.
- Aucune période close au 24/11 (`cloture:false`, `strInfoCloture:""` partout).

## 6e : positionnement et note LSU (onglet 25, même page que les appréciations)

Colonnes éditables de la grille d'un groupe de 6e : **Pos.**, **N. LSU**, **App. A**. Lignes : `typePositionnementClasse`,
`niveauAcquEditable`, `noteLSUEditable`, `noteLSU {_T:10, V}`, `listeNiveaux` (N `"93#…"` : G 1 Très bonne maîtrise,
2 satisfaisante, 4 fragile, 6 insuffisante, 7 Absent, 8 Non évalué, 9 Dispensé, 10 Non rendu), `listeNiveauxChronologique`,
`listePiliers`, `nbEvals`.

```json
// SaisiePositionnement
{"estPourElementCompetence":false,
 "positionnement":{"N":"93#…","G":2,"L":"Maîtrise satisfaisante"},
 "classe":{"N":"23#…","G":1,"L":"603"}, "periode":{"N":"105#…","G":2,"L":"Trimestre 1"},
 "eleve":{"N":"46#…","G":4,"L":"ELEVE"}, "service":{"N":"131#…","L":"SCIENCES ET TECHNOLOGIE"}}
// réponse : RapportSaisie {service, eleve, niveauAcqu {L, N, G}}
// remise à vide : "positionnement":{"N":0,"G":0,"L":"Aucun"} → RapportSaisie {service, eleve} sans niveauAcqu
```

```json
// SaisieNoteLSU (valeur de 0,00 à 100,00, virgule décimale)
{"classe":{…603…}, "periode":{…T1…}, "eleve":{…}, "service":{…},
 "posLSUNote":{"_T":10,"V":"15,00"}}
// réponse : RapportSaisie {service, eleve, posLSUNote {_T:10, V:"15"}} ; effacement : V ""
```

Boutons de calcul automatique (jamais cliqués) : « Σ Pos. » (« Détermination du positionnement de l'élève en fonction
des résultats obtenus aux évaluations ») et « Σ N. LSU » (« Détermination de la note de l'élève exportée vers LSU en
fonction des résultats obtenus aux évaluations »).
