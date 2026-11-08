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
    let connected: (String) -> Void

    @State private var address = ""
    @State private var isTesting = false
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
                    .disabled(isTesting)
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
                            if isTesting {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(trimmedAddress.isEmpty || isTesting)
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
    }

    private func connect() {
        connect(to: trimmedAddress)
    }

    private func connect(to candidate: String) {
        guard !candidate.isEmpty, !isTesting else {
            return
        }
        isTesting = true
        errorMessage = nil
        Task {
            defer { isTesting = false }
            do {
                _ = try await StatusClient(serverAddress: candidate).fetchStatus()
                connected(candidate)
            } catch {
                errorMessage = "Couldn’t reach \(ServerAddress.display(candidate)). \(error.localizedDescription)"
            }
        }
    }
}

#Preview {
    ServerSetupView { _ in }
}
