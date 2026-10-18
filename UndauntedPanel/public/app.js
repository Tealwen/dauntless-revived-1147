// Panel Slayer interface. Everything the server returns is shown as text (textContent), never as HTML.
"use strict";

const State = { me: null, timer: null, page: "dashboard" };
const $ = (Id) => document.getElementById(Id);

const CURRENCY_ICONS = { platinum: "💎", rams: "🪙", aetherdust: "✨", marks_steel: "⚙️", marks_gilded: "🏅", prestige: "⭐", dark_harvest: "🎃" };
const ERRORS = {
  bad_login: "Nom ou mot de passe incorrect.", locked: "Trop d'essais : réessaie dans 15 minutes.", not_logged_in: "Session terminée, reconnecte-toi.",
  forbidden: "Ton rôle ne permet pas cette action.", bad_csrf: "Session expirée, recharge la page.", insufficient_balance: "Le joueur n'a pas assez de cette monnaie.",
  grant_id_reused: "Cette opération a déjà été faite.", account_not_found: "Compte introuvable.", no_character: "Ce joueur n'a pas encore de personnage.",
  reason_required: "Un motif est obligatoire.", admin_account_protected: "Un compte administrateur ne peut pas être banni.", address_not_observed: "Cette adresse n'a jamais été vue pour ce compte.",
  metagame_unreachable: "Le metagame ne répond pas.", bad_amount: "Montant invalide (1 à 1 000 000).", bad_password: "Mot de passe actuel incorrect.",
  username_taken: "Ce pseudo est déjà pris.", invalid_username: "Pseudo invalide.",
};

function h(Tag, Props = {}, ...Children) {
  const El = document.createElement(Tag);
  for (const [Key, Value] of Object.entries(Props)) {
    if (Value === undefined || Value === null || Value === false) continue;
    if (Key === "class") El.className = Value;
    else if (Key.startsWith("on")) El.addEventListener(Key.slice(2), Value);
    else if (Key === "text") El.textContent = Value;
    // The CSP allows no inline style attribute: styles go through the CSSOM
    else if (Key === "style") El.style.cssText = Value;
    else El.setAttribute(Key, Value === true ? "" : Value);
  }
  for (const Child of Children.flat()) {
    if (Child === null || Child === undefined || Child === false) continue;
    El.append(Child instanceof Node ? Child : document.createTextNode(String(Child)));
  }
  return El;
}

function Toast(Message, Bad = false) {
  const El = $("toast");
  El.textContent = Message;
  El.className = "toast" + (Bad ? " bad" : "");
  clearTimeout(Toast.timer);
  Toast.timer = setTimeout(() => El.classList.add("hidden"), 4500);
}

async function Api(Method, Path, Body) {
  const Headers = {};
  if (Body !== undefined) Headers["content-type"] = "application/json";
  if (Method !== "GET" && State.me) Headers["x-csrf-token"] = State.me.csrf;
  const Reply = await fetch(Path, { method: Method, headers: Headers, body: Body === undefined ? undefined : JSON.stringify(Body), credentials: "same-origin" });
  const Json = await Reply.json().catch(() => ({}));
  if (Reply.status === 401 && Path !== "/api/login" && Path !== "/api/me") { ShowLogin(); throw new Error(ERRORS.not_logged_in); }
  if (!Reply.ok) throw new Error(ERRORS[Json.error] ?? Json.error ?? `Erreur ${Reply.status}`);
  return Json;
}

const Can = (Ability) => State.me?.can.includes(Ability);
const Num = (Value) => new Intl.NumberFormat("fr-FR").format(Value ?? 0);
const Bytes = (Value) => Value == null ? "—" : Value > 1e9 ? `${(Value / 1e9).toFixed(1)} Go` : `${Math.round(Value / 1e6)} Mo`;
function Duration(Seconds) {
  const S = Math.max(0, Math.round(Seconds));
  const D = Math.floor(S / 86400), H = Math.floor(S % 86400 / 3600), M = Math.floor(S % 3600 / 60);
  return D ? `${D} j ${H} h` : H ? `${H} h ${M} min` : `${M} min ${S % 60} s`;
}
const Since = (Iso) => Iso ? Duration((Date.now() - Date.parse(Iso)) / 1000) : "—";
const When = (Iso) => Iso ? new Date(Iso).toLocaleString("fr-FR") : "—";
const ShortMap = (Map) => String(Map ?? "").split("/").pop().split("?")[0].replace(/_persistent$/, "") || "—";
const HuntName = (Id) => Id ? String(Id).replace(/^ShatteredIsles_/, "").replace(/_/g, " ") : null;

