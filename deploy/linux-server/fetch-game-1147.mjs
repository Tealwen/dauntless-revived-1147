#!/usr/bin/env node
// Downloads the Dauntless 1.14.7 game tree for a Linux server from a web folder laid out as
// <base>/<build>/<path> (the same folder the PhynariaMC launcher downloads from), checking every
// file against UndauntedContent/data/dauntless-1.14.7.json (size and SHA-256). Files already present
// with the right size are kept; a file whose hash is wrong is fetched again. The overlay DLLs are
// not fetched: prepare-game.sh installs them from deploy/game-1147.
//
// usage: node deploy/linux-server/fetch-game-1147.mjs --base <https URL> --out <game folder> [--verify]
//   --verify  also re-hash the files already present (slow: 16.5 GB)
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(here, "..", "..", "UndauntedContent", "data", "dauntless-1.14.7.json"), "utf8"));

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const base = (arg("--base") ?? "").replace(/\/+$/, "");
const out = arg("--out");
const verify = process.argv.includes("--verify");
if (!/^https?:\/\//.test(base) || !out) {
  console.error("usage: node fetch-game-1147.mjs --base <https URL> --out <game folder> [--verify]");
  process.exit(2);
}

function safe(rel) {
  return !rel.includes("\\") && !rel.includes(":") && rel.split("/").every((p) => p && p !== "." && p !== "..");
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function fetchOne(entry) {
  const target = path.join(out, ...entry.path.split("/"));
  if (existsSync(target) && statSync(target).size === entry.size && (!verify || (await sha256(target)) === entry.sha256)) return false;
  mkdirSync(path.dirname(target), { recursive: true });
  const url = `${base}/${manifest.build}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
  for (let attempt = 1; ; attempt++) {
    const part = target + ".part";
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const hash = createHash("sha256");
      let size = 0;
      const tap = new Transform({ transform(chunk, _e, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
      await pipeline(Readable.fromWeb(response.body), tap, createWriteStream(part));
      if (size !== entry.size || hash.digest("hex") !== entry.sha256) throw new Error("size or hash mismatch");
      renameSync(part, target);
      return true;
    } catch (error) {
      try { unlinkSync(part); } catch {}
      if (attempt >= 5) throw new Error(`${entry.path}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

for (const entry of manifest.files) if (!safe(entry.path)) throw new Error("unsafe manifest path " + entry.path);
const queue = [...manifest.files].sort((a, b) => b.size - a.size);
let done = 0, fetched = 0;
const total = queue.length;
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let entry = queue.shift(); entry; entry = queue.shift()) {
    if (await fetchOne(entry)) fetched++;
    done++;
    process.stdout.write(`\r${done}/${total} files (${fetched} downloaded)   `);
  }
}));
process.stdout.write(`\ngame ${manifest.build} ready in ${out}\n`);
