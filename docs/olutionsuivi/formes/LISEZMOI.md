# Formes réelles relevées sur Pronote

Relevé du 22/11/2026, à la demande d'Oliv, par quatre lectures `get_pronote_health function: "<clé>"` faites une à la
fois (aucune en parallèle). **Noms de membres et types seulement, aucune valeur.**

| Fichier | Fonction | Ce qu'on en tire |
|---|---|---|
| `multiYear.txt` | `PageSuiviPluriannuel` (44) | **forme complète** : une entrée par année, une ligne par matière (moyenne, moyenne de la classe, appréciation, coefficient). Base solide pour `GET /students/history`. |
| `lifeAbsencesRecap.txt` | `RecapAbsencesEleves` (138) | la requête de la sonde ne rend **aucune ligne par élève**, seulement le cumul de la classe (`LigneCumul`). La forme d'une ligne reste inconnue. |
| `schoolRecord.txt` | `LivretScolaire` (83) | cadre connu, mais `listeLivret` est **vide** à cette date (livret non rempli). |
| `supportPlanDetails.txt` | `DetailsPIEleve` (105) | **forme vide** : élève sans plan, ou membres retirés par le filtre des membres sensibles. |

Conséquences pour le lot L01 : décodeur de l'historique écrit sur la forme réelle (`multiYear`) ; pour les trois
autres, décodeurs tolérants qui rendent `format_unknown` et `shape` (ou `totals_only` pour les absences). Les absences
datées de toutes les matières ne sont donc **pas acquises** : elles dépendent d'une requête à critères qui reste à
trouver devant Pronote.
