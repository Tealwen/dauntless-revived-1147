#!/bin/sh
set -eu

# 1.4.4: the pinned exe, with dxgi.dll (loader) and the 1.4.4 server DLL from UndauntedLauncher/assets.
PIN_EXE=d3d41e614908d2befd518b27046d9822d6130ef12ba3504babbdb786bef9cff4
PIN_DXGI=9a431d7b6fd20c43fa92bebd91c3bc023ec7a3fcbc52871c41f4df293d4b0d1f
PIN_SERVER=a090e8b25044647ce409b313525501da578d632d3fcb9eb351f020ca94fa64fb
# 1.14.7 (CL 647472): the pinned exe, with winmm.dll (loader) and the 1.14.7 server DLL from
# deploy/game-1147, checked against deploy/game-1147/SHA256SUMS. A dxgi.dll proxy crashes 1.14.7 at start-up.
PIN_EXE_1147=f3f95fbf22709ef077a11632ed95d675b7209b7e0172d9ecb9ba7d02a1fbb66b

usage() {
  echo "usage: $0 --game-dir <folder containing Archon> [--repo <dauntless-revived checkout>] [--game-version 1.4.4|1.14.7]" >&2
  exit 2
}

game=
version=1.4.4
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
while [ "$#" -gt 0 ]; do
  case "$1" in
    --game-dir) [ "$#" -ge 2 ] || usage; game=$2; shift 2 ;;
    --repo) [ "$#" -ge 2 ] || usage; repo=$2; shift 2 ;;
    --game-version) [ "$#" -ge 2 ] || usage; version=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$game" ] || usage
case "$version" in 1.4.4|1.14.7) ;; *) usage ;; esac

win64="$game/Archon/Binaries/Win64"
exe="$win64/Dauntless-Win64-Shipping.exe"
[ -f "$exe" ] || { echo "game executable not found: $exe" >&2; exit 1; }

hash_file() {
  sha256sum "$1" | awk '{print $1}'
}

install_pinned() { # <source file> <expected sha256> <target file>
  source=$1
  expected=$2
  target=$3
  [ -f "$source" ] || { echo "missing pinned asset: $source" >&2; exit 1; }
  [ "$(hash_file "$source")" = "$expected" ] || { echo "repo asset failed pin: $source" >&2; exit 1; }
  if [ ! -f "$target" ] || [ "$(hash_file "$target")" != "$expected" ]; then
    tmp="$target.dr-new"
    cp "$source" "$tmp"
    [ "$(hash_file "$tmp")" = "$expected" ] || { rm -f "$tmp"; echo "copy failed hash check: $target" >&2; exit 1; }
    mv "$tmp" "$target"
  fi
}

if [ "$version" = 1.4.4 ]; then
  [ "$(hash_file "$exe")" = "$PIN_EXE" ] || {
    echo "refusing game build: Dauntless-Win64-Shipping.exe is not pinned 1.4.4" >&2
    exit 1
  }
  for spec in "dxgi.dll:$PIN_DXGI" "UndauntedInternalServer.dll:$PIN_SERVER"; do
    file=${spec%%:*}
    install_pinned "$repo/UndauntedLauncher/assets/$file" "${spec#*:}" "$win64/$file"
  done
else
  [ "$(hash_file "$exe")" = "$PIN_EXE_1147" ] || {
    echo "refusing game build: Dauntless-Win64-Shipping.exe is not pinned 1.14.7" >&2
    exit 1
  }
  sums="$repo/deploy/game-1147/SHA256SUMS"
  [ -f "$sums" ] || { echo "missing $sums" >&2; exit 1; }
  for file in winmm.dll UndauntedInternalServer.dll; do
    expected=$(awk -v f="$file" '$2 == f { print $1 }' "$sums")
    [ -n "$expected" ] || { echo "no pin for $file in $sums" >&2; exit 1; }
    install_pinned "$repo/deploy/game-1147/$file" "$expected" "$win64/$file"
  done
  # A 1.4.4 loader left in the folder would load first and crash the 1.14.7 exe
  if [ -f "$win64/dxgi.dll" ]; then
    mv "$win64/dxgi.dll" "$win64/dxgi.dll.dr-1.4.4"
    echo "moved a 1.4.4 dxgi.dll out of the way: $win64/dxgi.dll.dr-1.4.4"
  fi
fi

echo "game $version ready for Wine server launch: $game"
