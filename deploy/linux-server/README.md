# Linux server port

This is a separate Linux deployment port for Dauntless Revived. It does not replace or call the
Windows Server kit in `deploy/windows-server/`.

## Architecture

- UndauntedMetagame, UndauntedDeployServer, UndauntedContent and UndauntedGateway run natively under
  Node.js on Linux.
- Ramsgate, the Training Dojo and hunt processes are still the original Dauntless 1.4.4 Windows
  x86_64 executable. `launch-gameserver.mjs` runs them through Proton or Wine.
- The deploy server keeps its existing process contract: `GAMESERVER_BINARY_PATH` points at the
  Linux wrapper instead of directly at the Windows EXE.
- Public mode uses the existing TLS gateway and a Linux nftables allowlist. Only player IPs reported
  by authenticated gateway traffic are admitted to UDP 8770-8777.
- systemd supervises the services.

The launcher/server DLL pins and the game EXE pin are checked before the Linux game runner is used.

## Requirements

- x86_64 Linux with glibc
- Node.js 20.19+; Node.js 22 or 24 is recommended
- npm
- Proton/GE-Proton or 64-bit Wine
- `xvfb-run` for a headless game worker unless a real X display is supplied
- systemd for the normal service install
- nftables for public mode
- about 11 GB for the pinned Dauntless 1.4.4 game tree, plus prefix/cache space

The server needs the exact pinned build:
`d3d41e614908d2befd518b27046d9822d6130ef12ba3504babbdb786bef9cff4` for
`Archon/Binaries/Win64/Dauntless-Win64-Shipping.exe`.

## Install on one Linux host

Private/Tailscale-style deployment:

```sh
sudo ./deploy/linux-server/install.sh \
  --game-dir /srv/dauntless/BaseGame144/Dauntless \
  --my-ip 100.x.y.z \
  --mode private
```

Public deployment:

```sh
sudo ./deploy/linux-server/install.sh \
  --game-dir /srv/dauntless/BaseGame144/Dauntless \
  --my-ip 203.0.113.10 \
  --mode public \
  --firewall-interface eth0
```

Use an explicit Proton build:

```sh
sudo ./deploy/linux-server/install.sh \
  --game-dir /srv/dauntless/BaseGame144/Dauntless \
  --my-ip 203.0.113.10 \
  --mode public \
  --firewall-interface eth0 \
  --proton /home/dauntless/.local/share/Steam/compatibilitytools.d/GE-Proton10-1/proton
```

Or an explicit Wine binary:

```sh
sudo ./deploy/linux-server/install.sh \
  --game-dir /srv/dauntless/BaseGame144/Dauntless \
  --my-ip 203.0.113.10 \
  --mode public \
  --firewall-interface eth0 \
  --wine /usr/bin/wine64
```

The normal install writes code under `/opt/dauntless-revived`, state under
`/var/lib/dauntless-revived`, secret configuration under `/etc/dauntless-revived`, and systemd
units under `/etc/systemd/system`.

It creates a dedicated `dauntless` service user by default. Make sure that user can read/traverse
the game tree you pass with `--game-dir`.

## Public firewall

The allowlist helper owns only the nftables table `inet dauntless_revived`. It keeps UDP
8770-8777 closed except for currently authenticated player IPs. The TLS gateway listens on TCP 443.

If another firewall manager (UFW, firewalld, a cloud firewall) also filters the host, it must permit
TCP 443 and the UDP game range at its outer layer; the Dauntless nftables table still applies the
per-player restriction. Do not create a broad public UDP rule unless the dynamic allowlist remains
in the packet path.

## Service control

```sh
sudo ./deploy/linux-server/stack.sh status
sudo ./deploy/linux-server/stack.sh restart
sudo ./deploy/linux-server/stack.sh logs
sudo ./deploy/linux-server/stack.sh restart deploy
```

## Create an invite

```sh
sudo -u dauntless node /opt/dauntless-revived/deploy/unix-common/new-invite.mjs \
  --config /etc/dauntless-revived \
  --name FriendName
```

The invite code is stored directly in SQLite and the complete v1/v2 invite is printed once.

## Separate Linux game worker

OpenBSD uses this mode, but it is also useful when you want the Node services and game processes on
different Linux machines.

On the worker:

