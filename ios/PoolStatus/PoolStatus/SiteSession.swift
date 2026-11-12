import Foundation
import Observation
import PoolStatusCore

/// The pools this app knows, and the one on screen with a status store of its own, so nothing
/// from one pool — readings, pending changes, live updates — ever shows on another.
@Observable
final class SiteSession {
    typealias MakeStore = @MainActor (Site, CredentialStore) -> StatusStore

    let sites: SiteStore
    /// The site on screen; nil while the site list shows.
    private(set) var openID: Site.ID?
    /// The open site's store, made fresh each time a site opens.
    private(set) var store: StatusStore?
    /// Whether the page for adding a site is up, over whatever is on screen, so adding works the
    /// same from the list, a site's sign-in page or its dashboard.
    var isAddingSite = false

    @ObservationIgnored private let makeStore: MakeStore
    /// What checks that a new site's server answers.
    @ObservationIgnored private let network: URLSession

    init(sites: SiteStore = SiteStore(), network: URLSession = .shared,
         makeStore: @escaping MakeStore = SiteSession.liveStore) {
        sites.migrate()
        self.sites = sites
        self.network = network
        self.makeStore = makeStore
        // reopen the site from last time, unless it was signed out, which starts on the list
        if let site = sites.activeSite, sites.signIns[site.id] != nil {
            open(site)
        }
    }

    static func liveStore(for site: Site, credentials: CredentialStore) -> StatusStore {
        StatusStore(serverAddress: site.address, remembersAddress: false, credentials: credentials,
                    live: URLSessionLiveTransport())
    }

    var openSite: Site? { openID.flatMap(sites.site(id:)) }

    /// Adds a site for `address` once a pool server there answers.
    func add(name: String, address: String) async throws -> Site {
        _ = try await StatusClient(serverAddress: address, session: network).fetchStatus()
        return try sites.add(name: name, address: address)
    }

    /// Shows `site`: its dashboard when signed in, otherwise its sign-in page.
    func open(_ site: Site) {
        sites.activate(site)
        guard site.id != openID else {
            return
        }
        store = makeStore(site, sites.credentialStore(for: site))
        openID = site.id
    }

    /// Back to the list; the site stays the one the app opens at the next launch.
    func showSites() {
        openID = nil
        store = nil
    }

    /// Saves a new name or address, reconnecting an open site that moved.
    func update(_ site: Site) throws {
        let previous = sites.site(id: site.id)
        try sites.update(site)
        guard site.id == openID, let saved = sites.site(id: site.id), saved.address != previous?.address else {
            return
        }
        store = makeStore(saved, sites.credentialStore(for: saved))
    }

    func remove(_ site: Site) {
        if site.id == openID {
            showSites()
        }
        sites.remove(site)
    }

    /// The site open last goes to the watch, with its sign-in.
    var watchContext: WatchContext {
        guard let site = sites.activeSite else {
            return WatchContext(serverAddress: "", poolName: "", credentials: nil)
        }
        return WatchContext(serverAddress: site.address, poolName: site.name, credentials: sites.signIns[site.id])
    }
}