function Where(Player) {
  if (Player.huntId && !/Ramsgate/.test(Player.huntId)) return h("span", { class: "pill aether" }, `🐾 ${HuntName(Player.huntId)}`);
  if (/ramsgate/i.test(Player.map ?? "") || /Ramsgate/.test(Player.huntId ?? "")) return h("span", { class: "pill" }, "🏰 Ramsgate");
  return h("span", { class: "pill" }, ShortMap(Player.map) || "En ligne");
}

function Stat(Label, Value, Percent) {
  return h("div", { class: "card stat" },
    h("div", { class: "value" }, Value),
    h("div", { class: "label" }, Label),
    Percent === undefined ? null : h("div", { class: "bar" + (Percent > 85 ? " hot" : "") }, h("span", { style: `width:${Math.min(100, Percent)}%` })));
}

function Chart(History) {
  const NS = "http://www.w3.org/2000/svg";
  const Svg = document.createElementNS(NS, "svg");
  Svg.setAttribute("viewBox", "0 0 300 100");
  Svg.setAttribute("preserveAspectRatio", "none");
  Svg.setAttribute("class", "chart");
  for (const Y of [25, 50, 75]) {
    const Line = document.createElementNS(NS, "line");
    Object.entries({ x1: 0, x2: 300, y1: Y, y2: Y, stroke: "#21395a", "stroke-width": 1 }).forEach(([K, V]) => Line.setAttribute(K, V));
    Svg.append(Line);
  }
  for (const [Key, Colour] of [["cpu", "#2fe0c8"], ["mem", "#ffb547"]]) {
    if (History.length < 2) break;
    const Points = History.map((Point, Index) => `${(Index / (History.length - 1)) * 300},${100 - Math.min(100, Point[Key])}`).join(" ");
    const Line = document.createElementNS(NS, "polyline");
    Object.entries({ points: Points, fill: "none", stroke: Colour, "stroke-width": 2.5, "vector-effect": "non-scaling-stroke", "stroke-linejoin": "round" }).forEach(([K, V]) => Line.setAttribute(K, V));
    Svg.append(Line);
  }
  return Svg;
}

function Table(Headers, Rows, OnClick) {
  if (Rows.length === 0) return h("p", { class: "empty" }, "Rien pour l'instant.");
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, Headers.map((Header) => h("th", {}, Header)))),
    h("tbody", {}, Rows.map((Row) => h("tr", OnClick ? { class: "clickable", onclick: () => OnClick(Row.item) } : {}, Row.cells.map((Cell) => h("td", {}, Cell)))))));
}

// --- Pages -------------------------------------------------------------------------------------------

