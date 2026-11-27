import PoolStatusCore
import SwiftUI

/// One body of water as the temperature card shows it.
struct WaterStatus: Identifiable {
    let body: WaterBody
    let reading: DashboardReading
    /// The heater and heat pump at work on it; nil unless one is on and a pump sends water to it.
    let heating: BodyHeating?

    var id: WaterBody { body }
}

/// The pool and the spa side by side, alike: each temperature, and while a pump sends water to
/// it with the heater or heat pump on, those and the setpoint they're heading for.
struct TemperatureCard: View {
    let waters: [WaterStatus]
    let lastRefresh: Date?
    let isConnected: Bool
    let isLive: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 14) {
                ForEach(waters) { water in
                    if water.body != waters.first?.body {
                        Divider()
                    }
                    WaterColumn(water: water)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            FreshnessLine(lastRefresh: lastRefresh, isConnected: isConnected, isLive: isLive)
        }
        .padding(14)
        .cardBackground()
    }
}

fileprivate struct WaterColumn: View {
    let water: WaterStatus

    @ScaledMetric(relativeTo: .largeTitle) private var temperatureSize: CGFloat = 44

    private var reading: DashboardReading { water.reading }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // title link opens the temperature graph; the number below opens the thermostat
            NavigationLink(value: DashboardRoute.temperatureHistory(water.body)) {
                HStack(spacing: 4) {
                    Text(reading.title)
                        .foregroundStyle(Color.accentColor)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.accentColor)
                    Spacer(minLength: 4)
                    ForEach(water.heating?.sources ?? []) { source in
                        SourceIcon(source: source)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(reading.title)
            .accessibilityHint("Shows the temperature history")

            NavigationLink(value: DashboardRoute.thermostat(water.body)) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(reading.value)
                        .font(.system(size: temperatureSize, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                        .foregroundStyle(reading.isDimmed ? .secondary : .primary)
                    detail
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(thermostatAccessibilityText)
            .accessibilityHint("Sets the temperature")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Where the water is headed and by when, or that its pump is off; a line is kept either way
    /// so the card doesn't change height as heating starts and stops.
    @ViewBuilder
    private var detail: some View {
        if let heating = water.heating, let setpoint = heating.setpoint {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Label("\(setpoint)°", systemImage: "target")
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(heating.sources.first.map { $0.device.tint.color } ?? .orange)
                if let ready = heating.readyText {
                    Text("by \(ready)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.8)
        } else {
            Label("Pump off", systemImage: "pause.circle.fill")
                .font(.caption)
                .foregroundStyle(.secondary)
                .opacity(reading.isDimmed ? 1 : 0)
        }
    }

    private var thermostatAccessibilityText: String {
        var parts = [reading.value]
        if let heating = water.heating {
            if let setpoint = heating.setpoint {
                parts.append(heating.readyText.map { String(localized: "heading for \(setpoint) degrees by \($0)") }
                             ?? String(localized: "heading for \(setpoint) degrees"))
            }
            parts += heating.sources.map { source in
                source.isHeating ? String(localized: "\(source.device.title) heating") : String(localized: "\(source.device.title) on")
            }
        } else if reading.isDimmed {
            parts.append(String(localized: "Pump off"))
        }
        return parts.joined(separator: ", ")
    }
}

/// The heater's flame or the heat pump's waves in its colour, filled while it's producing heat.
fileprivate struct SourceIcon: View {
    let source: BodyHeating.Source

    var body: some View {
        Image(systemName: source.device.systemImage)
            .symbolVariant(source.isHeating ? .fill : .none)
            .foregroundStyle(source.device.tint.color)
    }
}

fileprivate extension HeatingDevice {
    var control: EquipmentControl? { EquipmentControl.control(named: controlName) }
    var systemImage: String { control?.systemImage ?? "flame" }
    var tint: Tint { control?.tint ?? .orange }
}

/// The air at the pool and today's forecast, in the bar beside the pool's name; the rest of the
/// forecast opens from it.
struct WeatherButton: View {
    let air: DashboardReading
    let weather: DashboardWeather?

    @State private var showingDetails = false

    var body: some View {
        Button {
            showingDetails = true
        } label: {
            HStack(spacing: 5) {
                Image(systemName: weather?.symbolName ?? "thermometer.medium")
                    .symbolRenderingMode(.multicolor)
                Text(air.value)
                    .monospacedDigit()
            }
            .fixedSize()
        }
        .accessibilityLabel(accessibilityText)
        .accessibilityHint("Shows today’s forecast")
        .popover(isPresented: $showingDetails) {
            details
                .padding()
                .presentationCompactAdaptation(.popover)
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let weather {
                Label(weather.title, systemImage: weather.symbolName)
                    .symbolRenderingMode(.multicolor)
                    .font(.headline)
                Text("High \(weather.high) · Low \(weather.low)")
                    .monospacedDigit()
                if let rain = weather.rainChance {
                    Text("\(rain)% chance of rain")
                }
            }
            Text("Air at the pool \(air.value)")
                .monospacedDigit()
            if let place = weather?.place {
                Text(place)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if weather?.isStale == true {
                Text("Forecast out of date")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
        .font(.subheadline)
        .fixedSize()
    }

    private var accessibilityText: String {
        var parts = [String(localized: "Air \(air.value)")]
        if let weather {
            parts.append(String(localized: "Today: \(weather.title), high \(weather.high), low \(weather.low)"))
            if let rain = weather.rainChance {
                parts.append(String(localized: "\(rain)% chance of rain"))
            }
            if weather.isStale {
                parts.append(String(localized: "Forecast out of date"))
            }
        }
        return parts.joined(separator: ", ")
    }
}

/// How old the readings on screen are, in words; nothing while live updates keep them current.
fileprivate struct FreshnessLine: View {
    let lastRefresh: Date?
    let isConnected: Bool
    let isLive: Bool

    var body: some View {
        if isConnected && isLive {
            EmptyView()
        } else if let lastRefresh {
            TimelineView(.periodic(from: .now, by: 15)) { context in
                let when = context.date.timeIntervalSince(lastRefresh) < 60
                    ? String(localized: "just now")
                    : lastRefresh.formatted(.relative(presentation: .named))
                Text(isConnected ? "Updated \(when)" : "Last reading \(when)")
                    .font(.caption)
                    .foregroundStyle(isConnected ? Color.secondary : Color.orange)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
    }
}
