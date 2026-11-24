# wam : gestionnaire d'addons WoW Forever

Une interface en terminal pour mettre à jour, chercher, ajouter et supprimer les addons de WoW Forever, sans l'app CurseForge (qui marche mal derrière Zscaler). Node ≥ 24, aucune dépendance.

```sh
wam           # l'interface
wam check     # liste les addons et les mises à jour disponibles
wam update    # met à jour tout ce qui est en retard
wam key       # enregistre la clé API CurseForge (saisie masquée)
```

`wam` est un lien de `~/.local/bin/wam` vers `bin/wam.mjs`, qui se lance avec `node --use-system-ca` (le certificat de Zscaler est dans le trousseau macOS, pas dans celui de Node).

## Interface

- **1 Installés** : chaque addon avec sa version et son état (à jour, ↑ nouvelle version, perso). `u` met à jour l'addon choisi, `U` tout, `r` revérifie, `a` ajoute un addon (lien CurseForge, numéro de projet ou `owner/repo` GitHub), `d` supprime, `o` ouvre sa page.
- **2 Rechercher** : recherche CurseForge triée par popularité, limitée aux addons qui ont un fichier Forever (`f` pour tout voir). `Entrée` installe l'addon et ses dépendances obligatoires.

Les addons en lien symbolique (les nôtres, dans `~/git/perso/wow-addons`) sont affichés mais jamais modifiés ni supprimés.

## Sources

- **CurseForge**, par le numéro de projet du `.toc` (`## X-Curse-Project-ID`). La version retenue est la dernière stable qui annonce un client 1.60.x. Le téléchargement passe par l'API du site (`www.curseforge.com/api/v1/mods/<id>/files`), qui ne demande pas de clé.
- **Recherche, fiches et dépendances** : API officielle (`api.curseforge.com`), avec une clé gratuite à créer sur [console.curseforge.com](https://console.curseforge.com). Sans clé, tout marche sauf la recherche et l'installation automatique des dépendances.
- **GitHub** : dernière release, fichier dont le nom contient « forever » et finit par `.zip` (ex. QuestieDB).
- Les addons dont le `.toc` n'a pas de numéro CurseForge sont listés dans `KNOWN` (`src/core.mjs`). Un addon installé depuis `wam` garde sa source dans l'état.

## Fichiers

`~/.config/wam/` (ou `$WAM_HOME`) :

- `config.json` : `addonsDir` (par défaut le dossier AddOns de `_forever_` sous `/Applications`) et `apiKey`. Droits `600`. La clé peut aussi venir de `CURSEFORGE_API_KEY`.
- `state.json` : pour chaque source, le fichier installé, ses dossiers et la date. C'est lui qui dit si un addon est à jour ; sans trace, la version du `.toc` est comparée au nom du fichier en ligne.

## Code

- `bin/wam.mjs` : les commandes.
- `src/core.mjs` : lecture du dossier AddOns, comparaison des versions, installation (dossier remplacé en bloc, ancien remis en place en cas d'échec), suppression.
- `src/curse.mjs`, `src/github.mjs` : les sources.
- `src/tui.mjs` : l'interface (stdin brut, codes ANSI, écran alternatif).

Pour tester sans toucher au vrai dossier : `WAM_HOME=/tmp/w` avec un `config.json` dont `addonsDir` pointe ailleurs.
