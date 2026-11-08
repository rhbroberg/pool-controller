import Foundation

public enum ServerAddress {
    /// The address as a person would say it: no scheme, no trailing slash.
    public static func display(_ address: String) -> String {
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
