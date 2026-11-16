// Thin entry point: all logic (and its tests) lives in OSInstallerCore.
import Foundation
import OSInstallerCore

exit(CLI.live().run(Array(CommandLine.arguments.dropFirst())))
