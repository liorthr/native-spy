# Native Spy – votre outil gratuit d'espionnage de native ads

Trouvez les publicités native (Taboola, Outbrain, MGID/Adskeeper, Revcontent, Content.ad…)
de vos concurrents **par mots-clés**, sans abonnement.

## Comment ça marche

1. **Le crawler** (`npm run crawl`) ouvre un vrai navigateur (Chromium), visite les sites éditeurs
   listés dans `sites.txt` et quelques-uns de leurs articles, fait défiler la page, et récupère
   chaque pub native affichée : titre, visuel, sponsor, réseau, URL/domaine de l'annonceur.
2. Tout est stocké dans une base locale `data/ads.db` (SQLite). À chaque passage, l'outil note
   **depuis combien de jours** une pub tourne et **combien de fois / sur combien de sites** elle a été vue.
   Une pub qui tourne depuis longtemps = une pub probablement rentable.
3. **L'interface web** (`npm run serve` → http://localhost:3000) permet de :
   - chercher par mots-clés (`minceur`, `assurance auto`, `crypto -bitcoin` pour exclure un mot) ;
   - filtrer par réseau, pays, période ; trier par nouveauté, longévité ou nombre de vues ;
   - voir l'onglet **Concurrents** : la liste des annonceurs qui achètent sur ces mots-clés ;
   - exporter en CSV (s'ouvre dans Excel).

## Installation (une seule fois)

Il faut [Node.js 22.5 ou plus récent](https://nodejs.org/) (version LTS).

```bash
cd native-spy
```

```bash
npm install
```

```bash
npx playwright install chromium
```

## Utilisation

Lancer un crawl (5 à 20 minutes selon le nombre de sites) :

```bash
npm run crawl
```

Ouvrir l'interface de recherche :

```bash
npm run serve
```

Puis allez sur http://localhost:3000

### Options du crawler

| Option | Effet |
|---|---|
| `--sites mes-sites.txt` | Utiliser une autre liste de sites |
| `--articles 8` | Nombre d'articles visités par site (défaut : 4). Plus = plus de pubs |
| `--parallel 3` | Scanner 3 sites en même temps (plus rapide) |
| `--reloads 3` | Afficher chaque article 3 fois : les pubs changent à chaque affichage |
| `--light` | Ne télécharge ni images ni vidéos (divise la consommation du proxy) |
| `--country GP` | Étiqueter le crawl avec un pays ; le crawl s'arrête si l'IP de sortie n'est pas dans ce pays (sauf `--force`) |
| `--proxy http://user:pass@hote:port` | Passer par un proxy (pour voir les pubs d'un autre pays) |
| `--headful` | Afficher le navigateur (pratique pour déboguer) |
| `--chrome` | Utiliser votre Google Chrome installé (moins souvent bloqué par les sites) |
| `--url https://…` | Scanner une seule page (ex. un article où vous voyez des pubs) |
| `--debug` | Afficher un diagnostic par page et enregistrer des captures dans `data/debug/` |

Exemple — voir les pubs diffusées aux États-Unis via un proxy US :

```bash
npm run crawl -- --sites sites-us.txt --country US --proxy http://user:pass@proxy-us:8080
```

## Voir les pubs d'un autre territoire (ex. Guadeloupe)

Les réseaux native choisissent les pubs selon **l'adresse IP** du visiteur. Pour voir ce qui est diffusé
en Guadeloupe, il faut donc naviguer avec une IP guadeloupéenne, via un **proxy résidentiel** qui propose
le ciblage pays **GP** (code ISO de la Guadeloupe). La plupart des fournisseurs de proxys résidentiels le proposent,
avec une facturation au Go.

### Option gratuite : un contact en Guadeloupe + Tailscale (exit node)

Il n'existe pas de proxy gratuit en Guadeloupe (vérifié dans les listes publiques ProxyScrape et Geonode :
0 résultat). La solution gratuite et fiable : faire sortir votre Mac par la connexion d'une personne
qui se trouve en Guadeloupe, grâce à la fonction **exit node** de Tailscale (gratuite).

1. La personne en Guadeloupe installe **Tailscale** (Mac, PC Windows ou téléphone Android) et accepte
   votre invitation (console Tailscale → *Users* → *Invite users*, ou partage de l'appareil).
2. Sur son appareil, elle active **« Run as exit node »** (Android : menu Tailscale ; Mac/PC : menu Tailscale → *Exit node* →
   *Run as exit node*).
3. Vous l'approuvez dans https://login.tailscale.com/admin/machines → l'appareil → *Edit route settings* →
   cochez *Use as exit node*.
4. **Coupez votre VPN habituel**, puis sur le Mac : menu Tailscale → *Exit node* → choisissez l'appareil guadeloupéen.
5. Lancez le crawl **sans** `--proxy` : le crawler affiche l'IP de sortie au démarrage et s'arrête si elle n'est pas en GP.

```bash
npm run crawl -- --sites sites-guadeloupe.txt --country GP --light --parallel 1
```

Pensez à remettre *Exit node* sur *None* ensuite. Le mode `--light` limite la consommation de la connexion de votre contact.

### Option payante : proxy résidentiel

1. Créez un compte chez un fournisseur de proxys résidentiels, choisissez le pays **Guadeloupe (GP)** et,
   si possible, une **session fixe (sticky)** de 10 à 30 min plutôt qu'une IP qui change à chaque requête.
2. Le fournisseur vous donne une adresse du type `http://identifiant:motdepasse@hote:port`
   (le ciblage pays est souvent inclus dans l'identifiant : suivez sa documentation).
3. Vérifiez l'IP avant de lancer le crawl (la réponse doit indiquer `GP` / Guadeloupe) :

```bash
curl -x "http://identifiant:motdepasse@hote:port" https://ipinfo.io/json
```

4. Lancez le crawl :

```bash
npm run crawl -- --sites sites-guadeloupe.txt --country GP --light --proxy "http://identifiant:motdepasse@hote:port"
```

5. Dans l'interface, filtrez sur le pays **GP**.

Mettez l'adresse du proxy entre guillemets. Le mode `--light` réduit fortement la consommation (comptez quelques
centaines de Mo par crawl au lieu de plusieurs Go). Gardez `--parallel` bas (1 ou 2) : il y a peu d'IP disponibles
en Guadeloupe.

## Conseils pour de bons résultats

- **La base se construit avec le temps.** Anstrex a des millions de pubs parce qu'il crawle en continu
  depuis des années. Lancez le crawl **plusieurs fois par jour** pendant 1 à 2 semaines pour avoir
  une base utile et des statistiques de longévité fiables.
- **Ciblez vos sites** : ajoutez dans `sites.txt` les sites éditeurs de votre niche (santé, finance,
  people, auto…). Les widgets apparaissent surtout **en bas des articles**, pas sur les pages d'accueil.
- **Automatisez** avec une tâche planifiée :
  - Mac/Linux (`crontab -e`), toutes les 4 heures :
    `0 */4 * * * export PATH=/usr/local/bin:/opt/homebrew/bin:$PATH; cd ~/native-spy && npm run crawl >> data/crawl.log 2>&1`
    (cron ne connaît pas le chemin de Node : la partie `export PATH=…` est indispensable)
  - Windows : Planificateur de tâches → action `npm` avec l'argument `run crawl`, dossier de départ = le dossier du projet.

## Niche solaire & pompes à chaleur : mots-clés à tester

`sites.txt` est préréglé pour la France sur cette niche (presse régionale, seniors, argent/aides,
maison/jardin, énergie). Mots-clés utiles dans l'interface (une recherche à la fois) :

- **Solaire :** `solaire`, `photovoltaïque`, `panneau`, `autoconsommation`, `électricité gratuite`, `edf`, `facture`
- **PAC :** `pompe à chaleur`, `pac`, `chauffage`, `chaudière`, `fioul`, `climatisation`, `air-eau`
- **Aides (accroches très utilisées) :** `maprimerénov`, `prime`, `aide`, `subvention`, `état`, `gratuit`, `1 €`
- **Cible :** `propriétaire`, `retraité`, `maison`, `département`

Astuce : l'onglet **Concurrents** avec `solaire` ou `chauffage` donne directement la liste des annonceurs
(installateurs, générateurs de leads, comparateurs). Triez par « Plus longue durée » pour voir les pubs qui marchent.

Avec ~65 sites, un crawl complet prend environ 1 h. Pour aller plus vite :

```bash
npm run crawl -- --articles 2
```

## Limites honnêtes

- **Aucun clic n'est fait sur les pubs.** Suivre les liens de tracking facturerait des clics aux annonceurs
  (c'est de la fraude au clic). Conséquence : pour Taboola, le domaine de l'annonceur est presque toujours
  connu (lien direct) ; pour Outbrain/MGID/Revcontent, on a souvent seulement le **nom du sponsor**,
  pas l'URL de la landing page. Cliquez vous-même sur une pub qui vous intéresse.
- Les sites changent parfois leur code HTML ; si un réseau n'est plus détecté, les sélecteurs sont
  regroupés dans `src/extract.js` (tableau `NETWORKS`), faciles à mettre à jour.
- Certains sites bloquent les navigateurs automatisés ou n'affichent rien sans consentement cookies
  (le crawler tente de cliquer « Accepter »).
- Respectez les conditions d'utilisation des sites visités et gardez un rythme raisonnable.

## Test

```bash
npm test
```

Vérifie l'extraction sur une page factice (`test/fixture.html`) et la recherche par mots-clés.
