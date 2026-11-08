import PoolStatusCore
import SwiftUI

/// The time zone the server's history days follow: its own, or one chosen from the list.
struct TimeZonePicker: View {
    let settings: ServerSettings
    let choose: (ServerSettings.Changes.TimeZoneChoice) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    private var zones: [String] {
        let all = TimeZone.knownTimeZoneIdentifiers
        guard !search.isEmpty else {
            return all
        }
        return all.filter { $0.localizedStandardContains(search.replacingOccurrences(of: " ", with: "_")) }
    }

    var body: some View {
        List {
            Section {
                Button {
                    choose(.host)
                    dismiss()
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Use the Server’s Time Zone")
                                .foregroundStyle(.primary)
                            Text(settings.detectedTimeZone ?? String(localized: "Not found; UTC"))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if settings.timeZoneSource != .configured {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.accentColor)
                        }
                    }
                }
            }
            Section {
                ForEach(zones, id: \.self) { zone in
                    Button {
                        choose(.named(zone))
                        dismiss()
                    } label: {
                        HStack {
                            Text(zone.replacingOccurrences(of: "_", with: " "))
                                .foregroundStyle(.primary)
                            Spacer()
                            if settings.timeZoneSource == .configured && settings.timeZone == zone {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                }
            }
        }
        .searchable(text: $search, prompt: "City or region")
        .navigationTitle("Time Zone")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#if DEBUG
#Preview {
    NavigationStack {
        TimeZonePicker(settings: ServerSettings.preview) { _ in }
    }
}

private extension ServerSettings {
    static var preview: ServerSettings {
        let json = #"{"timeZone":"America/New_York","timeZoneSource":"system","detectedTimeZone":"America/New_York","rawRetentionDays":365,"minimumRetentionDays":7,"maximumRetentionDays":3650}"#
        return try! JSONDecoder().decode(ServerSettings.self, from: Data(json.utf8))
    }
}
#endif
