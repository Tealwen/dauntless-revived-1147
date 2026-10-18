#!/usr/bin/env node
// Panel accounts from the command line, for the first admin or a lost password:
//   node panel-user.mjs add <name> <admin|moderator>
//   node panel-user.mjs password <name>
//   node panel-user.mjs list
// The password is typed twice, hidden. PANEL_DATA_DIR picks the data folder (default /var/lib/dauntless-revived/panel).
import path from "node:path";
import { UserStore } from "../src/auth.mjs";

const store = new UserStore(path.join(path.resolve(process.env.PANEL_DATA_DIR ?? "/var/lib/dauntless-revived/panel"), "users.json"));
const [Command, Name, Role] = process.argv.slice(2);

function AskHidden(Prompt) {
  return new Promise((Resolve, Reject) => {
    const Input = process.stdin;
    if (!Input.isTTY) {
      // Piped: one line
      let Data = "";
      Input.setEncoding("utf8");
      Input.on("data", (Chunk) => { Data += Chunk; });
      Input.on("end", () => Resolve(Data.split(/\r?\n/)[0]));
      return;
    }
    process.stdout.write(Prompt);
    Input.setRawMode(true);
    Input.resume();
    Input.setEncoding("utf8");
    let Value = "";
    const OnData = (Chunk) => {
      for (const Char of Chunk) {
        if (Char === "\r" || Char === "\n") {
          Input.setRawMode(false); Input.pause(); Input.off("data", OnData); process.stdout.write("\n"); Resolve(Value); return;
        }
        if (Char === "\u0003") { Input.setRawMode(false); Reject(new Error("annulé")); return; }
        if (Char === "\u007f" || Char === "\b") Value = Value.slice(0, -1); else Value += Char;
      }
    };
    Input.on("data", OnData);
  });
}

async function NewPassword() {
  const First = await AskHidden("Mot de passe (10 caractères minimum) : ");
  if (!process.stdin.isTTY) return First;
  const Second = await AskHidden("Confirme le mot de passe : ");
  if (First !== Second) throw new Error("les deux mots de passe ne correspondent pas");
  return First;
}

try {
  if (Command === "list") {
    for (const User of store.list()) console.log(`${User.name}\t${User.role}\t${User.createdAt}`);
  } else if (Command === "add" && Name && Role) {
    store.add(Name, Role, await NewPassword());
    console.log(`compte ${Name} (${Role}) créé`);
  } else if (Command === "password" && Name) {
    store.setPassword(Name, await NewPassword());
    console.log(`mot de passe de ${Name} changé`);
  } else {
    console.error("usage: panel-user.mjs add <nom> <admin|moderator> | password <nom> | list");
    process.exit(2);
  }
} catch (error) {
  console.error(`erreur : ${error.message}`);
  process.exit(1);
}