const Pages = {
  async dashboard(Main) {
    const D = await Api("GET", "/api/dashboard");
    const S = D.system;
    const Hunts = D.servers.filter((Server) => Server.kind === "hunt");
    const Cities = D.servers.filter((Server) => Server.kind !== "hunt");
    $("game-badge").textContent = D.game ? `${D.game.name} · ${D.game.version}` : "metagame injoignable";
    Main.replaceChildren(
      h("h1", {}, "🏰 Tableau de bord"),
      h("div", { class: "grid stats" },
        Stat("Slayers en ligne", Num(D.players.length)),
        Stat("Chasses en cours", Num(Hunts.length)),
        Stat("Ramsgate / Dojo", Num(Cities.length)),
        Stat("Processeur", `${S.cpu} %`, S.cpu),
        Stat("Mémoire", `${S.memory.usedPercent} %`, S.memory.usedPercent),
        Stat("Disque", S.disk ? `${S.disk.usedPercent} %` : "—", S.disk?.usedPercent)),
      h("div", { class: "grid two" },
        h("div", { class: "card" },
          h("h2", {}, "📈 CPU et RAM (15 min)"), Chart(S.history),
          h("div", { class: "legend" }, h("span", {}, h("i", { style: "background:#2fe0c8" }), "Processeur"), h("span", {}, h("i", { style: "background:#ffb547" }), "Mémoire")),
          h("p", { class: "muted" }, `${S.hostname} · ${S.cores} cœurs · charge ${S.load.join(" / ")} · allumé depuis ${Duration(S.uptimeSeconds)} · RAM ${Bytes(S.memory.used)} / ${Bytes(S.memory.total)} · disque ${Bytes(S.disk?.used)} / ${Bytes(S.disk?.total)}`)),
        h("div", { class: "card" },
          h("h2", {}, "⚙️ Services"),
          Table(["Service", "État", "Mémoire", "Depuis"], S.services.map((Service) => ({
            cells: [Service.unit.replace(/^dauntless-/, ""), h("span", { class: "pill " + (Service.active === "active" ? "ok" : "bad") }, Service.active === "active" ? "actif" : Service.active), Bytes(Service.memory), Since(Service.since)],
          }))),
          D.game ? h("p", { class: "muted" }, `Metagame lancé depuis ${Duration(D.game.uptimeSeconds)} · inscription : ${D.game.registration}`) : null)),
      h("div", { class: "card" },
        h("h2", {}, "⚔️ Qui est où"),
        Table(["Slayer", "Où", "Depuis"], D.players.map((Player) => ({ item: Player, cells: [Player.username, Where(Player), Player.enteredHuntAt ? Since(Player.enteredHuntAt) : "—"] })), (Player) => OpenPlayer(Player.accountId))),
      h("div", { class: "card" },
        h("h2", {}, "🗺️ Instances"),
        Table(["Port", "Type", "Carte", "Chasse", "Joueurs attendus", "Depuis"], D.servers.map((Server) => ({
          cells: [Server.port, Server.kind, ShortMap(Server.map), HuntName(Server.huntId) ?? "—", Server.expectedPlayers.map((Player) => Player.username).join(", ") || "—", Since(Server.startedAt)],
        })))));
  },

  async hunts(Main) {
    const D = await Api("GET", "/api/dashboard");
    const Hunts = D.servers.filter((Server) => Server.kind === "hunt");
    Main.replaceChildren(h("h1", {}, "🐾 Chasses en cours"),
      Hunts.length === 0 ? h("div", { class: "card" }, h("p", { class: "empty" }, "Aucune chasse en cours.")) :
        h("div", { class: "grid two" }, Hunts.map((Server) => {
          const Present = D.players.filter((Player) => Player.huntId === Server.huntId);
          return h("div", { class: "card glow" },
            h("h2", {}, `🐾 ${HuntName(Server.huntId) ?? ShortMap(Server.map)}`),
            h("p", {}, h("span", { class: "pill" }, `port ${Server.port}`), " ", h("span", { class: "pill aether" }, `depuis ${Since(Server.startedAt)}`)),
            h("p", { class: "muted" }, `Carte : ${ShortMap(Server.map)}${Server.behemoth && Server.behemoth !== "None" ? ` · Béhémoth : ${Server.behemoth}` : ""}`),
            h("h3", {}, "Joueurs"),
            h("p", {}, (Server.expectedPlayers.length ? Server.expectedPlayers : Present).map((Player) => h("span", { class: "pill", style: "margin:2px" }, Player.username))));
        })));
  },

  async players(Main) {
    const Search = h("input", { placeholder: "Rechercher un pseudo ou un UID…", maxlength: 64 });
    const List = h("div");
    const Load = async () => {
      const Players = await Api("GET", `/api/players?q=${encodeURIComponent(Search.value)}`);
      List.replaceChildren(Table(["Slayer", "UID", "Statut"], Players.map((Player) => ({
        item: Player,
        cells: [Player.username, h("span", { class: "mono" }, Player.accountId), Player.online ? Where(Player) : h("span", { class: "pill" }, "hors ligne")],
      })), (Player) => OpenPlayer(Player.accountId)));
    };
    let Debounce;
    Search.addEventListener("input", () => { clearTimeout(Debounce); Debounce = setTimeout(() => Load().catch((E) => Toast(E.message, true)), 250); });
    Main.replaceChildren(h("h1", {}, "⚔️ Slayers"), h("div", { class: "card" }, Search, List));
    await Load();
  },

  async player(Main, Id) {
    const D = await Api("GET", `/api/player?id=${encodeURIComponent(Id)}`);
    const W = D.wallet;
    const Character = W.characters[0];
    const Ban = D.moderation?.ban;
    const Body = [h("p", {}, h("a", { href: "#players" }, "← Retour aux Slayers")),
      h("h1", {}, `⚔️ ${W.username}`),
      h("p", {}, h("span", { class: "mono muted" }, W.accountId), " ", D.online ? Where(D.online) : h("span", { class: "pill" }, "hors ligne"), " ",
        Ban?.active ? h("span", { class: "pill bad" }, `banni : ${Ban.reason}`) : null)];

    Body.push(h("div", { class: "card" }, h("h2", {}, "💰 Porte-monnaie"),
      Character ? h("div", { class: "wallet" }, W.currencies.map((Currency) => h("div", { class: "coin" }, `${CURRENCY_ICONS[Currency.key] ?? ""} ${Currency.label}`, h("b", {}, Num(Character.balances[Currency.key]))))) :
        h("p", { class: "empty" }, "Pas encore de personnage.")));

    if (Can("currency") && Character) {
      const Currency = h("select", {}, W.currencies.map((Item) => h("option", { value: Item.key }, `${CURRENCY_ICONS[Item.key] ?? ""} ${Item.label}`)));
      const Amount = h("input", { type: "number", min: 1, max: 1000000, value: 100 });
      const Reason = h("input", { maxlength: 120, placeholder: "Motif (facultatif)" });
      const Do = async (Sign, Button) => {
        const Value = Number(Amount.value);
        if (!Number.isInteger(Value) || Value < 1) return Toast(ERRORS.bad_amount, true);
        const Label = Currency.selectedOptions[0].textContent;
        if (!confirm(`${Sign > 0 ? "Donner" : "Retirer"} ${Num(Value)} ${Label} à ${W.username} ?`)) return;
        Button.disabled = true;
        try {
          const R = await Api("POST", "/api/player/currency", { accountId: W.accountId, currency: Currency.value, amount: Sign * Value, reason: Reason.value, requestId: crypto.randomUUID().replace(/-/g, "") });
          Toast(`${Sign > 0 ? "Donné" : "Retiré"} : nouveau solde ${Num(R.balance)}`);
          Router();
        } catch (E) { Toast(E.message, true); } finally { Button.disabled = false; }
      };
      const Give = h("button", { class: "btn btn-gold", type: "button" }, "Donner");
      const Take = h("button", { class: "btn btn-ember", type: "button" }, "Retirer");
      Give.addEventListener("click", () => Do(1, Give));
      Take.addEventListener("click", () => Do(-1, Take));
      Body.push(h("div", { class: "card" }, h("h2", {}, "🎁 Donner ou retirer"),
        h("div", { class: "row" }, h("label", {}, "Monnaie", Currency), h("label", {}, "Montant", Amount), h("label", {}, "Motif", Reason), Give, Take),
        h("p", { class: "muted" }, "Le joueur voit son nouveau solde en rouvrant la boutique ou en changeant de carte. Un retrait ne descend jamais sous 0.")));
    }

    if (Can("ban")) {
      const Reason = h("input", { maxlength: 300, placeholder: "Motif (obligatoire)" });
      const Addresses = D.moderation?.addresses ?? [];
      const Address = h("select", {}, h("option", { value: "" }, "Compte seulement"), Addresses.map((Item) => h("option", { value: Item.address ?? Item }, `Compte + IP ${Item.address ?? Item}`)));
      const Act = async (Active) => {
        if (!Reason.value.trim()) return Toast(ERRORS.reason_required, true);
        if (!confirm(`${Active ? "Bannir" : "Débannir"} ${W.username} ?`)) return;
        try {
          await Api("POST", "/api/player/ban", { accountId: W.accountId, reason: Reason.value, active: Active, address: Active ? Address.value : undefined });
          Toast(Active ? "Joueur banni." : "Joueur débanni.");
          Router();
        } catch (E) { Toast(E.message, true); }
      };
      Body.push(h("div", { class: "card" }, h("h2", {}, "🚫 Modération"),
        Ban?.active ? h("p", {}, `Banni (mis à jour le ${When(Ban.updated_at)}) : ${Ban.reason}${Ban.address ? ` · IP ${Ban.address}` : ""}`) : h("p", { class: "muted" }, "Ce joueur n'est pas banni."),
        h("div", { class: "row" }, h("label", {}, "Motif", Reason), Ban?.active ? null : h("label", {}, "Portée", Address),
          Ban?.active ? h("button", { class: "btn", type: "button", onclick: () => Act(false) }, "Débannir") : h("button", { class: "btn btn-ember", type: "button", onclick: () => Act(true) }, "Bannir")),
        h("p", { class: "muted" }, "Un bannissement par IP peut aussi bloquer les autres joueurs derrière la même box.")));
    }

    if (Can("rename")) {
      const Name = h("input", { maxlength: 32, value: W.username });
      Body.push(h("div", { class: "card" }, h("h2", {}, "✏️ Renommer"),
        h("div", { class: "row" }, h("label", {}, "Nouveau pseudo", Name), h("button", {
          class: "btn", type: "button", onclick: async () => {
            if (!confirm(`Renommer ${W.username} en ${Name.value} ?`)) return;
            try { await Api("POST", "/api/player/rename", { accountId: W.accountId, username: Name.value }); Toast("Pseudo changé."); Router(); } catch (E) { Toast(E.message, true); }
          },
        }, "Renommer"))));
    }
    Main.replaceChildren(...Body);
  },

  async invites(Main) {
    const D = await Api("GET", "/api/invites");
    const Uses = h("input", { type: "number", min: 1, max: 100, value: 1 });
    const Name = h("input", { maxlength: 60, placeholder: "Pour qui ? (facultatif)" });
    const Result = h("div");
    const Create = h("button", { class: "btn btn-gold", type: "button" }, "Créer");
    Create.addEventListener("click", async () => {
      try {
        const R = await Api("POST", "/api/invites", { uses: Number(Uses.value), name: Name.value });
        const Copy = h("button", { class: "btn btn-small", type: "button", onclick: () => navigator.clipboard?.writeText(R.code).then(() => Toast("Code copié.")) }, "Copier");
        Result.replaceChildren(h("p", {}, "Nouveau code : ", h("b", { class: "mono" }, R.code), " ", Copy));
        Pages.invites(Main).catch(() => {});
      } catch (E) { Toast(E.message, true); }
    });
    const Mode = h("select", {}, ["OPEN", "INVITECODE", "NONE"].map((Value) => h("option", { value: Value, selected: D.registration === Value }, { OPEN: "Ouverte à tous", INVITECODE: "Sur invitation", NONE: "Fermée" }[Value])));
    Main.replaceChildren(h("h1", {}, "📜 Invitations"),
      h("div", { class: "card" }, h("h2", {}, "Nouveau code"), h("div", { class: "row" }, h("label", {}, "Utilisations", Uses), h("label", {}, "Note", Name), Create), Result),
      Can("registration") ? h("div", { class: "card" }, h("h2", {}, "Inscription"), h("div", { class: "row" }, h("label", {}, "Mode", Mode), h("button", {
        class: "btn", type: "button", onclick: async () => { try { await Api("POST", "/api/registration", { mode: Mode.value }); Toast("Mode d'inscription changé."); } catch (E) { Toast(E.message, true); } },
      }, "Appliquer")), h("p", { class: "muted" }, "Le mode revient à celui de la configuration au prochain redémarrage du metagame.")) : null,
      h("div", { class: "card" }, h("h2", {}, "Codes existants"),
        Table(["Code", "Utilisations restantes"], D.codes.map((Code) => ({ cells: [h("span", { class: "mono" }, Code.invitecode ?? Code.code ?? "?"), Code.infiniteUses ? "illimité" : Num(Code.usesRemaining)] })))));
  },

  async logs(Main) {
    const Services = await Api("GET", "/api/services");
    const Service = h("select", {}, Services.map((Unit) => h("option", { value: Unit }, Unit.replace(/^dauntless-/, ""))));
    const Filter = h("input", { maxlength: 100, placeholder: "Filtrer (texte)" });
    const Lines = h("select", {}, [100, 200, 500, 1000].map((Value) => h("option", { value: Value, selected: Value === 200 }, `${Value} lignes`)));
    const Out = h("div", { class: "logs mono" }, "…");
    const Load = async () => {
      const R = await Api("GET", `/api/logs?service=${encodeURIComponent(Service.value)}&lines=${Lines.value}&q=${encodeURIComponent(Filter.value)}`);
      Out.textContent = R.lines.join("\n") || "(aucune ligne)";
      Out.scrollTop = Out.scrollHeight;
    };
    const Button = h("button", { class: "btn", type: "button", onclick: () => Load().catch((E) => Toast(E.message, true)) }, "Afficher");
    Main.replaceChildren(h("h1", {}, "📖 Journaux"), h("div", { class: "card" }, h("div", { class: "row" }, h("label", {}, "Service", Service), h("label", {}, "Filtre", Filter), h("label", {}, "Taille", Lines), Button), Out));
    await Load();
  },

  async audit(Main) {
    const Rows = await Api("GET", "/api/audit");
    const Labels = { login: "connexion", login_failed: "connexion refusée", currency_give: "don", currency_take: "retrait", ban: "bannissement", unban: "débannissement", rename: "renommage", invite_create: "invitation", registration: "inscription", team_add: "compte ajouté", team_role: "rôle changé", team_remove: "compte supprimé", password_change: "mot de passe changé" };
    const Detail = (Row) => {
      const { at, actor, action, ...Rest } = Row;
      return Object.entries(Rest).map(([Key, Value]) => `${Key}: ${Value}`).join(" · ");
    };
    Main.replaceChildren(h("h1", {}, "🕯️ Historique"), h("div", { class: "card" },
      Table(["Quand", "Qui", "Quoi", "Détails"], Rows.map((Row) => ({ cells: [When(Row.at), Row.actor, Labels[Row.action] ?? Row.action, h("span", { class: "muted" }, Detail(Row))] })))));
  },

  async team(Main) {
    const Users = await Api("GET", "/api/team");
    const Name = h("input", { maxlength: 32, placeholder: "Nom" });
    const Role = h("select", {}, h("option", { value: "moderator" }, "Modérateur"), h("option", { value: "admin" }, "Admin"));
    const Password = h("input", { type: "password", maxlength: 200, placeholder: "10 caractères minimum", autocomplete: "new-password" });
    const Add = h("button", { class: "btn btn-gold", type: "button", onclick: async () => {
      try { await Api("POST", "/api/team", { name: Name.value, role: Role.value, password: Password.value }); Toast("Compte créé."); Pages.team(Main); } catch (E) { Toast(E.message, true); }
    } }, "Ajouter");
    const Rows = Users.map((User) => ({
      cells: [User.name, User.role === "admin" ? h("span", { class: "pill warn" }, "admin") : h("span", { class: "pill" }, "modérateur"), When(User.createdAt),
        User.name === State.me.name ? h("span", { class: "muted" }, "toi") : h("span", {},
          h("button", { class: "btn btn-small btn-ghost", type: "button", onclick: async () => {
            try { await Api("POST", "/api/team/role", { name: User.name, role: User.role === "admin" ? "moderator" : "admin" }); Pages.team(Main); } catch (E) { Toast(E.message, true); }
          } }, User.role === "admin" ? "→ modérateur" : "→ admin"), " ",
          h("button", { class: "btn btn-small btn-ember", type: "button", onclick: async () => {
            if (!confirm(`Supprimer le compte ${User.name} ?`)) return;
            try { await Api("POST", "/api/team/remove", { name: User.name }); Pages.team(Main); } catch (E) { Toast(E.message, true); }
          } }, "Supprimer"))],
    }));
    Main.replaceChildren(h("h1", {}, "🛡️ Équipe"),
      h("div", { class: "card" }, h("h2", {}, "Nouveau compte du panel"), h("div", { class: "row" }, h("label", {}, "Nom", Name), h("label", {}, "Rôle", Role), h("label", {}, "Mot de passe", Password), Add),
        h("p", { class: "muted" }, "Modérateur : voit tout, peut bannir et créer des invitations. Admin : tout, y compris les monnaies, les journaux et l'équipe.")),
      h("div", { class: "card" }, Table(["Nom", "Rôle", "Créé le", ""], Rows)));
  },

  async account(Main) {
    const Current = h("input", { type: "password", autocomplete: "current-password" });
    const Next = h("input", { type: "password", autocomplete: "new-password" });
    const Again = h("input", { type: "password", autocomplete: "new-password" });
    Main.replaceChildren(h("h1", {}, "🔑 Mon compte"), h("div", { class: "card", style: "max-width:460px" },
      h("p", {}, `Connecté en tant que ${State.me.name} (${State.me.role === "admin" ? "admin" : "modérateur"}).`),
      h("label", {}, "Mot de passe actuel", Current), h("label", {}, "Nouveau mot de passe", Next), h("label", {}, "Confirmation", Again),
      h("button", { class: "btn btn-gold", type: "button", onclick: async () => {
        if (Next.value !== Again.value) return Toast("Les deux mots de passe ne correspondent pas.", true);
        try { await Api("POST", "/api/password", { current: Current.value, password: Next.value }); Toast("Mot de passe changé."); Current.value = Next.value = Again.value = ""; } catch (E) { Toast(E.message, true); }
      } }, "Changer")));
  },
};

