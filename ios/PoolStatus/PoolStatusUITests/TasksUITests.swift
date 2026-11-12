import XCTest

/// The task view through the pretend server: turning tasks on and off, and scheduling a preheat.
@MainActor
final class TasksUITests: XCTestCase {
    private let timeout: TimeInterval = 10

    func testASpaPartyIsAPreheatToo() {
        let app = launch()
        flip(app, "Spa Party")

        XCTAssertTrue(status(app, "spaParty", is: "On"))
        XCTAssertTrue(status(app, "spaPreheat", is: "On"))

        flip(app, "Spa Preheat")
        XCTAssertTrue(app.staticTexts["Spa preheat with the blower, and lights after dark"].waitForExistence(timeout: timeout),
                      "turning the preheat off ends the party")
    }

    func testAScheduledPreheatSaysWhenItWillBeReady() {
        let app = launch(seedTasks: true)
        let row = app.otherElements["task-spaPreheat"]
        XCTAssertTrue(row.waitForExistence(timeout: timeout))
        let scheduled = row.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Scheduled · Ready by")).firstMatch
        XCTAssertTrue(scheduled.waitForExistence(timeout: timeout))
        XCTAssertTrue(row.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Starts about")).firstMatch.exists)
        XCTAssertTrue(row.buttons["Change Time…"].exists)
        XCTAssertTrue(status(app, "pool", is: "On"))

        // off drops the schedule
        flip(app, "Spa Preheat")
        XCTAssertTrue(app.staticTexts["Spa filter, heater and heat pump"].waitForExistence(timeout: timeout))
        XCTAssertTrue(row.buttons["Ready At…"].exists)
    }

    func testTheEquipmentIsOneTapAway() {
        let app = launch()
        let equipment = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Equipment")).firstMatch
        XCTAssertTrue(equipment.waitForExistence(timeout: timeout))
        equipment.tap()
        XCTAssertTrue(app.navigationBars["Equipment"].waitForExistence(timeout: timeout))
        XCTAssertTrue(app.staticTexts["Circulation"].waitForExistence(timeout: timeout))
    }

    // MARK: Helpers

    private func launch(seedTasks: Bool = false) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting", "-uiTestReset", "-uiTestSites"] + (seedTasks ? ["-uiTestTasks"] : [])
        app.launch()
        return app
    }

    /// Taps the right end of a task's switch, where the knob is.
    private func flip(_ app: XCUIApplication, _ title: String) {
        let toggle = app.switches[title]
        XCTAssertTrue(toggle.waitForExistence(timeout: timeout))
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
    }

    /// Waits for the line under `task` to read `text`.
    private func status(_ app: XCUIApplication, _ task: String, is text: String) -> Bool {
        app.otherElements["task-\(task)"].staticTexts[text].waitForExistence(timeout: timeout)
    }
}
