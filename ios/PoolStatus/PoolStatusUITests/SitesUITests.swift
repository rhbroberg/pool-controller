import XCTest

/// Drives the app as a person would, through its pretend server: adding pools, signing in and
/// out, switching between pools, and what the app opens at the next launch.
@MainActor
final class SitesUITests: XCTestCase {
    /// Long enough for a sign-in, a refresh and the page that follows.
    private let timeout: TimeInterval = 10

    // MARK: Adding a pool

    func testFirstLaunchAddsAPoolAndSignsIn() {
        let app = launch(reset: true)
        XCTAssertTrue(app.staticTexts["No Pools Yet"].waitForExistence(timeout: timeout))

        app.buttons["Add Site"].firstMatch.tap()
        type("Home", into: app.textFields["Pool"])
        type("home.test:3000", into: app.textFields["192.168.1.20:3000"])
        app.buttons["Connect"].tap()

        // nothing from the pool shows until signing in
        XCTAssertTrue(app.textFields["Account Name"].waitForExistence(timeout: timeout))
        XCTAssertTrue(app.navigationBars["Home"].exists)
        XCTAssertFalse(app.staticTexts["Remote Menu"].exists)

        signIn(app, as: "tester", password: "secret")
        XCTAssertTrue(app.staticTexts["Remote Menu"].waitForExistence(timeout: timeout))
    }

    func testAddingASecondPoolKeepsTheFirstSignedIn() {
        let app = launch(reset: true)
        app.buttons["Add Site"].firstMatch.tap()
        type("Home", into: app.textFields["Pool"])
        type("home.test:3000", into: app.textFields["192.168.1.20:3000"])
        app.buttons["Connect"].tap()
        signIn(app, as: "tester", password: "secret")
        XCTAssertTrue(app.staticTexts["Remote Menu"].waitForExistence(timeout: timeout))

        // with one pool, another is added from its menu as it would be with several, and no
        // warning comes first
        openFromMenu(app, current: "Home", choose: "Add Site…")
        type("Lake", into: app.textFields["Pool"])
        type("lake.test:3000", into: app.textFields["192.168.1.20:3000"])
        app.buttons["Connect"].tap()
        XCTAssertTrue(app.navigationBars["Lake"].waitForExistence(timeout: timeout))
        XCTAssertTrue(app.textFields["Account Name"].exists)

        openFromMenu(app, current: "Lake", choose: "All Sites")
        XCTAssertTrue(row(app, "Home").waitForExistence(timeout: timeout))
        XCTAssertTrue(row(app, "Home").label.contains("Signed in as tester"))
        XCTAssertTrue(row(app, "Lake").label.contains("Signed out"))
    }

    func testAPoolWhoseServerDoesNotAnswerIsNotAdded() {
        let app = launch(reset: true)
        app.buttons["Add Site"].firstMatch.tap()
        type("offline.test:3000", into: app.textFields["192.168.1.20:3000"])
        app.buttons["Connect"].tap()

        let error = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Couldn’t reach offline.test:3000")).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: timeout))
        XCTAssertFalse(app.textFields["Account Name"].exists)
    }

    // MARK: Signing in and out

