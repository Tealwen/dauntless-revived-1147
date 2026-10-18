#!/bin/sh
# Installs (or updates) Panel Slayer, the owner's admin panel, next to an installed 1.14.7 server.
#   sudo ./deploy/linux-server/install-panel.sh [--domain slayer.example.org] [--port 8450]
# Run it after install.sh, with the metagame running. It never restarts the game: it only (re)starts
# dauntless-panel. What it does, each step once:
#   - the panel's own game admin account (PanelSlayer), whose key it keeps in <data>/panel/admin.key (600);
#   - the TLS certificate: the Let's Encrypt one of --domain when certbot has it (with a renewal hook),
#     otherwise the gateway's self-signed certificate (the browser warns once);
#   - <config>/panel.env, the dauntless-panel service, and a polkit rule letting the service user restart
#     (only restart) the game services from the panel.
# Panel accounts are not created here: the script prints the command for the first one.
set -eu

install_root=/opt/dauntless-revived
data_dir=/var/lib/dauntless-revived
config_dir=/etc/dauntless-revived
service_user=dauntless
port=8450
domain=
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) domain=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --install-root) install_root=$2; shift 2 ;;
    --data-dir) data_dir=$2; shift 2 ;;
    --config-dir) config_dir=$2; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
[ -f "$install_root/UndauntedPanel/src/server.mjs" ] || { echo "no panel in $install_root: run install.sh from this repository first" >&2; exit 1; }
node=$(command -v node)
meta=$install_root/UndauntedMetagame
db=$data_dir/undaunted.db
panel_dir=$data_dir/panel
key_file=$panel_dir/admin.key

install -d -o "$service_user" -g "$service_user" -m 700 "$panel_dir"

# 1. The panel's game admin account
if [ ! -s "$key_file" ]; then
  echo "Creating the panel's game admin account"
  code=PANEL-$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')
  sudo -u "$service_user" "$node" "$install_root/deploy/unix-common/dr-db.cjs" add-invite "$meta" "$db" "$code" >/dev/null
  key=
  for name in PanelSlayer PanelSlayer2 PanelSlayer3; do
    reply=$(curl -s -X POST http://127.0.0.1:61000/undaunted/api/Register -H 'content-type: application/json' \
      -d "{\"Username\":\"$name\",\"InviteCode\":\"$code\"}" || true)
    key=$(printf '%s' "$reply" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).UUK||"")}catch{}})')
    [ -n "$key" ] && break
  done
  sudo -u "$service_user" "$node" "$install_root/deploy/unix-common/dr-db.cjs" del-invite "$meta" "$db" "$code" >/dev/null 2>&1 || true
  [ -n "$key" ] || { echo "could not register the panel account (is the metagame running?)" >&2; exit 1; }
  user_id=$(curl -s http://127.0.0.1:61000/undaunted/api/GetUserInfo -H "x-undaunted-user-api-key: $key" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).UserId||"")}catch{}})')
  [ -n "$user_id" ] || { echo "could not read the panel account" >&2; exit 1; }
  sudo -u "$service_user" "$node" "$install_root/deploy/unix-common/dr-db.cjs" make-admin "$meta" "$db" "$user_id" >/dev/null
  umask 077
  printf '%s\n' "$key" > "$key_file"
  chown "$service_user:$service_user" "$key_file"
  chmod 600 "$key_file"
  echo "Panel game account $name ($user_id) is an admin; its key is in $key_file (not printed)"
fi

# 2. The certificate
tls_dir=$data_dir/tls
cert=$tls_dir/panel-cert.pem
pkey=$tls_dir/panel-key.pem
if [ -n "$domain" ] && [ -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
  install -o "$service_user" -g "$service_user" -m 644 "/etc/letsencrypt/live/$domain/fullchain.pem" "$cert"
  install -o "$service_user" -g "$service_user" -m 600 "/etc/letsencrypt/live/$domain/privkey.pem" "$pkey"
  hook=/etc/letsencrypt/renewal-hooks/deploy/dauntless-panel.sh
  cat > "$hook" <<EOF
#!/bin/sh
# Copies the renewed certificate of $domain for Panel Slayer (readable by $service_user) and reloads the panel
[ "\${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/$domain" ] || exit 0
install -o $service_user -g $service_user -m 644 "\$RENEWED_LINEAGE/fullchain.pem" $cert
install -o $service_user -g $service_user -m 600 "\$RENEWED_LINEAGE/privkey.pem" $pkey
systemctl try-reload-or-restart dauntless-panel
EOF
  chmod 755 "$hook"
  echo "Certificate: Let's Encrypt for $domain (renewal hook $hook)"
  url_host=$domain
else
  [ -n "$domain" ] && echo "No Let's Encrypt certificate for $domain on this machine: using the gateway's self-signed one" >&2
  if [ ! -f "$cert" ]; then
    install -o "$service_user" -g "$service_user" -m 644 "$tls_dir/gateway-cert.pem" "$cert"
    install -o "$service_user" -g "$service_user" -m 600 "$tls_dir/gateway-key.pem" "$pkey"
  fi
  url_host=$(sed -n 's/^DR_MY_IP=//p' "$config_dir/server.conf" 2>/dev/null || true)
  [ -n "$url_host" ] || url_host="<server address>"
fi

# 3. Settings and service
cat > "$config_dir/panel.env" <<EOF
PANEL_BIND=0.0.0.0
PANEL_PORT=$port
PANEL_CERT=$cert
PANEL_KEY=$pkey
PANEL_DATA_DIR=$panel_dir
PANEL_ADMIN_KEY_FILE=$key_file
PANEL_METAGAME_URL=http://127.0.0.1:61000
PANEL_DEPLOY_URL=http://127.0.0.1:61001
NODE_ENV=production
EOF
chown "root:$service_user" "$config_dir/panel.env"
chmod 640 "$config_dir/panel.env"
sed -e "s|@ROOT@|$install_root|g" -e "s|@CONFIG@|$config_dir|g" -e "s|@DATA@|$data_dir|g" -e "s|@USER@|$service_user|g" -e "s|@NODE@|$node|g" \
  "$install_root/deploy/linux-server/systemd/dauntless-panel.service" > /etc/systemd/system/dauntless-panel.service
# The panel may restart the game services (and nothing else): a polkit rule for the service user
units='"dauntless-metagame.service", "dauntless-deploy.service", "dauntless-gateway.service", "dauntless-content.service", "dauntless-allowlist.service", "dauntless-invite.service"'
install -d -m 755 /etc/polkit-1/rules.d
sed -e "s|@USER@|$service_user|g" -e "s|@UNITS@|$units|" "$install_root/deploy/linux-server/polkit/50-dauntless-panel.rules" > /etc/polkit-1/rules.d/50-dauntless-panel.rules
chmod 644 /etc/polkit-1/rules.d/50-dauntless-panel.rules
systemctl daemon-reload
systemctl enable dauntless-panel >/dev/null 2>&1
systemctl restart dauntless-panel

echo "Panel Slayer: https://$url_host:$port"
if [ ! -s "$panel_dir/users.json" ]; then
  echo "Create the first panel account (the password is asked twice, hidden):"
  echo "  sudo -u $service_user env PANEL_DATA_DIR=$panel_dir $node $install_root/UndauntedPanel/bin/panel-user.mjs add <name> admin"
fi