function OpenPlayer(Id) {
  location.hash = `#player/${encodeURIComponent(Id)}`;
}

async function Router() {
  if (!State.me) return;
  clearInterval(State.timer);
  const [Page, Arg] = (location.hash.slice(1) || "dashboard").split("/");
  const Name = Pages[Page] ? Page : "dashboard";
  document.querySelectorAll("#nav a").forEach((Link) => Link.classList.toggle("active", Link.dataset.page === (Name === "player" ? "players" : Name)));
  $("nav").classList.remove("open");
  const Main = $("main");
  try {
    await Pages[Name](Main, Arg ? decodeURIComponent(Arg) : undefined);
    if (Name === "dashboard" || Name === "hunts") State.timer = setInterval(() => Pages[Name](Main).catch(() => {}), 10000);
  } catch (E) {
    Main.replaceChildren(h("div", { class: "card" }, h("p", { class: "error" }, E.message)));
  }
}

function ShowLogin() {
  State.me = null;
  clearInterval(State.timer);
  $("shell").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("login-name").focus();
}

function ShowShell() {
  $("login").classList.add("hidden");
  $("shell").classList.remove("hidden");
  $("me").textContent = `${State.me.name} · ${State.me.role === "admin" ? "admin" : "modérateur"}`;
  document.querySelectorAll("#nav a[data-can]").forEach((Link) => Link.classList.toggle("hidden", !Can(Link.dataset.can)));
  Router();
}

window.addEventListener("hashchange", Router);
document.addEventListener("DOMContentLoaded", async () => {
  $("login-form").addEventListener("submit", async (Event) => {
    Event.preventDefault();
    $("login-error").textContent = "";
    try {
      await Api("POST", "/api/login", { name: $("login-name").value, password: $("login-password").value });
      $("login-password").value = "";
      State.me = await Api("GET", "/api/me");
      ShowShell();
    } catch (E) { $("login-error").textContent = E.message; }
  });
  $("logout").addEventListener("click", async () => { await Api("POST", "/api/logout", {}).catch(() => {}); ShowLogin(); });
  $("menu-toggle").addEventListener("click", () => $("nav").classList.toggle("open"));
  try { State.me = await Api("GET", "/api/me"); ShowShell(); } catch { ShowLogin(); }
});
