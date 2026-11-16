# AI UI OS: engineering plan

*Restored 2026-11-16 into the repo; decisions taken are in §7. Research and plan only. Nothing was installed, no disk, partition, boot or NVRAM setting was touched.
Date: 2026-11-03. Repo state read: `~/src/aiui` @ 906df15.*

**Goal.** AI UI ships as a real operating system that boots natively on Apple Silicon Macs from its own
partition, next to macOS. The AI UI Mac app installs and uninstalls it. Inside, the circles UI is the only
shell, full screen. The AI gets the same system access it has on the Mac: shell, files, network (⌘N opens
"connect to network"), power and an AICoin wallet. The wallet is connected by scanning a QR code with the
AICoin iOS wallet app.

**Verdict in one paragraph.** This is feasible without writing an OS. AI UI OS should be a
**Fedora Asahi Remix Minimal derivative**. It is built with the same KIWI descriptions Fedora Asahi uses, and
it is installed by a **branded fork of the Asahi installer** (MIT licence) that points at our own
`installer_data.json`. The installer already supports custom OS packages: a zip holding `esp/`, `boot.img`
and `root.img`, plus a JSON entry. The session runs a kiosk Wayland compositor with one client, Fedora's
Chromium in `--kiosk --app` mode, pointed at the **unchanged `Sources/App` Swift backend**. That backend is
compiled for Linux as a small local HTTP daemon. This keeps one codebase and avoids porting the
AppKit/ObjC CEF bridge. The Mac app can automate the preflight, the download, the partitioning step
(behind an admin password) and the uninstall. Apple's security model requires the user for one step: a
boot into One True Recovery (1TR) to enter the macOS password twice (`bputil`, `kmutil`). **This Mac (M1
MacBook Air) is one of the best-supported Asahi machines, but it does not have enough free space today**
(see §1.6).

---

## 0. This machine (read-only inspection)

| Item | Value |
|---|---|
| Model | MacBook Air (M1, 2020), `MacBookAir10,1` = Asahi device `j313ap`, 8 GB RAM, 8 cores |
| macOS | 27.0.1 (26A434); system firmware / OS loader 20457.1.29 |
| Disk | 251 GB internal: `disk0s1` iSC (524 MB), `disk0s2` APFS container (245.1 GB), `disk0s3` Recovery (5.4 GB) |
| APFS container | 198.2 GB in use, **46.9 GB not allocated** (`diskutil info disk3`) |
| FileVault | On. Activation Lock: enabled (no effect on dual boot) |

