import SwiftUI

/// Looks for pool servers on the local network and hands back the address of the one chosen.
struct NetworkScanView: View {
    let choose: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @AppStorage(SettingsKey.networkScanPort) private var savedPort = NetworkScanner.defaultPort
    @AppStorage(SettingsKey.scanTimeoutSeconds) private var timeoutSeconds = NetworkScanner.defaultTimeoutSeconds
    @State private var network = ""
    // text rather than a formatted number, which only updates once the field loses focus
    @State private var portText = ""
    @State private var scanner = NetworkScanner()

    private var parsedNetwork: IPv4Network? { IPv4Network(network) }

    private var port: Int? {
        Int(portText.trimmingCharacters(in: .whitespaces)).flatMap { (1...65535).contains($0) ? $0 : nil }
    }

    private var problem: String? {
        guard let parsedNetwork else {
            return network.trimmingCharacters(in: .whitespaces).isEmpty
                ? String(localized: "Enter the network to scan, like 192.168.1.0/24.")
                : String(localized: "The network is an address and prefix, like 192.168.1.0/24.")
        }
        if parsedNetwork.hostCount > IPv4Network.maxHosts {
            return String(localized: "That network has \(parsedNetwork.hostCount.formatted()) addresses. Scan a /22 or smaller, which has at most \(IPv4Network.maxHosts.formatted()).")
        }
        return port == nil ? String(localized: "The port is a number from 1 to 65535.") : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Network") {
                        TextField("192.168.1.0/24", text: $network)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numbersAndPunctuation)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    LabeledContent("Port") {
                        TextField(String(NetworkScanner.defaultPort), text: $portText)
                            .multilineTextAlignment(.trailing)
                            .keyboardType(.numberPad)
                    }
                    Stepper(value: $timeoutSeconds, in: 0.5...10, step: 0.5) {
                        LabeledContent("Timeout", value: "\(timeoutSeconds.formatted(.number.precision(.fractionLength(1)))) s")
                    }
                } footer: {
                    if let problem {
                        Text(problem).foregroundStyle(.red)
                    } else {
                        Text("The network starts as the one this device is on. The timeout is how long to wait for each address to answer; raise it on a slow network.")
                    }
                }
                .disabled(scanner.isScanning)

                if scanner.hasScanned {
                    results
                }
            }
            .navigationTitle("Scan Network")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        scanner.stop()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if scanner.isScanning {
                        Button("Stop") { scanner.stop() }
                    } else {
                        Button("Scan", action: scan)
                            .disabled(problem != nil)
                    }
                }
            }
            .onAppear {
                portText = String(savedPort)
                if network.isEmpty {
                    network = IPv4Network.device()?.description ?? ""
                }
            }
            .onDisappear {
                scanner.stop()
            }
        }
    }

    private var results: some View {
        Section {
            ForEach(scanner.found) { server in
                Button {
                    scanner.stop()
                    choose(server.address)
                    dismiss()
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(server.address)
                            .foregroundStyle(.primary)
                        Text("Version \(server.version) · running since \(server.startedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            if scanner.isScanning {
                ProgressView(value: Double(scanner.checked), total: Double(max(scanner.total, 1)))
            }
        } header: {
            Text("Servers Found")
        } footer: {
            Text(resultsFooter)
        }
    }

    private var resultsFooter: String {
        if scanner.isScanning {
            return String(localized: "Checked \(scanner.checked) of \(scanner.total) addresses.")
        }
        if scanner.wasStopped {
            return String(localized: "Stopped after checking \(scanner.checked) of \(scanner.total) addresses.")
        }
        if scanner.found.isEmpty {
            return String(localized: "No pool server answered on port \(scanner.port) at any of \(scanner.total) addresses. Check the port, or raise the timeout. If iOS just asked to find devices on your local network, allow it and scan again.")
        }
        return String(localized: "Tap a server to use it.")
    }

    private func scan() {
        guard let parsedNetwork, let port, problem == nil else {
            return
        }
        savedPort = port
        scanner.scan(parsedNetwork, port: port, timeout: timeoutSeconds)
    }
}

#Preview {
    NetworkScanView { _ in }
}
