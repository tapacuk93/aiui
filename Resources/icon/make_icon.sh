#!/bin/sh
# Renders AppIcon.svg to every macOS icon size, builds AppIcon.icns and the web favicon (web/icon.png).
# Usage: Resources/icon/make_icon.sh   (needs only Xcode's swiftc and iconutil)
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
swiftc -O make_icon.swift -o "$tmp/render"
set=$tmp/AppIcon.iconset
mkdir "$set"
for s in 16 32 128 256 512; do
    "$tmp/render" AppIcon.svg "$set/icon_${s}x${s}.png" $s
    "$tmp/render" AppIcon.svg "$set/icon_${s}x${s}@2x.png" $((s * 2))
done
iconutil -c icns "$set" -o AppIcon.icns
"$tmp/render" AppIcon.svg ../../web/icon.png 128
echo "AppIcon.icns and web/icon.png updated"