    func testAWrongPasswordIsRefused() {
        let app = launch(reset: true, seed: "-uiTestSites")
        openFromMenu(app, current: "Home", choose: "Cabin")

        signIn(app, as: "tester", password: "nope")
        let error = app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "incorrect name or password")).firstMatch
        XCTAssertTrue(error.waitForExistence(timeout: timeout))
        XCTAssertFalse(app.staticTexts["Remote Menu"].exists)
    }

    func testSigningOutOfOnePoolLeavesTheOthersSignedIn() {
        let app = launch(reset: true, seed: "-uiTestSites")
        XCTAssertTrue(app.staticTexts["Remote Menu"].waitForExistence(timeout: timeout))

        app.buttons["Settings"].tap()
        let signOut = app.buttons["Sign Out"]
        XCTAssertTrue(signOut.waitForExistence(timeout: timeout))
        signOut.tap()

        // back on Home's sign-in page, offering the account that was signed in
        let account = app.textFields["Account Name"]
        XCTAssertTrue(account.waitForExistence(timeout: timeout))
        XCTAssertEqual(account.value as? String, "tester")

        app.buttons["Sites"].tap()
        XCTAssertTrue(row(app, "Home").waitForExistence(timeout: timeout))
        XCTAssertTrue(row(app, "Home").label.contains("Signed out"))
        XCTAssertTrue(row(app, "Lake").label.contains("Signed in as guest"))
    }

    func testASignInTheServerNoLongerAcceptsAsksAgain() {
        let app = launch(reset: true, seed: "-uiTestExpired")
        let message = app.staticTexts["Your sign-in is no longer valid. Sign in again."]
        XCTAssertTrue(message.waitForExistence(timeout: timeout))
        XCTAssertEqual(app.textFields["Account Name"].value as? String, "tester")

        signIn(app, as: "tester", password: "secret")
        XCTAssertTrue(app.staticTexts["Remote Menu"].waitForExistence(timeout: timeout))
    }

    // MARK: Switching

    func testSwitchingBetweenPools() {
        let app = launch(reset: true, seed: "-uiTestSites")
        XCTAssertTrue(app.staticTexts["Remote Menu"].waitForExistence(timeout: timeout))
        XCTAssertTrue(app.navigationBars["Home"].exists)

        openFromMenu(app, current: "Home", choose: "Lake")
        XCTAssertTrue(app.navigationBars["Lake"].waitForExistence(timeout: timeout))
        XCTAssertTrue(app.staticTexts["Remote Menu"].waitForExistence(timeout: timeout))

        openFromMenu(app, current: "Lake", choose: "Cabin")
        XCTAssertTrue(app.textFields["Account Name"].waitForExistence(timeout: timeout))
        XCTAssertFalse(app.staticTexts["Remote Menu"].exists)

        openFromMenu(app, current: "Cabin", choose: "All Sites")
        XCTAssertTrue(app.navigationBars["Sites"].waitForExistence(timeout: timeout))
        XCTAssertTrue(row(app, "Home").label.contains("Signed in as tester"))
        XCTAssertTrue(row(app, "Lake").label.contains("Signed in as guest"))
        XCTAssertTrue(row(app, "Cabin").label.contains("Signed out"))
    }

    func testRelaunchingOpensTheLastPoolOnlyWhenSignedIn() {
        var app = launch(reset: true, seed: "-uiTestSites")
        openFromMenu(app, current: "Home", choose: "Lake")
        XCTAssertTrue(app.staticTexts["Remote Menu"].waitForExistence(timeout: timeout))

        app.terminate()
        app = launch()
        XCTAssertTrue(app.navigationBars["Lake"].waitForExistence(timeout: timeout))
        XCTAssertTrue(app.staticTexts["Remote Menu"].waitForExistence(timeout: timeout))

        openFromMenu(app, current: "Lake", choose: "Cabin")
        XCTAssertTrue(app.textFields["Account Name"].waitForExistence(timeout: timeout))

        // Cabin was open last but is signed out, so the app starts on the list
        app.terminate()
        app = launch()
        XCTAssertTrue(app.navigationBars["Sites"].waitForExistence(timeout: timeout))
    }

    // MARK: Removing

    func testRemovingAPoolKeepsTheOthers() {
        let app = launch(reset: true, seed: "-uiTestSites")
        openFromMenu(app, current: "Home", choose: "All Sites")
        XCTAssertTrue(app.navigationBars["Sites"].waitForExistence(timeout: timeout))

        row(app, "Cabin").swipeLeft()
        app.buttons["Remove"].tap()
        let confirm = app.buttons["Remove Site"]
        XCTAssertTrue(confirm.waitForExistence(timeout: timeout))
        confirm.tap()

        XCTAssertTrue(row(app, "Cabin").waitForNonExistence(timeout: timeout))
        XCTAssertTrue(row(app, "Home").exists)
        XCTAssertTrue(row(app, "Lake").exists)
    }

    // MARK: Helpers

    /// Starts the app against its pretend server; `reset` forgets everything from earlier launches.
    private func launch(reset: Bool = false, seed: String? = nil) -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["-uiTesting"] + (reset ? ["-uiTestReset"] : []) + (seed.map { [$0] } ?? [])
        app.launch()
        return app
    }

    private func type(_ text: String, into field: XCUIElement) {
        XCTAssertTrue(field.waitForExistence(timeout: timeout))
        field.tap()
        field.typeText(text)
    }

    private func signIn(_ app: XCUIApplication, as account: String, password: String) {
        let accountField = app.textFields["Account Name"]
        XCTAssertTrue(accountField.waitForExistence(timeout: timeout))
        if (accountField.value as? String) != account {
            accountField.tap()
            accountField.typeText(account)
        }
        type(password, into: app.secureTextFields["Password"])
        app.buttons["Sign In"].tap()
    }

    /// Chooses from the menu under the open pool's name.
    private func openFromMenu(_ app: XCUIApplication, current: String, choose item: String) {
        let bar = app.navigationBars[current]
        XCTAssertTrue(bar.waitForExistence(timeout: timeout))
        // the title is a label that acts as a button, which XCUITest finds as neither, so tap
        // where it always is: the middle of the bar
        bar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let choice = app.buttons[item]
        XCTAssertTrue(choice.waitForExistence(timeout: timeout), "no \(item) in the pool menu")
        choice.tap()
    }

    /// The site list's row for `name`, whose label reads its name, address and sign-in.
    private func row(_ app: XCUIApplication, _ name: String) -> XCUIElement {
        app.buttons["site-\(name)"]
    }
}