**Supported.** `j313ap` is in the installer's device table as a non-expert device with minimum macOS 11.0
([asahi-installer `src/main.py`](https://github.com/AsahiLinux/asahi-installer/blob/main/src/main.py), line 57:
`"j313ap": Device("11.0", False), # MacBook Air (M1, 2020)`).

Feature status for J313 from the [Asahi M1 feature table](https://asahilinux.org/docs/platform/feature-support/m1/).
Version numbers mean "upstream since Linux x.y"; `linux-asahi` means "in the Asahi kernel that Fedora Asahi ships".

| Feature | Status | Relevance for AI UI OS |
|---|---|---|
| GPU (OpenGL/Vulkan, accelerated) | linux-asahi | Chromium compositing and WebGL are accelerated |
| Display | 5.17 | ok |
| Wi-Fi | 6.1 | ok (⌘N network scene) |
| Bluetooth | 6.2 | optional |
| Keyboard backlight | 6.4 | ok |
| Sleep/suspend | linux-asahi | works, but sleep power draw is higher than macOS (to verify on this unit) |
| Speakers / headphone jack | linux-asahi (speakers use their own DSP patches for safety) | ok |
| Webcam | linux-asahi | ok |
| Battery | 7.1 | ok. **On macOS 27 firmware the kernel must be ≥ 7.0.12** (see below) |
| USB-C (USB2/3) | 7.0 | ok |
| Touch ID | TBA | **no.** Unlock with a password/PIN instead |
| Thunderbolt / DP Alt Mode | WIP | **no external display over USB-C** |

**macOS 27 caveats, important because this Mac already runs macOS 27:**
- macOS 27 started honouring an APFS "bootable" flag, so Asahi installs disappeared from the boot picker.
  The installer (≥ v0.8.3, current tag v0.9.2) sets the flag for new installs and has a repair action
  ("Fix macOS 27 boot picker compatibility").
  ([Progress report 7.1](https://asahilinux.org/2026/06/progress-report-7-1/);
  [Linuxiac, 2026-06-10](https://linuxiac.com/asahi-linux-users-told-to-avoid-macos-27-golden-gate-for-now/);
  `action_set_vol_bootable` in [`src/main.py`](https://github.com/AsahiLinux/asahi-installer/blob/main/src/main.py)).
- The macOS 27 SMC firmware changed a battery key from 4 bytes to 1. Older kernels misread it and can trigger
  emergency shutdowns. Kernel ≥ 7.0.12 handles both ABIs
  ([Progress report 7.1](https://asahilinux.org/2026/06/progress-report-7-1/);
  [AsahiLinux/linux PR #521](https://github.com/AsahiLinux/linux/pull/521)).
  **Our image must pin kernel ≥ 7.0.12.**

---

## 1. Booting on Apple Silicon: how Asahi does it

### 1.1 Boot chain
Apple firmware (iBoot1) → per-OS **stub macOS APFS container** (iBoot2 + firmware + RecoveryOS, with
**m1n1 stage 1** in the place of the macOS kernel) → m1n1 stage 2 → device tree + U-Boot → GRUB → Linux.
Stage 1 is installed from recoveryOS by `step2.sh` and is signed with a machine-specific key, so in
practice only the user can change it, from 1TR. Stage 2, U-Boot and everything later live on the OS's own
ESP and are updated by the distro (`update-m1n1`). Each installed OS has its own ESP. Apple's boot picker
treats each install as a separate OS. There are no persistent EFI variables, so only the default boot
entry exists. ([Boot process guide](https://asahilinux.org/docs/alt/boot-process-guide/),
[Open OS interop](https://asahilinux.org/docs/platform/open-os-interop/))

### 1.2 What the installer does
Bootstrap (`curl https://alx.sh | sh`, [script](https://alx.sh)):
- Refuses to run outside macOS.
- Requires macOS ≥ 13.5.
- Downloads the installer tarball and `installer_data.json`.
- Re-execs itself as root through `sudo` (password prompt) under `caffeinate`.
- Is configured entirely by environment variables: `VERSION_FLAG`, `INSTALLER_BASE`, `INSTALLER_DATA`,
  `INSTALLER_DATA_ALT`, `REPO_BASE`, `REPORT`, `REPORT_TAG`
  ([README](https://github.com/AsahiLinux/asahi-installer)).

Step 1, from macOS ([`src/main.py`](https://github.com/AsahiLinux/asahi-installer/blob/main/src/main.py),
[`src/osinstall.py`](https://github.com/AsahiLinux/asahi-installer/blob/main/src/osinstall.py)):
1. Checks the device and macOS version, and asks for the admin username and password (`getpass`).
2. **Resizes the macOS APFS container** with `diskutil apfs resizeContainer`. Without expert mode it
   leaves macOS at least **38 GB free** (`MIN_FREE_OS`) and refuses if it frees ≤ 10 GB (`MIN_INSTALL_FREE`).
3. Creates a **2.5 GB stub APFS container**. Its macOS boot components are streamed from an Apple IPSW
   picked from the OS entry's `supported_fw` (12.3, 13.5 or 14.8.3). The installed macOS firmware version
   doesn't matter.
4. Creates the partitions listed in the OS entry (`diskutil addPartition`). It formats the ESP as FAT32
   (`newfs_msdos`), `dd`s each `image` into its partition, copies the `esp/` tree, Apple's vendor firmware
   (`copy_firmware`) and the installer data (`copy_installer_data` → `<ESP>/asahi/`).
5. Sets the new OS as the default boot volume (`bless`) and tells the user to shut down.

Step 2, in **1TR** (`step2.sh`,
[source](https://github.com/AsahiLinux/asahi-installer/blob/main/src/step2/step2.sh)):
1. The user powers on **holding the power button** until "Entering startup options", then picks the new OS.
   Its paired recoveryOS runs `step2.sh`.
2. The script checks that it really is in 1TR. If not, it explains and shuts down.
3. `bputil -nc -v <VGID>` sets Permissive Security for **this OS only** (macOS keeps Full Security).
   Then `kmutil configure-boot -c boot.bin --raw --entry-point 2048 --lowest-virtual-address 0 -v <vol>`
   installs m1n1 stage 1.
4. **The user types the macOS username and password twice.** Nothing outside 1TR can do this by
   design: it is the "machine owner" authorisation
   ([Open OS interop](https://asahilinux.org/docs/platform/open-os-interop/)).
5. Reboot into Linux. First boot normally runs Fedora's `initial-setup`; we replace that with our own
   first-run scene.

### 1.3 Can it install a custom OS image? Yes: the `os_list` format
The installer reads an `os_list` from `installer_data.json`
([prod data](https://github.com/AsahiLinux/asahi-installer-data/blob/prod/data/installer_data.json)).
Each entry looks like this (the current Fedora 45 Minimal entry, abridged):

```json
{ "name": "Fedora Asahi Remix 45 Minimal", "default_os_name": "Fedora Linux",
  "boot_object": "m1n1.bin", "next_object": "m1n1/boot.bin",
  "package": "https://…/os/fedora-45-minimal-202611011600.zip", "icon": "fedora.icns",
  "supported_fw": ["12.3","12.3.1","13.5","14.8.3"],
  "partitions": [
    {"name":"EFI","type":"EFI","size":"524288000B","format":"fat","volume_id":"0x…",
     "copy_firmware":true,"copy_installer_data":true,"source":"esp"},
    {"name":"Boot","type":"Linux","size":"1073741824B","image":"boot.img"},
    {"name":"Root","type":"Linux","size":"4276092928B","expand":true,"image":"root.img"} ] }
```

- `package` is a zip with `esp/`, `boot.img`, `root.img` (image sizes must be multiples of 4 KiB) and an
  optional icon. A relative `package` resolves against `$REPO_BASE/os/`.
- `expand: true` grows Root to whatever size the user chooses.
- Required space is the sum of partition sizes; the *recommended* size is twice that for expandable images.
- Fedora's [`make-asahi-installer-package.sh`](https://pagure.io/fedora-asahi/kiwi-descriptions) converts a
  KIWI `oem` raw image into exactly this zip and the JSON snippet.

For AI UI OS we therefore:
1. Fork `asahi-installer` (MIT) with our name, logo (`LOGO=` at build) and `REPORT_TAG`.
2. Host our own installer tree and an `installer_data.json` with a single "AI UI OS" entry. The Asahi README
   explicitly encourages downstream distributions to host their own bootstrap, installer build and images.
   Asahi's lead developer has said downstreams are expected to "ship preconfigured images" rather than a
   customisable installer
   ([README](https://github.com/AsahiLinux/asahi-installer);
   [Reddit, Jan 2025](https://r.darklab.sh/r/AsahiLinux/comments/1i8rhad/asahi_arch_linux_arm_is_back)).

We do **not** get listed on alx.sh. That isn't needed.

### 1.4 Reversibility and uninstall
- macOS keeps Full Security. The Permissive policy is per-OS
  ([step2.sh](https://github.com/AsahiLinux/asahi-installer/blob/main/src/step2/step2.sh) text).
  Removing the stub container removes that OS and its policy.
- Uninstall, per the [partitioning cheatsheet](https://asahilinux.org/docs/sw/partitioning-cheatsheet/):
  1. Set macOS as the default startup disk first.
  2. `diskutil apfs deleteContainer <stub>`.
  3. `diskutil eraseVolume free free <ESP>`, and the same for `<Boot>` and `<Root>` (Fedora's layout has four
     partitions in total, counting the stub).
  4. `diskutil apfs resizeContainer disk0s2 0` grows macOS back over the freed space.
  - **Never touch `disk0s1` (iSC) or the final `Apple_APFS_Recovery` partition.** Deleting it can force a
    DFU restore.
  - If the resize fails with "Storage system verify or repair failed", the user must run
    `diskutil repairVolume` **from recoveryOS** (unlocking FileVault volumes first).
- Growing macOS back only works when the freed space sits directly after the macOS container. That holds
  for the standard layout, where Asahi partitions go between `disk0s2` and the Recovery partition.

### 1.5 What our Mac app can automate vs. what needs the user

| Step | Automate? | How |
|---|---|---|
| Preflight (model, macOS version, free space, FileVault, AC power, battery, Time Machine age, existing installs) | **Yes, no privileges** | `sysctl`, `ioreg` (target `j313ap`), `diskutil … -plist`, `fdesetup status`, `pmset -g batt`, `tmutil latestbackup` |
| Download and verify the OS package and installer | Yes | our CDN; check signature and hashes before any disk write |
| Resize APFS, create partitions, write images (step 1) | **Yes, after one admin password prompt** | run our installer fork as root (Authorization Services / a privileged helper via `SMAppService`), in a non-interactive JSON mode we add to the fork (§1.7). The installer also needs the admin user's password for `bputil -g`; it asks for it directly, so we pass it through and never store it |
| Set the boot volume and shut down | Yes, with the user's confirmation | installer's `bless` path |
| Step 2: boot into 1TR, pick the OS, type the password twice | **No, the user does this by hand** | the app shows an illustrated, timed guide first (and offers to print or phone it, since the Mac will be off) |
| Uninstall: set macOS default, delete our partitions, grow macOS | **Yes, with one admin prompt** | Startup Disk via `bless --mount / --setBoot` (may ask for credentials; fall back to opening the Startup Disk settings), then the `diskutil` commands from §1.4. Only partitions **proven to be ours** are deleted (§1.7) |
| APFS repair if the resize fails | No, the user does it | recoveryOS guide |
| m1n1 stage 1 upgrade (rare) | No, the user does it | re-run the installer's "Upgrade m1n1" action, which needs 1TR again |

### 1.6 Space on this Mac (blocking issue)
- 46.9 GB is unallocated. The installer keeps 38 GB free for macOS, so it can give a new OS only about
  8.9 GB, which is below its 10 GB floor. **The installer will refuse without expert mode.**
- What we need:
  - Image: about 1.5 GB EFI+Boot plus a Root of about 5–6 GB (Minimal Root today is 4.3 GB; with Chromium,
    the app, the claude CLI, the JS libraries pack and the native tools pack, estimate 6–7 GB).
  - Recommended size is twice the image (installer rule), plus the 2.5 GB stub and user data.
  - Target: **25 GB for AI UI OS.**
- So **the user must free about 17–25 GB in macOS first.** The app's preflight should say exactly how much.
- Expert mode can push below the 38 GB rule. Don't: macOS updates fail when free space gets tight.

### 1.7 Changes to our installer fork
- **`--json` mode.** No TTY prompts. Choices come from a JSON plan (target size, OS entry, credentials over
  stdin). Progress goes out as JSON lines that the Mac app renders.
- **Ownership marker.** Mark every partition we create:
  - partition names `… - AI UI OS`;
  - our own GPT partition GUIDs, recorded in `<ESP>/asahi/aiui-install.json` together with the stub VGID
    and the serial of the disk.
  Uninstall deletes only partitions listed there **and** sitting between `disk0s2` and the Recovery
  partition, and refuses anything else.
- **`--dry-run`.**
  - Runs every check and computes the partition plan (sizes, positions, stub VGID placeholder).
  - Downloads and verifies the package and the IPSW parts.
  - Prints the exact `diskutil` and `bless` commands it would run, and exits **before** the first write.
- Keep upstream's installer logic, including the macOS 27 fixes. Rebase on upstream tags regularly.

---

## 2. The OS image

### 2.1 Base
- **Fedora Asahi Remix 45 Minimal**, built from
  [`fedora-asahi/kiwi-descriptions`](https://pagure.io/fedora-asahi/kiwi-descriptions) (branch `f45`). It
  already uses:
  - `kernel-16k`;
  - `update-m1n1`, `dracut-asahi` and `asahi-fwupdate`;
  - GRUB with BLS;
  - an ext4 `/boot`;
  - a **btrfs root with `root` and `home` subvolumes**, mounted `compress=zstd:1`;
  - a 500 MB ESP
  (`platforms/minimal.xml`, `components/boot.xml` in that repo).
- Asahi audio (PipeWire with the asahi DSP config and `speakersafetyd`) and firmware handling come with the
  Asahi packages.
- Why not something else? Fedora Asahi Remix is Asahi's flagship distro: kernel and Mesa follow upstream
  Asahi fast, and the image build is reproducible (KIWI, also buildable in Koji). Other distros are
  explicitly second-class for the installer (Reddit link above).
- **Branding.** Call it "AI UI OS (based on Fedora Asahi Remix)". Don't present it as Fedora, and keep
  Fedora/Asahi credits on the about screen. Checking the Fedora remix trademark guidelines is one of the
  user's decisions below.

### 2.2 Session: kiosk, no desktop
```
greetd (autologin user `aiui`, initial_session) → sway in kiosk config (or cage) → aiui-launcher
   ├─ aiuid      (Swift backend, 127.0.0.1:<port>, systemd user service, Restart=on-failure)
   └─ chromium   --kiosk --app=http://127.0.0.1:<port>/#t=<token> --ozone-platform=wayland
                 --user-data-dir=~/.local/share/aiui/chromium --no-first-run --noerrdialogs
                 [--remote-debugging-address=127.0.0.1 --remote-debugging-port=$AIUI_DEBUG_PORT in dev]
```
- **Compositor.**
  - **cage** is the simplest single-app kiosk. It's packaged in Fedora
    ([package](https://packages.fedoraproject.org/pkgs/cage/cage/)) and has a documented systemd autologin
    setup ([cage wiki](https://github.com/cage-kiosk/cage/wiki/Starting-Cage-on-boot-with-systemd)).
  - Cage has no key bindings, though, and we need brightness, volume, keyboard backlight and lid/idle keys.
  - **Recommendation: sway with a 15-line kiosk config.** It runs one fullscreen `app_id`, uses
    `bindsym XF86MonBrightness*/XF86Audio*` → `brightnessctl`/`wpctl`, and `swayidle` for dim and suspend.
    Cage stays a fallback.
  - Either one runs inside a real logind session. A plain system service fails ("User has no sessions";
    see the cage wiki above).
- **No other apps or windows.** Chromium's own UI is hidden by `--kiosk --app`. AI-made `html` views are
  already iframes inside the page.
- **Offline first boot.** The AI needs the network, so the network scene must be **static** (no AI): a
  built-in page in `web/` that lists Wi-Fi networks and ethernet state. It opens automatically when there is
  no connectivity, and **⌘N** opens it anytime. The Mac app already maps ⌘N to "Connect to Network…" and
  ⌘⇧N to "New Session" (`Sources/Mac/AppDelegate.swift:161-165`). In OS mode, `web/app.js` handles the same
  keys, because there is no native menu bar. The Mac ⌘ key arrives as Super, which Chromium on Linux
  reports as `metaKey` (verify in M1).
- **Locking.** Sway with `swaylock`, or our own lock scene plus `logind` `LockSessions` handling. Use a
  password or PIN, since Touch ID is not supported.

### 2.3 System services the AI drives
| Need | Linux mechanism | Exposed as |
|---|---|---|
| Wi-Fi/ethernet | NetworkManager over D-Bus, or `nmcli -t dev wifi list` / `nmcli dev wifi connect <ssid> password …`; connectivity check and captive-portal detection; `Metered` property | `aiui.sys({op:'net', …})` and the shell |
| Power | `systemctl suspend/poweroff/reboot` (logind, allowed for the active session by polkit); battery from `upower`/sysfs | `op:'power'` |
| Brightness, keyboard backlight | sysfs backlight via `brightnessctl` (udev rule gives the `aiui` group write access) | `op:'display'` |
| Audio | PipeWire `wpctl` | `op:'audio'` |
| Notifications | none needed: no desktop exists, so they become in-app toasts | `op:'notify'` → push event |
| Clipboard | `wl-copy`/`wl-paste` (wl-clipboard) | `op:'clipboard'` |
| "Every system API" (the JXA equivalent) | `busctl`/`gdbus` (D-Bus), `/sys`, `/proc`, systemd, plus `wtype`/`ydotool` for input | prompt text for Linux |
| Packages | `aiui-pkgd` helper (§5) | `op:'install'` |

### 2.4 Users and privileges
- The session user is `aiui` (not root).
- The claude CLI runs as `aiui` with `bypassPermissions`, as on the Mac.
- Root actions go through **narrow polkit rules** (NetworkManager, logind, backlight, `aiui-pkgd`). Whether
  the AI also gets `sudo` (with or without a password) is a decision for the user, listed below.

### 2.5 Image build pipeline
- A **KIWI profile `AIUI`** in our fork of `kiwi-descriptions`: `<requires profile="Minimal"/>` plus our
  packages:
  - from Fedora: `sway`/`cage`, `greetd`, `chromium`, `NetworkManager-wifi`, `wl-clipboard`,
    `brightnessctl`, `ripgrep`, `git`, `jq`, the native tools pack (§5), and `kernel-16k ≥ 7.0.12`;
  - from our repo: `aiui`, `aiui-libs`, `aiui-native`;
  - from Anthropic: `claude-code`.
- Overlay files: greetd config, sway config, polkit rules, systemd units, `/etc/aiui/policy.json`.
- `initial-setup` is removed and replaced by our first-run scene.
- **Build host on this Mac.** KIWI needs an aarch64 Linux with loop devices and a privileged container
  (README: `podman run --privileged … fedora:aarch64`, then
  `kiwi-ng --type=oem --profile=… system build`;
  [kiwi-descriptions](https://pagure.io/fedora-asahi/kiwi-descriptions)). On this Mac:
  - a Fedora aarch64 VM under Apple's Virtualization framework (UTM in "Apple Virtualization" mode, or
    `limactl --vm-type=vz`); or
  - `podman machine` (applehv) running the privileged build container.

  The machine has 8 GB of RAM, so give the VM 4 GB and keep Xcode/CEF builds out of the same time window.
  The build is native arm64, with no qemu-user.
- **Outputs.**
  - The KIWI raw image goes into the VM (boots under `VZEFIBootLoader`).
  - `make-asahi-installer-package.sh` turns the same raw image into the Asahi package zip and the JSON entry.
  - Sign the zip (minisign/Ed25519) and publish the JSON plus the zip to our CDN.
- **CI.** Run a GitHub Actions arm64 Linux runner, or a self-hosted runner on a spare Apple Silicon machine
  in a VM. Builds are reproducible from tagged inputs. The release key never lives on CI: sign on a
  separate step.

### 2.6 Updates (detail in §5)
- Fedora packages come through our **approved snapshot repo** (gated) and are applied as offline dnf
  transactions at reboot, with btrfs snapshots before and after.
- The app, claude CLI, JS pack and native pack come through `aiui-updater` with A/B versioned directories.
- m1n1 stage 2 and U-Boot are updated by Fedora's `update-m1n1`. Stage 1 only changes through 1TR.

---

## 3. Porting the app

### 3.1 What is macOS-only today (from reading the code)

| Area | Where | Linux replacement |
|---|---|---|
| CEF bridge in ObjC++ (`AIUIApplication : NSApplication`, `NSView`, the ObjC protocol `AIUIHost`, the `aiui://` scheme, vendor root, `evalJS`) | `Sources/Native/*.mm/.h` (≈470 lines), `Sources/Mac/main.swift` | **Option B (recommended):** no CEF on Linux. `aiuid` serves `web/` and `/vendor/` and maps `/api/*` to the same `API.handleAPI(path, body, reply)` that `AIUIHost` uses today. `evalJS` becomes a push channel (`GET /api/events`, SSE). The page treats `NATIVE` as `location.protocol==='aiui:' \|\| host==='127.0.0.1'` |
| AppKit window, menus, address bar | `Sources/Mac/AppDelegate.swift`, `AddressBar.swift`, `main.swift` | Not needed (kiosk). Menu commands move to `web/` key bindings (⌘N network, ⌘⇧N new session, ⇧⌘D system) |
| `aiui.sys` ops: `jxa`/`applescript` (`osascript`), `open` (`NSWorkspace`), `clipboard` (`NSPasteboard`), `notify` (`osascript display notification`) | `Sources/Mac/MacHost.swift` | New `Sources/Linux/LinuxHost.swift`: `shell` → `/bin/bash -lc`. `jxa`/`applescript` return "not on Linux: use dbus/shell". `open` URL → in-app html view. `clipboard` → wl-clipboard. `notify` → push event. Add `net`/`power`/`display`/`audio`/`install` |
| Media pause via AppleScript | `Sources/Mac/Shell.swift:61` | `playerctl` (MPRIS) |
| Shell runner, `which`, process groups | `Sources/Mac/Shell.swift`, `Claude.swift`, `AgentCLI.swift` | Mostly Foundation `Process`, so it ports. Use `/bin/bash` (or ship zsh), `setpgid`/`kill(-pgid)` via Glibc |
| Keychain (`SecItem*`) for provider keys | `Sources/App/Engines.swift:72-110` (`#if os(macOS)` already) | `~/.local/share/aiui/secrets/*.json` with mode 0600 on an optional LUKS root, or libsecret if a keyring daemon is added. Swap behind a `SecretStore` protocol |
| `JSContext` (JavaScriptCore) for schedule formulas | `Sources/App/Usage.swift:74` | A ~100-line Swift expression evaluator (numbers, `n`, `every`, + - * / ^, `Math.*` functions). Use it on **all** platforms so formulas behave the same everywhere (also drops JSC on Mac) |
| CryptoKit | `Hints.swift`, `Cache.swift`, `Utilities.swift` | `swift-crypto` (`import Crypto`), API-compatible: `#if canImport(CryptoKit) … #else import Crypto` |
| `Security` | `Engines.swift` | as for Keychain above |
| iCloud container + `NSFileCoordinator` | `Sources/App/Storage.swift` | Local `~/.local/share/aiui` (`Storage.root(local:)` already falls back). Sync with the Mac is a decision (§7) |
| `FileManager…applicationSupportDirectory` | `API.swift:87,90`, `main.swift` | XDG path (`$XDG_DATA_HOME/aiui`). Foundation on Linux maps it, but set it explicitly |
| `UserDefaults` | engine, `budgetGB`, … | Works in swift-corelibs-foundation, but replace with a JSON settings file shared by `aiuid` and `aiui-updater` |
| AICoinKit (SwiftUI/StoreKit/Keychain) | `AICoin.swift` (`#if canImport(AICoinKit)`) | Not built on Linux. The OS uses the **QR authorisation flow** (§3.4), which is plain HTTP |
| Agent CLI detection is macOS-only | `Engines.swift:31` | Enable on Linux (`which claude`) |
| Prompts say "Mac", JXA, Cocoa | `Prompts.swift` | Add a Linux section: Fedora, dnf, D-Bus, nmcli, no GUI apps, the network/power ops. Also feeds `tools/export-prompts` |
| Hard-coded `aiui://app/vendor/...` in a page | `web/app.js:3221` | Make it origin-relative |

The `Sources/App` Swift is ~3,700 lines, almost all Foundation (`JSONSerialization`, `Process`, `URLSession`,
`Dispatch`, `NSRegularExpression`), all of which exist in swift-corelibs-foundation. Expect `#if` changes
in under a dozen places.

### 3.2 Shell options compared

| | A. Swift + CEF Linux | **B. Swift daemon + system Chromium (recommended)** | C. Rewrite backend (Go/Node) + Chromium |
|---|---|---|---|
| Codebase | one, but the native bridge needs a new C-ABI/C++ Linux port. Swift on Linux has no ObjC runtime, so the `@protocol AIUIHost`/blocks bridge must become C function pointers | **one**: `Sources/App` unchanged, plus `Sources/Linux` (host and HTTP server, ~600 lines) | two backends: drift, double the work |
| Browser | CEF 156 `linuxarm64` builds exist ([CEF builds](https://cef-builds.spotifycdn.com/index.html); the 156.0.15 `linuxarm64_minimal` tarball resolves). On 16K pages and Wayland it is **unverified** (CEF's Ozone/Wayland support is still maturing: [Phoronix](https://www.phoronix.com/news/Chromium-CEF-Wayland-Progress)) | Fedora's `chromium`, built and tested by Fedora/Asahi users on 16K kernels. Chromium's PartitionAlloc has supported 16K pages at runtime since ~M102 ([Chromium change](https://chromium.googlesource.com/chromium/src/+/a704c3a94179e6f3abb28f090d096ced72657d7c%5E%21); [Asahi broken-software list](https://leo3418.github.io/asahi-wiki-build/broken-software)) | same as B |
| Blink version vs Mac | same (CEF 156) | Fedora's Chromium tracks stable, so within ±1–2 milestones. QA (`web/qa.js`) is Blink-tuned, so fine | same as B |
| Security work | none new (custom scheme) | a localhost server needs **a per-boot token** (URL fragment → `HttpOnly` cookie), **Host/Origin checks** (DNS rebinding), `127.0.0.1` only, and refusing `/api/*` from AI iframes the same way the Mac does | same |
| Effort | high (C++ windowing on Wayland, sandbox, packaging libcef ~200 MB) | **low to medium** | high |

**Choice: B.** It's the least work and keeps one Swift codebase.
- The Mac keeps CEF.
- iOS keeps WKWebView.
- The OS gets a third host built on the same `API` class.

As a bonus, `aiuid` also runs headless, so the UI can be opened from any browser on a LAN, and CI can run
the backend.

### 3.3 Building Swift for Linux arm64
- **Dev loop:** the official **Static Linux SDK** (`swift build --swift-sdk aarch64-swift-linux-musl`).
  - Cross-compiles on this Mac with the open-source toolchain (not Xcode's) into one static binary.
  - Foundation works; FoundationNetworking uses the bundled curl.
  - No `dlopen` and no system libraries
  ([swift.org guide](https://www.swift.org/documentation/articles/static-linux-getting-started.html)).
- **Release:** the same static binary, packaged as an RPM, or a glibc build inside the Fedora build VM via
  `swiftly` ([swift.org Linux install](https://www.swift.org/install/linux/)).
- **Packaging:** `Package.swift` with targets `AIUICore` (`Sources/App`), `aiuid` (`Sources/Linux`) and the
  existing iOS/Mac builds unchanged. HTTP server: a minimal one on SwiftNIO, or Hummingbird.

### 3.4 AI engine and AICoin on Linux
- **claude CLI.**
  - Officially supports Linux ARM64, and Anthropic publishes a **signed dnf repo**
    (`downloads.claude.ai/claude-code/rpm/stable`), so it goes in the image as the `claude-code` RPM
    ([Claude Code setup docs](https://code.claude.com/docs/en/setup)).
  - Set `DISABLE_UPDATES=1` and update it through our channel, so the A/B and rollback rules of §5 apply.
- **16K pages are the main risk for the claude CLI.**
  - The bundled jemalloc-linked `ripgrep` aborts on 16K kernels. The documented fix is the system
    `ripgrep` plus `USE_BUILTIN_RIPGREP=0` (docs above, Alpine section).
  - The native binary (Bun/JSC) previously aborted on **64K** kernels, since fixed
    ([issue tracker](https://claudeissues.com/issue/25713-bug-native-binary-bun-jsc-aborts-on-arm64-linux-with-64k-page-size-kernels)).
    16K is unverified, so test it in M1 with `kernel-16k`.
  - Fallback if it fails: the app's own agent loop (API key or AICoin), which needs only `URLSession`.
- **Login.** `claude` login uses a browser flow. In the kiosk, open it in an html view or a Chromium
  popup, or use `ANTHROPIC_API_KEY`.
- **AICoin.**
  - The ledger already defines "authorising a service by showing it a code"
    (`~/src/aicoin/CONTRACT.md` §"Authorising a service by showing it a code"):
    1. `POST /wallet/api/authorize/new` → `{id, secret}`.
    2. The OS shows a QR code containing **only `id`**.
    3. The iOS wallet app (`QRScannerView`, `AuthorisationRequestView`) approves it with a live-signed
       `POST …/approve`.
    4. The OS polls `GET /wallet/api/authorize/<id>?secret=…` and collects the token once.
  - The token carries a `grant` that the owner can revoke in the wallet (`AuthorisedServicesView`).
  - On Linux this is ~100 lines of plain HTTP in `AICoin.swift` under `#if !canImport(AICoinKit)`, shared
    with whatever the Mac agent is building now.
  - Store the token in the 0600 secret store.
  - Open question: token lifetime and renewal (re-scan vs. a refresh endpoint).

---

## 4. Libraries and native tools: what the installer ships and how it updates

The same strategy covers **JS libraries** (`web/libraries.json`, `Sources/App/Libraries.swift`) and **native
tools** (the Linux arm64 counterparts of the native-tools catalog being added to the Mac app now: ffmpeg,
yt-dlp, pandoc, imagemagick, tesseract, jq, ripgrep, exiftool, poppler, …).

### 4.1 What exists today (JS)
- The catalog has **1,036 libraries, 234 MB in total**. Sorted by `priority`: the top 50 are 21 MB, top 100
  are 29 MB, top 200 are 54 MB and top 400 are 104 MB.
- Versions are pinned (jsDelivr URLs with `@version`), but **there are no integrity hashes in the catalog
  yet.**
- Installs are per device under a shared budget: 10 GB, at most 10% of free space above a 5 GB reserve,
  with LRU eviction (libraries used in the last hour are kept), plus a growing `catalog-extra.json`.

### 4.2 Three layers, one resolver
| Layer | Location | Contents | Updated by | Budget/LRU |
|---|---|---|---|---|
| **L0 seed** | `/usr/share/aiui/packs/{js,native}/<pack-ver>/`, read-only, in the image | the default set | OS image/RPM updates only | **excluded**, never evicted |
| **L1 managed** | `/var/lib/aiui/packs/{js,native}/{A,B}` + `current` symlink (owned by `aiui-updater`) | pack deltas published after the image | `aiui-updater` | excluded, only the previous slot is kept |
| **L2 on demand** | `~/.local/share/aiui/vendor` (JS, as today) and on-demand native packages | whatever the AI asks for beyond the packs | `aiuid` (JS) / `aiui-pkgd` (native) | **shared budget, LRU**, exactly the current rules |

- The resolver order is the exact `id@version` the screen asked for, looked up in L2, then L1 `current`,
  then L0.
- `Libraries.swift` already knows "installed" and "catalog". Add a read-only `bases: [URL]` list of
  pack roots it consults first and never evicts. The Mac app can use the same mechanism for a bundled pack.

### 4.3 What the installer ships
- **JS:** the **whole verified catalog** (~234 MB raw; JS compresses roughly 3–4× under btrfs
  `compress=zstd:1`, so about 60–80 MB on disk, estimated). Alternative: the top 400 (~104 MB raw). It's
  cheap next to a 25 GB partition, and it gives offline scenes everything. *Decision.*
- **Native default set (RPMs from Fedora, part of L0):** `ffmpeg-free`, `yt-dlp`, `pandoc`, `ImageMagick`,
  `tesseract` + `eng` (more languages on demand), `jq`, `ripgrep`, `perl-Image-ExifTool`,
  `poppler-utils`, `sqlite`, `python3`, `git`, `curl`. Fedora's ffmpeg is the patent-safe build; the full
  codec ffmpeg is in RPM Fusion. *Decision.* Estimate about 0.6–1 GB installed, to verify in M2.

### 4.4 Versioned, signed catalogs
- **One catalog document per kind**, `catalog-<kind>-<version>.json`, with a monotonic version
  (`2026.11.03.1`) and `min_app`. Every entry pins:
  - JS: `id, version, files[{name, url, bytes, sha256}]` (add `sha256` in `tools/libraries/resolve.py` and
    verify on every install, including today's Mac path);
  - native: `id, platforms.linux-arm64: {rpm: [name-EVR], sha256 per RPM}` and
    `platforms.darwin-arm64: {…}`, so the Mac catalog and the OS catalog are one file.
- **Pack manifest** `pack-<kind>-<version>.json`: the list of `id@version` in the default set, plus file
  hashes.
- **Signatures.** Both documents are signed with an Ed25519 key (minisign format; verified with
  `swift-crypto` in `aiuid`/`aiui-updater` and on the Mac with CryptoKit). RPMs are additionally GPG-checked
  by dnf.
- **Revocation.** The catalog carries `revoked: [id@version]`. A revoked version is removed from all layers
  that can be changed and hidden from L0 by the resolver.

### 4.5 Delta updates with rollback
**JS pack (file level, content addressed).**
1. `aiui-updater` fetches the new manifest and verifies its signature and monotonic version (rejecting
   downgrades unless it is a signed rollback).
2. It diffs against `current` and downloads only changed files (from our CDN, with jsDelivr as a fallback
   that is checked against the same `sha256`).
3. It builds the inactive slot (`B`) by **reflink-copying** unchanged files (btrfs `cp --reflink`, near zero
   cost) and adding the new ones. It checks every hash.
4. It runs the health check: a hidden `qa.js` lab page loads each changed library and asserts its `global`
   exists and no errors occur.
5. It atomically swaps `current` → `B` and keeps `A` as the rollback slot.
6. After the swap, if the scene repair/error rate for screens that use a changed library rises above
   baseline within 24 h (the journal already records repairs and errors), it **rolls back automatically**
   and reports `id@version` for revocation.

**Native.**
- Updates are **dnf transactions against our pinned snapshot repo `aiui-native`**: unmodified Fedora RPMs
  mirrored and frozen per catalog version, with zchunk metadata so metadata downloads are deltas.
- Run them through `aiui-pkgd` (root, polkit-gated, accepts only catalog ids):
  1. btrfs snapshot before the transaction;
  2. `dnf install/upgrade` of exact EVRs;
  3. smoke test (`<tool> --version`, plus a per-tool probe from the catalog);
  4. on failure, `dnf history undo`, or restore the snapshot.
- Package downloads are not delta-compressed (deltarpm is no longer relied on). Native tool RPMs are small
  next to the image.
- Tools not in Fedora get **user-space bundles** in L2 (`~/.local/share/aiui/native/<id>/<ver>/`,
  self-contained or static arm64 builds, hash-pinned, no root) under the same LRU rules.

### 4.6 Policy: when live downloads are allowed
- **User setting:** `downloads: always | unmetered-only (default) | never`.
- **Admin policy:** `/etc/aiui/policy.json`, root-owned. It can lock the setting, allow/deny catalog ids,
  pin a channel and cap the budget. The app shows locked settings as locked.
- **Network:** NetworkManager's `Metered` property (guessed from the connection, or set by the user in the
  network scene). On metered connections, no background installs, discovery or pack deltas, only explicit
  user-approved fetches.
- **Power:** no background downloads below 20% battery unless on AC.
- **Offline:** everything in L0, L1 and L2 works. Screens asking for a missing library get the catalog's
  "not installed, offline" answer, so the AI picks an installed alternative (it already sees the installed
  list).

### 4.7 Coexisting with the existing background install and eviction
- Background install keeps working as now, but **skips anything already in L0/L1** at the same version.
- **Budget** = today's shared formula (10 GB / 10% of free above 5 GB), now covering JS L2, the memory cache
  **and** on-demand native installs (L2 bundles and `aiui-pkgd` packages installed on demand).
- L0 and L1 never count and are never evicted.
- **LRU for native:** usage is recorded when `Shell.swift` sees the tool's executable in a command (it
  already parses commands for media). Eviction of on-demand RPMs is `dnf remove` (with `clean_requirements`)
  of the least recently used, never of default-set or dependency packages.
- **Promotion:** when a pack update moves a library from L2 into L1, the L2 copy is deleted if the hashes
  match, so nothing is stored twice.

### 4.8 The same strategy for the app, the claude CLI and the OS
- **App (`aiuid` + `web/`) and claude CLI.**
  - Versioned directories `/opt/aiui/<ver>/` and `/opt/claude/<ver>/` with an A/B `current` symlink,
    managed by `aiui-updater`. These are signed tarballs (or RPMs that install versioned directories), the
    same pattern Claude Code itself uses in `~/.local/share/claude/versions/`.
  - After a swap, systemd restarts `aiuid`. If `GET /api/health` doesn't report `ready` within 60 s, or the
    unit fails 3 times (`OnFailure=`), the symlink flips back and the version is marked bad.
  - Web-only updates (`web/`) use the same channel without a restart (Cmd-R).
- **OS (Fedora packages, kernel, firmware, m1n1 stage 2).**
  - Our **gated snapshot repo**: we sync Fedora Asahi updates, test them on the reference machine in CI, then
    publish.
  - Applied as an **offline dnf transaction at reboot** with snapper pre/post snapshots of `root`.
  - **Rollback:**
    - GRUB entries for the previous kernels (`installonly_limit=3`);
    - a "restore previous system" boot entry that boots the pre-update snapshot;
    - `/home` is a separate subvolume, so user data survives a rollback.
  - Kernel floor ≥ 7.0.12 is enforced (§0). Fedora major upgrades are released only after a full M5
    hardware pass.
- **v2:** evaluate **image-based A/B (bootc/ostree)**. It gives transactional `bootc upgrade` and
  `bootc rollback`. Unofficial signed Fedora Asahi bootc images exist
  ([fedora-asahi-remix-atomic-desktops](https://github.com/fedora-asahi-remix-atomic-desktops/images)),
  but there is no official one yet.

---

## 5. Phases and milestones (each one ends in something testable)

**M0: decisions and preflight in the Mac app (3–5 days)**
- Build: a read-only "Can this Mac run AI UI OS?" scene in the Mac app (§1.5 preflight).
- Test: on this Mac it reports j313 supported, macOS 27 notes, "free 17–25 GB first", FileVault on, last
  Time Machine backup.

**M1: Linux backend and UI in a VM on this Mac (2–3 weeks)**
- `Package.swift`; `AIUICore` builds for `aarch64-swift-linux-musl`.
- `Sources/Linux` (`aiuid` HTTP server, token/Host/Origin checks, SSE push, `LinuxHost` sys ops).
- Swift formula evaluator; `swift-crypto` shims; secret store.
- `web/` OS-mode tweaks (⌘N network scene, static offline page, relative vendor URLs); Linux prompt section.
- VM: Fedora 45 aarch64 under the Virtualization framework (UTM/lima `vz`). **Also boot `kernel-16k` in the
  VM to catch page-size bugs early (to verify that the VZ guest accepts 16K pages; otherwise this moves to
  M5).**
- Test: in the VM, sway kiosk → Chromium → circles UI; claude CLI turns work; `aiui.sys` shell/net/power
  work; `tools/smoke` passes against `aiuid`; the Mac app is unchanged (regression smoke).

**M2: the image (2 weeks)**
- KIWI profile `AIUI`, overlays, greetd/sway, polkit rules, units, our dnf repo (`aiui`, `aiui-libs`,
  `aiui-native`), `claude-code` from Anthropic's repo.
- Build in the Linux VM or `podman machine`.
- Test: the raw image boots in a VZ VM straight into AI UI; first-run scene → network → AI login/AICoin QR
  → circles. Installed size is measured, which fixes the partition sizes in the JSON entry.

**M3: packs and updater (2 weeks; folds in §4)**
- Catalog `sha256` + signing tool, JS L0/L1/L2 resolver in `Libraries.swift`, native catalog for
  linux-arm64, `aiui-pkgd`, `aiui-updater` (JS pack, native, app, claude), policy file, metered detection,
  snapper hooks, the gated OS snapshot repo.
- Tests in the VM:
  - (a) a pack delta downloads only changed files;
  - (b) a corrupted file is rejected by hash;
  - (c) a deliberately broken library version triggers automatic rollback;
  - (d) a deliberately crashing app version flips back within 60 s;
  - (e) an OS update followed by "restore previous system" boots the snapshot;
  - (f) metered and offline modes download nothing;
  - (g) LRU eviction of native on-demand tools under a small budget.

**M4: installer flow in the Mac app with dry-run (2–3 weeks)**
- Installer fork (`--json`, `--dry-run`, ownership markers, branding), our installer tree and
  `installer_data.json` on the CDN, the package zip from M2.
- Mac app: install wizard (preflight → plan → admin prompt → progress → illustrated 1TR guide) and
  uninstall wizard.
- Test:
  - `--dry-run` on this Mac shows the exact plan and commands and writes nothing (compare `diskutil list`
    before and after);
  - a **macOS VM** on this Mac (Virtualization framework) is used to rehearse step 1 for real (resize, stub,
    partitions) and the uninstall on a virtual disk; booting m1n1 in a VM is not expected to work;
  - the uninstall restores the VM disk's partition table to its original state.

**M5: real native install (1–2 weeks, user present)**
- Prerequisites: a verified **full Time Machine backup** (or a clone), at least 25 GB freed, AC power,
  macOS's own recovery tested, and the Asahi community status checked for the current macOS version.
- Optional safer first step: install to an **external USB SSD** (the installer has external-disk support,
  with `external_boot` entries partly behind expert mode; to verify). The internal disk is then not
  repartitioned, although the boot policy still lives on the internal iSC.
- Internal install via the Mac app, then 1TR step 2 with the user.
- Hardware pass: Wi-Fi join via ⌘N, ethernet over a USB adapter, suspend/resume with the lid, battery
  readings on macOS 27 firmware, brightness/volume/keyboard-backlight keys, speakers/headphones, webcam,
  claude CLI on 16K, scene QA on the GPU, AICoin QR pairing with the iOS wallet.
- Test: everything in the pass works; reboot into macOS works; the boot picker shows both; the **uninstall**
  brings `diskutil list` back to the M0 snapshot and the container to 245.1 GB.

**M6: hardening and release (ongoing)**
- Signing keys offline, update channels (stable/beta), opt-in install telemetry (`REPORT_TAG`).
- A compatibility watch: re-run M5 on each macOS point release before marking it safe in the app's
  preflight.
- Docs, support matrix (M1/M2 first; M3+ as Asahi support lands).

---

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Data loss** while resizing or partitioning | Require a recent Time Machine backup (checked); dry-run first; AC power plus `caffeinate`; upstream installer logic unchanged; ownership markers so uninstall never deletes foreign partitions; never touch iSC or Recovery; APFS-repair guide for recoveryOS |
| **Not enough space** (true today) | Preflight computes the exact amount needed and blocks; no expert mode |
| **macOS updates break boot** (macOS 27 already did; Apple doesn't support third-party OSes) | Installer ≥ 0.8.3 plus the repair action built into our app; kernel ≥ 7.0.12; the app's preflight keeps a compatibility list per macOS build and warns before the user updates macOS; uninstall always works from macOS |
| **Firmware/SMC ABI changes** (battery emergency shutdown) | Kernel floor; gated OS updates; test on the reference Mac before release |
| **16K page incompatibilities** (claude CLI/Bun, jemalloc tools, Chromium) | Fedora Chromium (16K-tested); `USE_BUILTIN_RIPGREP=0` + system rg; test `kernel-16k` early (M1/M5); fallback to the app's own agent loop (API key/AICoin) |
| **Unsupported hardware** (no Touch ID, no USB-C display, sleep drain) | Shown in preflight and docs; password/PIN unlock; external display not promised |
| **Bad update bricks the session** | A/B for the app, packs and CLI with health checks; snapper snapshots plus the previous kernel for the OS; static offline recovery scene; TTY login stays available (Ctrl-Alt-F2) for support |
| **Localhost API abuse** (a web page or another local process driving the shell) | 127.0.0.1 only, per-boot token, Host/Origin checks, no CORS, AI views stay sandboxed iframes; `aiui-pkgd` accepts only catalog ids |
| **Supply chain** (libraries/tools) | Hash-pinned catalogs, Ed25519-signed manifests, GPG-checked RPMs, revocation list, frozen snapshot repos |
| **Upstream drift** (Asahi installer, Fedora Asahi) | Fork kept minimal (flags plus branding), rebased on each upstream tag; CI builds against the pinned `f45` branch |
| **Licensing/trademarks** | Fedora remix trademark rules ("based on Fedora Asahi Remix", no Fedora logo as ours); codec choice (ffmpeg-free vs RPM Fusion) |
| **8 GB RAM on this Mac for the dev loop** | VM at 4 GB; build images while no CEF/Xcode build runs; respect `agent-gate` |

---

## 7. Decisions

**Taken 2026-11-16** (the user said "do": the recommended option of each, to be changed any time):

| # | Decision | Taken |
|---|---|---|
| 1 | Shell | **B**: Swift daemon + Fedora Chromium kiosk |
| 2 | Disk | **25 GB, internal** (native boot was the user's choice), only after a verified Time Machine backup; this Mac must first free space (25.7 GB unallocated on 2026-11-16, 63 GB needed) |
| 3 | Installer UX | **Fork with `--json` / `--dry-run`**, driven by the Mac app |
| 4 | Naming | **"AI UI OS, based on Fedora Asahi Remix"**, no Fedora logo |
| 5 | AI engine on first boot | all three offered; **claude CLI login default**, AICoin QR and API key next to it |
| 6 | AI privileges | **polkit-scoped actions** (network, power, packages, time, hostname); anything else asks for the password, as on the Mac |
| 7 | Encryption | **none by default** (Asahi default), LUKS offered in the installer |
| 8 | JS pack | **top 400** (~104 MB); the rest on demand under the policy |
| 9 | Native set / codecs | **§4.3 list, `ffmpeg-free`** |
| 10 | Updates | **automatic, staged, applied at reboot; stable channel; `unmetered-only`** |
| 11 | Mac ↔ OS data | **separate** for now; sync through the shared/users services later |
| 12 | Keys | **⌘N = Connect to Network, ⇧⌘N = New Session** (as on the Mac) |

The original questions:


1. **Shell architecture:** B (Swift daemon + Fedora Chromium kiosk), recommended, vs A (port the CEF bridge
   to Linux).
2. **Disk:** free about 17–25 GB on this Mac and choose the AI UI OS size (recommend 25 GB). Install to an
   external SSD first, or straight to internal after a backup?
3. **Installer UX:** fork plus a `--json` mode driven by the Mac app (recommended), or open Terminal with
   our branded `curl | sh`.
4. **Base and naming:** "AI UI OS, based on Fedora Asahi Remix 45", OK? Check Fedora's remix trademark terms.
5. **AI engine on first boot:** claude CLI login (subscription), AICoin QR, API key: which is the default,
   and which are offered?
6. **AI privilege level:** passwordless sudo for the AI (Mac parity), or polkit-scoped actions only?
7. **Disk encryption:** LUKS for the Linux root (password at boot; protects stored tokens and keys) or none
   (the Asahi default)?
8. **JS pack size:** the whole catalog (~234 MB raw) or the top 400 (~104 MB).
9. **Native default set and codecs:** the list in §4.3; `ffmpeg-free` (Fedora) vs full ffmpeg (RPM Fusion).
10. **Update policy:** automatic (staged, applied at reboot) vs ask; stable/beta channels; default download
    policy (`unmetered-only`).
11. **Data between Mac and OS:** keep AI memory separate, or sync it. iCloud isn't available on Linux, and
    macOS can't read btrfs, so syncing means our own sync service or a shared exFAT/FAT volume.
12. **⌘N in OS mode** = Connect to Network (as on the Mac now), and ⌘⇧N = New Session: confirm.

---

## Sources
- Asahi feature support (M1): https://asahilinux.org/docs/platform/feature-support/m1/
- Asahi installer repo (README, `src/main.py`, `src/osinstall.py`, `src/step2/step2.sh`): https://github.com/AsahiLinux/asahi-installer
- Bootstrap script: https://alx.sh
- Installer data (os_list): https://github.com/AsahiLinux/asahi-installer-data/blob/prod/data/installer_data.json
- Partitioning cheatsheet (uninstall/resize): https://asahilinux.org/docs/sw/partitioning-cheatsheet/
- Boot process guide: https://asahilinux.org/docs/alt/boot-process-guide/
- Open OS interop: https://asahilinux.org/docs/platform/open-os-interop/
- Progress report 7.1 (macOS 27 boot picker, SMC battery): https://asahilinux.org/2026/06/progress-report-7-1/
- Linuxiac on macOS 27: https://linuxiac.com/asahi-linux-users-told-to-avoid-macos-27-golden-gate-for-now/
- AsahiLinux/linux PR #521 (BCF0 key size): https://github.com/AsahiLinux/linux/pull/521
- Downstream policy remarks: https://r.darklab.sh/r/AsahiLinux/comments/1i8rhad/asahi_arch_linux_arm_is_back
- Fedora Asahi KIWI descriptions: https://pagure.io/fedora-asahi/kiwi-descriptions
- cage (Fedora package, systemd wiki): https://packages.fedoraproject.org/pkgs/cage/cage/ , https://github.com/cage-kiosk/cage/wiki/Starting-Cage-on-boot-with-systemd
- Chromium 16K PartitionAlloc: https://chromium.googlesource.com/chromium/src/+/a704c3a94179e6f3abb28f090d096ced72657d7c%5E%21
- Asahi broken software list: https://leo3418.github.io/asahi-wiki-build/broken-software
- CEF builds (linuxarm64): https://cef-builds.spotifycdn.com/index.html ; CEF Wayland status: https://www.phoronix.com/news/Chromium-CEF-Wayland-Progress
- Claude Code setup (Linux ARM64, dnf repo, USE_BUILTIN_RIPGREP, DISABLE_UPDATES): https://code.claude.com/docs/en/setup
- Claude Code 64K page issue: https://claudeissues.com/issue/25713-bug-native-binary-bun-jsc-aborts-on-arm64-linux-with-64k-page-size-kernels
- Swift Static Linux SDK: https://www.swift.org/documentation/articles/static-linux-getting-started.html ; Swift on Linux: https://www.swift.org/install/linux/
- Unofficial Fedora Asahi bootc images: https://github.com/fedora-asahi-remix-atomic-desktops/images
- Local: `~/src/aiui` (README, `Sources/*`, `web/libraries.json`), `~/src/aicoin/CONTRACT.md`
