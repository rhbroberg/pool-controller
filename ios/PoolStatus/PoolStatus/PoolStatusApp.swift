import PoolStatusCore
import SwiftUI

@main
struct PoolStatusApp: App {
    @State private var session: SiteSession
    @State private var watchLink: WatchLink

    init() {
        #if DEBUG
        let session = UITestMode.isActive ? UITestMode.makeSession() : SiteSession()
        #else
        let session = SiteSession()
        #endif
        _session = State(initialValue: session)
        // the watch app can wake this app in the background, before any view appears, to ask for this
        _watchLink = State(initialValue: WatchLink(context: session.watchContext))
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if let store = session.store, let site = session.openSite {
                    SiteView()
                        .environment(store)
                        // a fresh page for each site, so nothing typed or scrolled carries over
                        .id(site.id)
                } else {
                    SitesView()
                }
            }
            .environment(session)
            .animation(.default, value: session.openID)
            .onChange(of: session.watchContext) { _, context in
                watchLink.send(context)
            }
        }
    }
}

/// One site: its dashboard once signed in, and until then only its sign-in page.
struct SiteView: View {
    @Environment(StatusStore.self) private var store

    var body: some View {
        if store.auth.credentials != nil {
            StatusView()
        } else {
            SiteSignInView()
        }
    }
}
