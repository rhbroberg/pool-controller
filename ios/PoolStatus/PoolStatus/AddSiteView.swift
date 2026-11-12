import PoolStatusCore
import SwiftUI

/// Adds a pool: finds its server on the network or takes its address, and keeps it only once the
/// server answers.
struct AddSiteView: View {
    /// Called with the site once it's saved.
    let added: (Site) -> Void

    @Environment(SiteSession.self) private var session
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var address = ""
    /// The address being tried; leaving the page cancels it.
    @State private var testing: String?
    @State private var errorMessage: String?
    @State private var isScanningNetwork = false

    private var trimmedAddress: String {
        address.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Image(systemName: "figure.pool.swim")
                            .font(.largeTitle)
                            .foregroundStyle(Color.accentColor)
                        Text("Add a pool")
                            .font(.title2.weight(.semibold))
                        Text("Find the server attached to the pool controller on this phone’s Wi‑Fi network, or enter its address.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                }

                Section {
                    TextField(SiteStore.defaultName, text: $name)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.next)
                } header: {
                    Text("Name")
                } footer: {
                    Text("What to call this pool in the app, like Home or Lake House.")
                }

                Section {
                    Button {
                        isScanningNetwork = true
                    } label: {
                        Label("Search My Network", systemImage: "magnifyingglass")
                    }
                    .disabled(testing != nil)
                } footer: {
                    Text("Looks for pool servers on the network this phone is connected to.")
                }

                Section {
                    TextField("192.168.1.20:3000", text: $address)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(connect)
                } header: {
                    Text("Or Enter the Address")
                } footer: {
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(.red)
                    } else {
                        Text("From outside the pool’s network, use the https address set up for it.")
                    }
                }

                Section {
                    Button(action: connect) {
                        HStack {
                            Text("Connect")
                            if testing != nil {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(trimmedAddress.isEmpty || testing != nil)
                }
            }
            .navigationTitle("Add Site")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .sheet(isPresented: $isScanningNetwork) {
                // a server the scan found has already answered, so connect to it straight away
                NetworkScanView { found in
                    address = found
                    connect(to: found)
                }
            }
        }
        .task(id: testing) {
            if let testing {
                await test(testing)
            }
        }
    }

    private func connect() {
        connect(to: trimmedAddress)
    }

    private func connect(to candidate: String) {
        guard !candidate.isEmpty, testing == nil else {
            return
        }
        errorMessage = nil
        testing = candidate
    }

    private func test(_ candidate: String) async {
        do {
            let site = try await session.add(name: name, address: candidate)
            dismiss()
            added(site)
        } catch let error as SiteError {
            errorMessage = error.localizedDescription
        } catch {
            if !error.isCancellation {
                errorMessage = String(localized: "Couldn’t reach \(ServerAddress.display(candidate)). \(error.localizedDescription)")
            }
        }
        testing = nil
    }
}

#if DEBUG
#Preview {
    AddSiteView { _ in }
        .environment(SiteSession.preview())
}
#endif