```sh
sudo ./deploy/linux-server/install-worker.sh \
  --game-dir /srv/dauntless/BaseGame144/Dauntless \
  --proton /home/dauntless/.local/share/Steam/compatibilitytools.d/GE-Proton10-1/proton
```

The installer creates the fixed `dr-game-worker` command. For an SSH worker key, restrict
`authorized_keys` to the printed `restrict,command=".../ssh-worker-command.sh"` prefix. The forced
command accepts only one bounded base64url JSON argv payload and never evaluates it as shell syntax.

## Dauntless 1.14.7

`--game-version 1.14.7` runs the servers on the Dauntless 1.14.7 build (CL 647472) instead of 1.4.4:

```sh
sudo ./deploy/linux-server/install.sh \
  --game-dir /srv/dauntless/Game1147/Dauntless \
  --my-ip 203.0.113.10 \
  --mode public \
  --firewall-interface eth0 \
  --game-version 1.14.7
```

- `prepare-game.sh` checks the 1.14.7 exe (`f3f95fbf…b66b`) and installs `winmm.dll` (the loader,
  `UndauntedProxy/`) and the 1.14.7 `UndauntedInternalServer.dll` from `deploy/game-1147/`, checked
  against `deploy/game-1147/SHA256SUMS`. A 1.4.4 `dxgi.dll` in the folder is moved aside: it crashes
  1.14.7 at start-up.
- The game runner forces `winmm=n,b` instead of `dxgi=n,b` (`DR_GAME_VERSION` in `deployserver.env`).
- `metagame.env` gets `TARGET_GAME_VERSION=1.14.7`, `TARGET_CHANGELIST=647472`, the 1.14.7 progression
  tracks (`UndauntedMetagame/src/vendor/progression-1147`, from `PORT-1.14.7/tools/gen-progression-1147.js`),
  `ACTIVE_HUNT_PASS=season43`, the Elite entitlement in `ENTITLEMENTS_DEFAULT`, and the main store sold
  for Platinum (`STORE=free`, `STORE_PRICING=platinum`). Values already in the file for these keys are kept.
- The gateway sends WebSocket upgrades offering a `v10/v11/v12.stomp` subprotocol (the 1.14.7
  notification service) to the metagame, and every other upgrade to chat, as before.

One metagame serves one game version: 1.4.4 players cannot connect to a 1.14.7 server. Players need
the 1.14.7 client with `winmm.dll` and the 1.14.7 `UndauntedInternalServer.dll` next to its exe, and a
launcher that starts it (the 1.4.4 launcher pins the 1.4.4 build).

When the DLL is rebuilt, copy `UndauntedInternalServer1147/x64/Release/UndauntedInternalServer.dll`
(and `UndauntedProxy/winmm.dll` if it changed) into `deploy/game-1147/` and regenerate the sums:

```sh
cd deploy/game-1147 && sha256sum winmm.dll UndauntedInternalServer.dll > SHA256SUMS
```

Replacing a running 1.4.4 server: back up `/var/lib/dauntless-revived/undaunted.db` first, install
the 1.14.7 game tree in its own folder, then run the install again with `--game-version 1.14.7`. The
database is reused; new tables are added by the migrations at start-up.

Not validated yet: the 1.14.7 exe under Wine/Proton (only tested on Windows), and a 1.4.4 production
database opened by 1.14.7 clients (characters, loadouts and inventories made by 1.4.4).

## Validation status

On 1 October 2026 this port was tested against the local pinned
`/home/mikael-nurminen/Downloads/BaseGame144/Dauntless` tree:

- all 410 manifest files were found at their expected sizes;
- the 1.4.4 EXE hash matched;
- the two pinned server DLLs were installed and hash-checked;
- all four Node services built natively on Linux;
- the SQLite migrations and game-server API key registration succeeded;
- a three-service smoke test started metagame/content/deploy together;
- the deploy API reported a live Ramsgate process on UDP 8777;
- a fake Wine runtime received the exact production game-server argv, including `-server -nullrhi`;
- the Linux CI job passes the full server test suites and the Unix-port tests.

This machine did not have Wine or Proton installed, so the real Dauntless Windows process has not yet
been booted here under Wine/Proton. The next live milestone is Ramsgate plus one hunt with a real
Linux compatibility runtime.
