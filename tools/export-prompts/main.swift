// Writes the prompts and schemas the web build needs (web/prompts.json) from Sources/App/Prompts.swift.
// Run via: swiftc -o build/export-prompts Sources/App/Prompts.swift tools/export-prompts/main.swift
import Foundation

let out: [String: Any] = [
    "system": Prompts.intro + Prompts.webAccess + Prompts.ui + Prompts.memoryWeb,
    "pager": Prompts.pager,
    "suggest": Prompts.suggest,
    "scout": Prompts.scout,
    "refine": Prompts.refine,
    "translate": Prompts.translate,
    "patchSchema": Prompts.patchSchema,
    "translateSchema": Prompts.translateSchema,
    "screenSchema": Prompts.screenSchema,
    "pageSchema": Prompts.pageSchema,
    "suggestSchema": Prompts.suggestSchema,
]
let data = try! JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys])
FileManager.default.createFile(atPath: CommandLine.arguments[1], contents: data)
