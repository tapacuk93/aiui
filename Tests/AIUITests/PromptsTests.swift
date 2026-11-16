import XCTest
@testable import AIUI

final class PromptsTests: AIUITestCase {
    func testSystemPromptIsTheMacOne() {
        XCTAssertEqual(Prompts.system, Prompts.intro + Prompts.macAccess + Prompts.ui)
        XCTAssertTrue(Prompts.intro.contains("AI UI"))
        XCTAssertFalse(Prompts.iosAccess.isEmpty)
        XCTAssertFalse(Prompts.webAccess.isEmpty)
    }

    func testGenerationIsAStableFingerprint() {
        XCTAssertFalse(Prompts.generation.isEmpty)
        XCTAssertEqual(Prompts.generation, Prompts.generation)
        XCTAssertNotNil(Prompts.generation.range(of: "^[0-9a-z]+$", options: .regularExpression))
    }

    func testMemorySections() {
        XCTAssertTrue(Prompts.memory(index: "/tmp/x/index.txt").contains("`/tmp/x/index.txt`"))
        XCTAssertTrue(Prompts.memoryWeb.contains("## Memory"))
    }

    func testRoleTextsAreNonEmpty() {
        for t in [Prompts.pager, Prompts.suggest, Prompts.scout, Prompts.reviser, Prompts.refine, Prompts.translate,
                  Prompts.profiler, Prompts.quick, Prompts.tester, Prompts.improver, Prompts.componentImprover,
                  Prompts.retro, Prompts.menus, Prompts.console, Prompts.librarian] {
            XCTAssertGreaterThan(t.count, 40)
        }
    }

    func testSchemasAreJSONObjects() {
        for s in [Prompts.profileSchema, Prompts.testsSchema, Prompts.componentSchema, Prompts.retroSchema,
                  Prompts.menusSchema, Prompts.consoleSchema, Prompts.librarySchema, Prompts.patchSchema,
                  Prompts.translateSchema, Prompts.suggestSchema, Prompts.pageSchema, Prompts.screenSchema] {
            let o = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any]
            XCTAssertEqual(o?["type"] as? String, "object", s)
        }
        for o in [Prompts.timeoutSchema, Prompts.improveSchema, Prompts.circleSchema] {
            XCTAssertEqual(o["type"] as? String, "object")
        }
        let screen = (try? JSONSerialization.jsonObject(with: Data(Prompts.screenSchema.utf8))) as? [String: Any]
        XCTAssertNotNil((screen?["properties"] as? [String: Any])?["reuse"])
    }

    func testJSONSortsKeys() {
        XCTAssertEqual(Prompts.json(["b": 1, "a": [2]]), #"{"a":[2],"b":1}"#)
    }
}
