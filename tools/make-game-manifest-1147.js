// Builds the 1.14.7 game manifest from an installed Dauntless 1.14.7 folder (the one holding Archon/).
//
// Same shape as UndauntedContent/data/dauntless-1.4.4.json: { build, totalBytes, files: [{path, size, sha256}] },
// paths relative to the game root with forward slashes, sorted. A launcher that downloads the game
// (from a CDN such as Cloudflare R2) compiles in a copy and refuses any file whose path, size or hash
// is not in it.
//
// Two lists:
//   files    the game itself. Saved/ folders (logs, user settings), our own DLLs and *.log are left out.
//   overlay  the Dauntless Revived files a client needs next to the exe: winmm.dll (UndauntedProxy) and
//            the 1.14.7 UndauntedInternalServer.dll (deploy/game-1147, also used by the Linux servers).
//
// Refuses a folder whose exe or Version.txt is not the pinned 1.14.7 build.
//
// Usage (from the repository root):
//   node tools/make-game-manifest-1147.js --game-dir <folder holding Archon> [--out <file>]
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
const EXPECTED_BUILD = "dauntless_rel-1.14.7_Shipping_2024-04-01_14-59-21_647472";
const EXE_PATH = "Archon/Binaries/Win64/Dauntless-Win64-Shipping.exe";
const EXE_SHA256 = "f3f95fbf22709ef077a11632ed95d675b7209b7e0172d9ecb9ba7d02a1fbb66b";
const OVERLAY = [
    { path: "Archon/Binaries/Win64/winmm.dll", source: path.join(root, "deploy", "game-1147", "winmm.dll") },
    { path: "Archon/Binaries/Win64/UndauntedInternalServer.dll", source: path.join(root, "deploy", "game-1147", "UndauntedInternalServer.dll") }
];
const DEFAULT_OUT = path.join(root, "UndauntedContent", "data", "dauntless-1.14.7.json");

function Arg(name){
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

// Same rule as IsSafeManifestPath in UndauntedContent/src/manifest.ts
function IsSafePath(p){
    if(p.length === 0 || p.length > 240 || p.startsWith("/") || p.includes("\\") || p.includes(":")) return false;
    return p.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !/[<>"|?*\x00-\x1f]/.test(part)
        && !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part) && !/[. ]$/.test(part));
}

function Excluded(rel){
    const lower = rel.toLowerCase();
    return lower.split("/").includes("saved") || lower.endsWith(".log")
        || OVERLAY.some((o) => o.path.toLowerCase() === lower) || /\.dr-[^/]*$/.test(lower);
}

function Walk(dir, base, out){
    for(const entry of fs.readdirSync(dir, { withFileTypes: true })){
        const full = path.join(dir, entry.name);
        const rel = path.relative(base, full).split(path.sep).join("/");
        if(entry.isDirectory()) Walk(full, base, out);
        else if(entry.isFile() && !Excluded(rel)) out.push(rel);
    }
}

function Sha256(file){
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    try{
        for(;;){
            const n = fs.readSync(fd, buffer, 0, buffer.length, null);
            if(n === 0) break;
            hash.update(buffer.subarray(0, n));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest("hex");
}

const game = Arg("--game-dir");
if(!game) throw new Error("usage: node tools/make-game-manifest-1147.js --game-dir <folder holding Archon> [--out <file>]");
const out = Arg("--out") ?? DEFAULT_OUT;

const version = fs.readFileSync(path.join(game, "Version.txt"), "utf8").trim();
if(!version.startsWith(EXPECTED_BUILD)) throw new Error(`Version.txt is ${version}, not ${EXPECTED_BUILD}`);
if(Sha256(path.join(game, EXE_PATH)) !== EXE_SHA256) throw new Error("the exe is not the pinned 1.14.7 build");

const paths = [];
Walk(game, game, paths);
paths.sort();
const lower = new Set();
for(const p of paths){
    if(!IsSafePath(p)) throw new Error(`unsafe path: ${p}`);
    if(lower.has(p.toLowerCase())) throw new Error(`paths differ only in case: ${p}`);
    lower.add(p.toLowerCase());
}

let totalBytes = 0;
const files = paths.map((p, i) => {
    const full = path.join(game, p);
    const size = fs.statSync(full).size;
    totalBytes += size;
    process.stderr.write(`\r${i + 1}/${paths.length} ${p.slice(-60).padEnd(60)}`);
    return { path: p, size, sha256: Sha256(full) };
});
process.stderr.write("\n");

const overlay = OVERLAY.map((o) => ({ path: o.path, size: fs.statSync(o.source).size, sha256: Sha256(o.source) }));
const manifest = { build: EXPECTED_BUILD, totalBytes, files, overlay };
const text = JSON.stringify(manifest, null, 2) + "\n";
fs.writeFileSync(out, text);
console.log(`${files.length} files, ${totalBytes} bytes, ${overlay.length} overlay files -> ${out}`);
console.log(`manifest sha256 ${crypto.createHash("sha256").update(text).digest("hex")}`);
