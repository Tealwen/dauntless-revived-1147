# Clean install of the Dauntless Revived 1.14.7 server on Ubuntu (Proton)

For whoever installs the server (a person or an assistant working on the server itself). This replaces an
existing Dauntless Revived 1.4.4 install with a fresh 1.14.7 one: new database, new accounts. Read the whole
file first. Background: `README.md` in this folder (section "Dauntless 1.14.7"); the port's own notes are in
`UndauntedInternalServer1147/README.md`.

## What you have

- This repository, branch `port-1.14.7` (delivered as a git bundle: `git clone dauntless-revived-1147.bundle
  -b port-1.14.7 <folder>`).
- The 1.14.7 game files on a web folder, laid out as `<base>/dauntless_rel-1.14.7_Shipping_2024-04-01_14-59-21_647472/<path>`
  (the owner gives `<base>`).
- The server DLLs are already in `deploy/game-1147/` (pinned by `SHA256SUMS`); nothing has to be built on Windows.

## Steps

1. **Back up the old install, then stop it.** Do not delete anything before the backup exists.
   ```sh
   sudo systemctl stop dauntless-metagame dauntless-deploy dauntless-content dauntless-gateway dauntless-allowlist
   sudo systemctl disable dauntless-metagame dauntless-deploy dauntless-content dauntless-gateway dauntless-allowlist
   sudo tar -czf /root/dauntless-1.4.4-backup-$(date +%F).tar.gz /var/lib/dauntless-revived /etc/dauntless-revived /opt/dauntless-revived
   ```
   Then move the old state away so the install starts from zero (the backup keeps it):
   `sudo mv /var/lib/dauntless-revived /var/lib/dauntless-revived.1.4.4 && sudo mv /etc/dauntless-revived /etc/dauntless-revived.1.4.4`.
   Keep the old gateway certificate only if existing invites must keep working (`/var/lib/dauntless-revived.1.4.4/tls`);
   a fresh install makes a new certificate, so every invite must be sent again.
2. **Requirements:** Node.js 22 or 24, npm, `xvfb` (`xvfb-run`), nftables (public mode), Proton (Steam's Proton or
   GE-Proton in `~/.local/share/Steam/compatibilitytools.d/` of the service user, or pass `--proton <path>`) or 64-bit Wine.
3. **Game files** (about 16.5 GB, every file checked against the manifest):
   ```sh
   sudo mkdir -p /srv/dauntless/Game1147 && sudo chown "$USER" /srv/dauntless/Game1147
   node deploy/linux-server/fetch-game-1147.mjs --base <base> --out /srv/dauntless/Game1147/Dauntless
   ```
4. **Install** (from the repository root; public mode behind the TLS gateway on 443):
   ```sh
   sudo ./deploy/linux-server/install.sh \
     --game-dir /srv/dauntless/Game1147/Dauntless \
     --my-ip <public IPv4 of the server> \
     --mode public \
     --firewall-interface <network interface, e.g. eth0> \
     --game-version 1.14.7
   ```
   Add `--proton <path to the proton script>` to pin a Proton build. The service user (`dauntless`) must be able to
   read the game folder and run Proton.
5. **Check:**
   - `sudo ./deploy/linux-server/stack.sh status` - all services active.
   - `sudo ./deploy/linux-server/stack.sh logs` - the metagame log shows `Progression config: 33 tracks ... active Hunt
     Pass season43` and `stomp: notification endpoint`; the deploy server shows a Ramsgate starting on UDP 8777.
   - The Ramsgate process must stay up under Proton (this is the first real Proton run of the 1.14.7 server: if it
     exits, read its log in `/var/lib/dauntless-revived/logs` and the deploy log, and report the error).
6. **Invite the owner:** `sudo -u dauntless node /opt/dauntless-revived/deploy/unix-common/new-invite.mjs --config
   /etc/dauntless-revived --name <name>` prints a `dauntless-revived://join?v=2&...` invite to paste into the launcher.

## Notes

- One metagame serves one game version: 1.4.4 clients cannot join this server.
- The main store sells the 1.4.4 webstore catalogue for Platinum (`STORE=free`, `STORE_PRICING=platinum` in
  `/etc/dauntless-revived/metagame.env`); the Elite Hunt Pass is given to everyone (`ENTITLEMENTS_DEFAULT`).
- Ports: TCP 443 (gateway) and UDP 8770-8777 (game servers, opened per player by the allowlist).
