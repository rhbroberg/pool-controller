import Foundation
import Testing
@testable import PoolStatusCore

@Suite("Watch app")
struct WatchContextTests {
    @Test("carries the server, pool name and sign-in from the iPhone")
    func roundTrip() throws {
        let context = WatchContext(serverAddress: "pool.local:3000", poolName: "Backyard",
                                   credentials: Credentials(name: "owner", token: "t", role: .user))
        let received = try #require(WatchContext(context.dictionary))
        #expect(received == context)
    }

    @Test("carries a signed-out iPhone, and a sign-in saved before roles existed")
    func partial() throws {
        let signedOut = WatchContext(serverAddress: "pool.local", poolName: "", credentials: nil)
        #expect(WatchContext(signedOut.dictionary) == signedOut)

        let noRole = WatchContext(serverAddress: "pool.local", poolName: "",
                                  credentials: Credentials(name: "owner", token: "t", role: nil))
        #expect(WatchContext(noRole.dictionary) == noRole)
    }

    @Test("ignores a context without a server, and gives a role it doesn't know the least access")
    func unexpected() throws {
        #expect(WatchContext([:]) == nil)
        let context = try #require(WatchContext(["serverAddress": "pool.local", "token": "t", "role": "owner"]))
        #expect(context.credentials?.role == .viewer)
    }

    @Test("takes the iPhone's sign-in, and forgets it once the iPhone signs out")
    func adopt() {
        let saved = InMemoryCredentialStore()
        let auth = AuthSession(client: StatusClient(serverAddress: "pool.local"), store: saved)
        let operatorSignIn = Credentials(name: "owner", token: "t", role: .user)

        auth.adopt(operatorSignIn)
        #expect(auth.canControl)
        #expect(saved.saved == operatorSignIn)
        #expect(!auth.needsAccountCheck)

        auth.adopt(nil)
        #expect(auth.credentials == nil)
        #expect(saved.saved == nil)
    }

    @Test("offers only everyday switches, none that ask first")
    func controls() {
        #expect(EquipmentControl.watch.map(\.name) == [.filter, .spaFilter, .blower, .heatPump, .heater, .lights, .yardLights])
        #expect(EquipmentControl.watch.allSatisfy { $0.confirmOn == nil && $0.confirmOff == nil })
    }
}
