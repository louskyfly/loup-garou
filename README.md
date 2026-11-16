# Loup-garou

Le jeu du loup-garou pour une classe, chacun sur son téléphone. Le narrateur est un
serveur : il distribue les rôles, cache les informations et ne triche pas.

- 5 à 20 joueurs, un téléphone chacun, rien à installer.
- Le salon affiche un QR code : les autres scannent et entrent en deux secondes.
- Rôles : Villageois, Loup-garou, Voyante, Sorcière, Chasseur, Cupidon, Salvateur.
- Nuit chronométrée, vote du village chronométré, morts annoncées à l'aube.
- Amoureux (Cupidon) qui meurent ensemble, chasseur qui tire en mourant.

## Lancer

```bash
npm install
npm start
```

Le terminal affiche deux adresses et un QR code :

```
Loup-garou  ->  http://localhost:3000
En classe   ->  http://192.168.1.42:3000   (meme wifi, scanne le QR)
```

1. Ouvre l'adresse sur ton ordinateur, choisis un pseudo, clique **Créer une partie**.
2. Les autres scannent le QR code de la page (ou tapent le code à 4 lettres).
3. Quand tout le monde est là, **Lancer la partie**.

Tout le monde doit être sur le même réseau (le wifi du lycée, ou le partage de
connexion du téléphone). Si les autres n'arrivent pas à se connecter, c'est presque
toujours le pare-feu Windows qui bloque le port 3000 : autorise Node.js sur le
réseau privé, ou lance en administrateur :

```powershell
New-NetFirewallRule -DisplayName "Loup-garou" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

## Mettre en ligne

Attention : **GitHub Pages ne peut pas faire tourner ce jeu.** Pages ne sert que des
fichiers statiques, et le jeu a besoin d'un serveur Node (WebSockets + état des
parties). GitHub héberge le code, pas le process.

Trois façons de mettre en ligne :

**1. Render, depuis GitHub (gratuit)**

1. Pousse le dépôt sur GitHub.
2. Sur [render.com](https://render.com) : *New* → *Blueprint*, choisis le dépôt.
   Le fichier `render.yaml` à la racine fait le reste (build, start, health check,
   plan gratuit).
3. Tu obtiens une URL du type `https://loup-garou.onrender.com`, partageable à
   toute la classe, sans wifi commun.

Le plan gratuit de Render endort le service après 15 min sans trafic : la première
connexion prend ~30 s à réveiller. WebSockets supportés.

**2. Railway / Fly.io**

Même principe : build `npm ci`, start `npm start`, le `PORT` vient de la plateforme.

**3. En local en cours (le plus simple, zéro latence)**

`npm start` et tout le monde sur le même wifi, voir plus haut.

Une seule instance : l'état des parties est en mémoire, pas en base de données. Pas
de scale horizontal, ce qui n'a aucune importance pour une classe.

## Intégration continue

`.github/workflows/test.yml` installe le projet, démarre le serveur et fait jouer
des robots (5, 7, 12 et 20 joueurs) à chaque push. Si une partie se bloque ou si un
rôle secret fuit, la CI passe au rouge.


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
server.js          machine a etats du jeu + WebSocket + vue personnalisee par joueur
public/index.html  page unique
public/app.js      interface : un ecran par phase
public/style.css   theme nuit
test/sim.js        N robots jouent une partie complete (verifie le deroule)
test/fill.js       ajoute des robots a une salle existante (tester l'interface)
```

`server.js` est autoritaire : le client ne reçoit jamais le rôle des autres joueurs,
même dans le code source de la page. Chaque téléphone reçoit une vue différente.

## Tests

```bash
PORT=3100 node server.js          # dans un terminal
PORT=3100 node test/sim.js 7      # dans un autre : 7 robots jouent jusqu'au bout
```

La simulation vérifie aussi qu'aucune information secrète ne fuit vers un joueur qui
n'a pas le droit de la voir.
