import SwiftUI

enum ServerAddress {
    /// The address as a person would say it: no scheme, no trailing slash.
    static func display(_ address: String) -> String {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        for scheme in ["http://", "https://"] where text.lowercased().hasPrefix(scheme) {
            text.removeFirst(scheme.count)
        }
        while text.hasSuffix("/") {
            text.removeLast()
        }
        return text
    }
}

/// First launch: asks for the server and keeps the address only once the server answers.
struct ServerSetupView: View {
    @Environment(StatusStore.self) private var store
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
                        Text("Connect to your pool")
                            .font(.title2.weight(.semibold))
                        Text("Find the server attached to your pool controller on this phone’s Wi‑Fi network, or enter its address.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
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
                        Text("From outside your home network, use the https address you set up for it.")
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
            .navigationBarTitleDisplayMode(.inline)
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
            try await store.connect(to: candidate)
        } catch {
            if !error.isCancellation {
                errorMessage = "Couldn’t reach \(ServerAddress.display(candidate)). \(error.localizedDescription)"
            }
        }
        testing = nil
    }
}

#if DEBUG
#Preview {
    ServerSetupView()
        .environment(StatusStore.preview())
}
#endif
