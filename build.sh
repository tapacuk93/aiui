#!/bin/zsh
# Builds build/aiui.app: Swift/AppKit shell + CEF (Blink) + helper apps.
#   ./build.sh          build
#   ./build.sh run      build and launch (serving web/ live from the source tree)
#   ./build.sh clean    remove build/ (keeps vendor/)
set -euo pipefail
cd "${0:A:h}"

ROOT=$PWD
CEF=$ROOT/vendor/cef
BUILD=$ROOT/build
APP=$BUILD/aiui.app
MINOS=13.0
CEF_FILE='cef_binary_156.0.15+gcf671c0+chromium-156.0.8078.80_macosarm64_minimal.tar.bz2'

[[ ${1:-} == clean ]] && { rm -rf "$BUILD"; exit 0; }

# 1. CEF binary distribution
if [[ ! -d $CEF/Release ]]; then
  echo "• downloading CEF"
  mkdir -p vendor
  url="https://cef-builds.spotifycdn.com/${CEF_FILE//+/%2B}"
  curl -fL "$url" -o vendor/cef.tar.bz2
  tar xjf vendor/cef.tar.bz2 -C vendor && rm vendor/cef.tar.bz2
  rm -rf "$CEF" && mv vendor/cef_binary_* "$CEF"
fi

CXXFLAGS=(-std=c++20 -O2 -arch arm64 -mmacosx-version-min=$MINOS
  -fno-exceptions -fno-rtti -fno-threadsafe-statics -fobjc-call-cxx-cdtors
  -fvisibility=hidden -fvisibility-inlines-hidden -fno-strict-aliasing
  -DNDEBUG -D__STDC_CONSTANT_MACROS -D__STDC_FORMAT_MACROS
  -Wno-deprecated-declarations -Wno-undefined-var-template -I"$CEF")

# 2. libcef_dll_wrapper.a (once)
WRAP=$BUILD/libcef_dll_wrapper.a
if [[ ! -f $WRAP ]]; then
  echo "• building libcef_dll_wrapper"
  mkdir -p "$BUILD/wrapper"
  srcs=($(cd "$CEF" && find libcef_dll \( -name '*.cc' -o -name '*.mm' \) ! -name 'cef_scoped_sandbox_context_mac.mm'))
  export CEF BUILD CXXFLAGS_STR="${CXXFLAGS[*]}"
  printf '%s\n' "${srcs[@]}" | xargs -P "$(sysctl -n hw.ncpu)" -n 1 zsh -c '
    src=$1; obj="$BUILD/wrapper/${src//\//_}.o"
    lang=(); [[ $src == *.mm ]] && lang=(-x objective-c++)
    flags=(${=CXXFLAGS_STR})
    clang++ $flags -DWRAPPING_CEF_SHARED $lang -c "$CEF/$src" -o "$obj"' _
  libtool -static -o "$WRAP" "$BUILD"/wrapper/*.o 2>/dev/null
fi

# 3. Native bridge + helper
echo "• compiling native bridge"
mkdir -p "$BUILD/obj"
clang++ "${CXXFLAGS[@]}" -x objective-c++ -fobjc-arc -c Sources/Native/AIUICef.mm -o "$BUILD/obj/AIUICef.o"
clang++ "${CXXFLAGS[@]}" -x objective-c++ -c Sources/Native/Helper.mm -o "$BUILD/obj/Helper.o"

FRAMEWORKS=(-framework AppKit -framework Cocoa -framework IOSurface)

# 4. Swift app
echo "• compiling Swift"
swiftc -O -swift-version 5 -target arm64-apple-macos$MINOS \
  -import-objc-header Sources/Native/AIUICef.h \
  Sources/App/*.swift "$BUILD/obj/AIUICef.o" "$WRAP" \
  -lc++ "${FRAMEWORKS[@]}" -Xlinker -ObjC \
  -o "$BUILD/aiui"

clang++ -arch arm64 -mmacosx-version-min=$MINOS "$BUILD/obj/Helper.o" "$WRAP" -lc++ "${FRAMEWORKS[@]}" -o "$BUILD/aiui-helper"

# 5. Bundle
echo "• assembling aiui.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$APP/Contents/Resources"
cp "$BUILD/aiui" "$APP/Contents/MacOS/aiui"
cp Resources/Info.plist "$APP/Contents/Info.plist"
cp -R web "$APP/Contents/Resources/web"
ditto "$CEF/Release/Chromium Embedded Framework.framework" "$APP/Contents/Frameworks/Chromium Embedded Framework.framework"

for pair in ":" " (GPU):.gpu" " (Renderer):.renderer" " (Plugin):.plugin" " (Alerts):.alerts"; do
  suffix_name=${pair%%:*}; suffix_id=${pair#*:}
  name="aiui Helper$suffix_name"
  h="$APP/Contents/Frameworks/$name.app/Contents"
  mkdir -p "$h/MacOS"
  cp "$BUILD/aiui-helper" "$h/MacOS/$name"
  sed -e "s/\${NAME}/$name/g" -e "s/\${SUFFIX}/$suffix_id/g" Resources/HelperInfo.plist > "$h/Info.plist"
done

# Ad-hoc signature (required on Apple silicon). Inside-out: framework, helpers, app.
codesign --force --sign - "$APP/Contents/Frameworks/Chromium Embedded Framework.framework" >/dev/null 2>&1
for h in "$APP"/Contents/Frameworks/*.app; do codesign --force --sign - "$h" >/dev/null 2>&1; done
codesign --force --sign - "$APP" >/dev/null 2>&1
echo "✓ $APP"

if [[ ${1:-} == run ]]; then
  AIUI_WEB="$ROOT/web" "$APP/Contents/MacOS/aiui"
fi
