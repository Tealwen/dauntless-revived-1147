# Panel Slayer (1.14.7)

The owner's admin panel for a Dauntless Revived 1.14.7 Linux server, in French, reachable from the internet over
HTTPS (default port 8450) and protected by its own accounts. No npm dependency: Node.js 22+ only.

| Page | What it shows or does |
|---|---|
| Tableau de bord | Players online, hunts, Ramsgate/Dojo instances, CPU, RAM, disk, load, uptime, a 15-minute CPU/RAM chart, each service's state and memory, who is where (refreshed every 10 s); admins restart one service (its dependents keep running) or all of them, after a warning of what it cuts |
| Chasses | Each running hunt: island, map, behemoth, port, age, players |
| Slayers | Every account (search by name or UID); a player's page: wallet (Platinum, Rams, Aetherdust, Marks, Prestige, Dark Harvest), give or take back a currency, ban or unban (optionally with the address seen for the account), rename |
| Invitations | Create and list invite codes, change the registration mode until the next metagame restart |
| Journaux | The last lines of each game service, filtered, keys and tokens masked |
| Historique | Every panel action: who, what, when |
| Équipe | Panel accounts and roles; Mon compte: change your password |

Roles: **admin** (everything) and **moderator** (sees everything but the logs and the team; may ban and invite; no
currencies, renames, registration mode or accounts).

## How it works

- The panel talks to the game on loopback only: the metagame's admin API (`/undaunted/api/...`) with its own game
  admin account (`PanelSlayer`, key in `/var/lib/dauntless-revived/panel/admin.key`, mode 600) and the deploy
  server's `/gameservers`. It has no database access of its own, and admin keys are refused through the public
  gateway as before.
- Currencies go through the metagame's `GET /undaunted/api/PlayerWallet/:accountId` and
  `POST /undaunted/api/GrantCurrency` (admin key, loopback): the inventory core as caller `admin`, logged in
  `inventorylog`, one payment per grant id, never below 0.
- Security: HTTPS only (the Let's Encrypt certificate of a domain, or the gateway's self-signed one); scrypt
  password hashes in `users.json` (600, never in the game database); `__Host-` session cookie (Secure, HttpOnly,
  SameSite=Strict), 12 h at most, 2 h idle; a CSRF token on every change; 5 failed logins per name or 10 per
  address lock for 15 minutes; a strict Content Security Policy, and every value shown as text. It never starts
  or stops a game service: a polkit rule (`/etc/polkit-1/rules.d/50-dauntless-panel.rules`) lets the service user
  `restart` the six game units and nothing else.

## Install

After `install.sh`, with the metagame running:

```sh
sudo ./deploy/linux-server/install-panel.sh --domain slayer.example.org   # or without --domain: self-signed
sudo -u dauntless env PANEL_DATA_DIR=/var/lib/dauntless-revived/panel node /opt/dauntless-revived/UndauntedPanel/bin/panel-user.mjs add <name> admin
```

`panel-user.mjs password <name>` resets a forgotten password. Tests: `npm test` in this folder.
