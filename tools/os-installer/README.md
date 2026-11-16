# aiui-os: AI UI OS installer tools

The Mac side of installing AI UI OS next to macOS (plan: `docs/os-plan.md`, §1.4–1.7, M0 and M4).
A Swift package: library `OSInstallerCore` (all logic, 100% line-covered) and the `aiui-os` CLI.

```sh
swift build -c release
aiui-os preflight [--json]                  # M0: can this Mac run AI UI OS? (read-only)
aiui-os plan-install [--json] [--dry-run]   # the partition plan and the exact commands; always a dry run
aiui-os plan-uninstall [--json]             # the uninstall plan; dry run unless confirmed (below)
```

Options: `--fixtures DIR` reads recorded output instead of this Mac; `--size GB` (default 25);
`--manifest FILE` (an `installer_data.json` or one `os_list` entry, default built in; see
`manifests/aiui-os.example.json`); `--package DIR` (shown in the `dd` commands); `--marker FILE`.
Exit status: 0 ok, 1 not ready / refused / failed, 2 usage. `--json`: preflight prints one document;
plans print JSON lines (`start`, `check`, `step`, `plan` with its `hash`, `done`, or `error`).

## Safety

Nothing here writes to the disk layout, NVRAM, boot policy or partitions during preflight or planning:

- **Reading** goes through `Probe`, whose only queries are fixed read-only commands
  (`diskutil list/info/apfs list -plist`, `sysctl`, `ioreg`, `sw_vers`, `fdesetup status`, `pmset -g batt`,
  `tmutil latestbackup`). Disk identifiers must match `disk<N>[s<N>]` before they reach a command line.
- **Install** (`plan-install`) is only planned. The real step 1 is done by our Asahi installer fork
  (`--json`, run as root by the Mac app); `plan-install --execute` refuses. Step 2 (One True Recovery)
  is the person's: the plan ends with the guide text (`Guide.step2`).
- **Uninstall** deletes a partition only when it is proven ours: listed in `<ESP>/asahi/aiui-install.json`
  (GPT GUID and name `… - AI UI OS`, on the same disk), physically between the macOS container and the
  Recovery partition, and of the expected type. Any other partition in that region, a missing one, or a
  marker naming iSC, macOS or Recovery makes it refuse entirely. Plan: `bless --mount / --setBoot`,
  `diskutil apfs deleteContainer <stub>`, `diskutil eraseVolume free free <ESP/Boot/Root>`,
  `diskutil apfs resizeContainer <macOS> 0`.
- **Executing** happens only through `Executor`. `RealExecutor` refuses unless
  `--i-understand-this-repartitions` is given **and** `--plan-hash` equals the hash of the plan computed
  now from the live disk, and every command passes `SafetyGuard` (four exact command shapes; never
  `disk0`, `disk0s1`, the macOS partition except to grow it, or Recovery):

  ```sh
  aiui-os plan-uninstall                      # review; prints the hash
  aiui-os plan-uninstall --execute --plan-hash <hash> --i-understand-this-repartitions
  ```

  Tests drive it with a recording runner only; it has never been run for real.

## Tests and coverage

```sh
./coverage.sh            # swift test --enable-code-coverage; fails below 100% line coverage
./coverage.sh --report   # plus the per-file llvm-cov table
```

Fixtures: `Fixtures/this-mac-2026-11-16/` is recorded read-only from the reference MacBook Air (M1, j313ap,
macOS 27.0.1); GUIDs are replaced by stable fakes and serial numbers removed. Synthetic layouts
(AI UI OS installed, Asahi/foreign partitions, missing markers, wrong order, no Recovery, FileVault
on/off, battery, low space, old backups) are built in `Tests/…/Support.swift` as the same plists
`diskutil` prints, so they go through the real parser.

## Not done yet

- The installer fork itself (`--json`, `--dry-run`, ownership markers, branding), the package, the CDN.
- Reading the marker from an unmounted ESP: the tool does not mount anything; it says which
  `diskutil mount` to run, or takes `--marker`.
- The Mac app wizard (M4). The app can call `aiui-os preflight --json` and render the checks.
