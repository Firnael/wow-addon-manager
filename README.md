# wam : gestionnaire d'addons WoW Forever

Une interface en terminal pour mettre à jour, chercher, ajouter et supprimer les addons de WoW Forever, sans l'app CurseForge (qui marche mal derrière Zscaler). Node ≥ 24, aucune dépendance.

```sh
wam                        # l'interface
wam check [addon…]         # versions et mises à jour disponibles
wam update [addon…]        # met à jour ce qui est en retard (tout, ou les addons nommés)
wam add <source…>          # lien CurseForge, numéro de projet ou owner/repo GitHub (+ dépendances)
wam remove [-y] <addon…>   # supprime, après confirmation sauf avec -y
wam search <mots…>         # catalogue Forever : numéro, nom, téléchargements, auteur
wam catalog                # reconstruit le catalogue
wam open <addon>           # ouvre la page de l'addon
wam release <addon…>       # un de nos addons : lien -> dernière release GitHub
wam dev <addon…>           # retour au lien vers le repo, pour travailler dessus
wam key                    # enregistre la clé API CurseForge (saisie masquée)
```

`<addon>` est le nom du dossier ou le titre, sans tenir compte de la casse. Chaque action de l'interface a sa commande ; `wam help` les liste.

`wam` est un lien de `~/.local/bin/wam` vers `bin/wam.mjs`, qui se lance avec `node --use-system-ca` (le certificat de Zscaler est dans le trousseau macOS, pas dans celui de Node).

## Interface

- **1 Installés** : chaque addon avec sa version et son état (à jour, ↑ nouvelle version, perso). `u` met à jour l'addon choisi, `U` tout, `r` revérifie, `l` bascule un de nos addons entre lien et release, `a` ajoute un addon (lien CurseForge, numéro de projet ou `owner/repo` GitHub), `d` supprime, `o` ouvre sa page.
- **2 Rechercher** : recherche dans le catalogue local des addons Forever (nom, description, auteur), noms d'abord puis par téléchargements. `Entrée` installe l'addon et ses dépendances obligatoires, `R` rafraîchit le catalogue.

## Nos addons : lien ou release

Nos addons (dans `~/git/perso/wow-addons`) sont des liens symboliques vers leur repo : le jeu charge le code en cours. `wam update` ne les touche pas et `d` refuse de les supprimer.

`wam release <addon>` (ou `l` dans l'interface) remplace le lien par la dernière release GitHub du repo, déduit du remote `origin` de la cible du lien. L'addon est alors suivi et mis à jour comme les autres, et l'état garde la cible du lien (`link`). `wam dev <addon>` supprime le dossier installé et remet le lien. Si la release ne contient pas de dossier du nom de l'addon, le lien est remis en place.

La release vient du workflow `.github/workflows/release.yml` de chaque addon : pousser un tag `vX.Y.Z` (égal au `## Version:` du `.toc`) publie `<Addon>-X.Y.Z-forever.zip`.

## Sources

- **CurseForge**, par le numéro de projet du `.toc` (`## X-Curse-Project-ID`). La version retenue est la dernière stable qui annonce un client 1.60.x. Le téléchargement passe par l'API du site (`www.curseforge.com/api/v1/mods/<id>/files`), qui ne demande pas de clé.
- **Fiches, dépendances et catalogue** : API officielle (`api.curseforge.com`, en-tête `x-api-key`), avec la clé d'organisation de [console.curseforge.com](https://console.curseforge.com). Sans clé, tout marche sauf la recherche et l'installation automatique des dépendances.
- **Pourquoi un catalogue local** : `/v1/mods/search` répond 403 à ces clés (vérifié le 2026-11-24, depuis le Mac et depuis le VPS), alors que le reste de l'API répond. `POST /v1/mods/featured` (filtré sur Forever, `gameVersionTypeId` 88568) renvoie une vingtaine d'addons en sautant ceux de `excludedModIds` : en le rappelant avec tous les ids déjà vus, on parcourt toute la liste Forever, des plus populaires aux moins populaires. Le catalogue est construit au premier lancement, repris s'il a été interrompu, refait au bout d'une semaine, et gardé dans `catalog.json`.
- **GitHub** : dernière release, fichier dont le nom contient « forever » et finit par `.zip` (ex. QuestieDB). Le token (`GITHUB_TOKEN`, `GH_TOKEN`, sinon `gh auth token`) donne accès aux repos privés : le fichier est alors pris par l'API des assets. Sans token, seuls les repos publics marchent.
- Les addons dont le `.toc` n'a pas de numéro CurseForge sont listés dans `KNOWN` (`src/core.mjs`). Un addon installé depuis `wam` garde sa source dans l'état.

## Fichiers

`~/.config/wam/` (ou `$WAM_HOME`) :

- `config.json` : `addonsDir` (par défaut le dossier AddOns de `_forever_` sous `/Applications`) et `apiKey`. Droits `600`. La clé peut aussi venir de `CURSEFORGE_API_KEY`.
- `catalog.json` : le catalogue des addons Forever (quelques Mo).
- `state.json` : pour chaque source, le fichier installé, ses dossiers, la date et, pour nos addons en release, la cible du lien. C'est lui qui dit si un addon est à jour ; sans trace, la version du `.toc` est comparée au nom du fichier en ligne.

## Code

- `bin/wam.mjs` : les commandes.
- `src/core.mjs` : lecture du dossier AddOns, comparaison des versions, installation (dossier remplacé en bloc, ancien remis en place en cas d'échec), suppression.
- `src/curse.mjs`, `src/github.mjs` : les sources.
- `src/catalog.mjs` : le catalogue local et sa recherche.
- `src/tui.mjs` : l'interface (stdin brut, codes ANSI, écran alternatif).

Pour tester sans toucher au vrai dossier : `WAM_HOME=/tmp/w` avec un `config.json` dont `addonsDir` pointe ailleurs.
