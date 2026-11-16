# Loup-garou

Le jeu du loup-garou pour une classe, chacun sur son téléphone. Le narrateur est un
programme : il distribue les rôles, cache les informations et ne triche pas.

**Jouer tout de suite : <https://louskyfly.github.io/loup-garou/>**

- 5 à 20 joueurs, un téléphone chacun, rien à installer.
- Le salon affiche un QR code : les autres scannent et entrent en deux secondes.
- Rôles : Villageois, Loup-garou, Voyante, Sorcière, Chasseur, Cupidon, Salvateur.
- Nuit chronométrée, débat et vote chronométrés, morts annoncées à l'aube.
- Amoureux qui meurent ensemble, chasseur qui tire en mourant.

## Les deux façons de jouer

### 1. En ligne, depuis GitHub Pages (aucune installation)

Ouvre <https://louskyfly.github.io/loup-garou/>, choisis un pseudo, **Créer une
partie**, et fais scanner le QR code.

Il n'y a pas de serveur : **c'est l'onglet de l'hôte qui fait tourner la partie**.
Les autres téléphones s'y connectent directement en WebRTC (PeerJS pour la mise en
relation). Conséquences à connaître :

- l'hôte doit garder son onglet ouvert pendant toute la partie, écran allumé ;
- il faut internet (le wifi du lycée suffit), mais pas besoin que tout le monde soit
  sur le même réseau ;
- si l'hôte recharge sa page, la partie est perdue — les autres doivent se
  reconnecter à un nouveau salon ;
- sur un réseau qui bloque le pair-à-pair (certains wifi scolaires très filtrés), la
  connexion échoue. Dans ce cas, utilise la version locale ci-dessous.

### 2. En local, avec un vrai serveur (le plus solide)

```bash
npm install
npm start
```

Le terminal affiche deux adresses :

```
Loup-garou  ->  http://localhost:3000
En classe   ->  http://192.168.1.42:3000   (meme wifi, scanne le QR)
```

Tout le monde doit être sur le même réseau. Si les autres n'arrivent pas à se
connecter, c'est presque toujours le pare-feu Windows : autorise Node.js sur le
réseau privé, ou lance une fois en administrateur :

```powershell
New-NetFirewallRule -DisplayName "Loup-garou" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

Ici l'état vit dans le serveur : un téléphone qui se déconnecte peut revenir, et
personne n'a besoin de garder un onglet ouvert.

## Règles appliquées

- **Nuit** : les loups choisissent une proie (majorité de la meute), la voyante sonde
  un joueur, le salvateur protège quelqu'un, la sorcière voit la proie et peut la
  sauver ou empoisonner quelqu'un. La nuit se termine dès que tout le monde a joué
  (ou au bout du chrono).
- **Aube** : les morts sont annoncés. Les amoureux meurent ensemble.
- **Jour** : débat chronométré, avec un chat. L'hôte peut écourter.
- **Vote** : tout le monde vote (ou s'abstient). Majorité = condamné, égalité =
  personne. Le chasseur tire en mourant.
- **Victoire** : le village gagne quand il ne reste plus de loup ; les loups gagnent
  quand ils sont aussi nombreux que les autres ; les amoureux gagnent s'ils sont les
  deux derniers survivants.

Les rôles sont composés automatiquement selon le nombre de joueurs (1 loup pour 5-7,
2 pour 8-11, ...). L'hôte peut tout régler dans le salon : nombre de loups, rôles
spéciaux, durées.

## Structure

```
public/engine.js   moteur du jeu, sans transport (partage entre les deux modes)
public/app.js      interface : un ecran par phase, plus les deux transports
public/index.html  page unique
public/style.css   theme nuit
public/peerjs*.js  WebRTC pour le mode GitHub Pages (lib vendorisee)
public/qrcode.js   QR code cote client (lib vendorisee)
server.js          transport Node/WebSocket (mode local)
test/sim.js        N robots jouent une partie complete contre le serveur
test/fill.js       ajoute des robots a une salle existante (tester l'interface)
```

`engine.js` est autoritaire : le client ne reçoit jamais le rôle des autres joueurs,
même dans le code source de la page. Chaque téléphone reçoit une vue différente et
filtrée.

## Tests

Le serveur doit tourner :

```bash
PORT=3100 node server.js
PORT=3100 node test/sim.js 7     # 7 robots jouent jusqu'au bout
```

La simulation vérifie aussi qu'aucune information secrète ne fuit vers un joueur qui
n'a pas le droit de la voir. `.github/workflows/test.yml` rejoue tout à chaque push
(5, 7, 12 et 20 joueurs).

## Publier une nouvelle version du site

GitHub Pages sert la branche `gh-pages`, qui contient le contenu de `public/` à la
racine. Après une modification :

```bash
git subtree push --prefix public origin gh-pages
```
