import XCTest
@testable import AIUI

final class SmokeTests: AIUITestCase {
    func testExtractJSON() {
        XCTAssertEqual(extractJSON("x {\"a\":1} y")?["a"] as? Int, 1)
    }
}
