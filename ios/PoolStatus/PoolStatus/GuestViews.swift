import AVFoundation
import CoreImage.CIFilterBuiltins
import PoolStatusCore
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A guest's QR code: its link, which a phone's camera opens in the browser and this app's QR
/// button reads, to let the guest in once to choose a password.
enum GuestQRCode {
    /// Black on white with the quiet zone scanners need, whatever the app's colours.
    static func image(for text: String, moduleSize: CGFloat = 10) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: moduleSize, y: moduleSize)),
              let code = CIContext().createCGImage(output, from: output.extent) else {
            return nil
        }
        let quiet = 3 * moduleSize
        let size = CGSize(width: CGFloat(code.width) + 2 * quiet, height: CGFloat(code.height) + 2 * quiet)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            context.cgContext.interpolationQuality = .none
            UIImage(cgImage: code).draw(in: CGRect(x: quiet, y: quiet, width: CGFloat(code.width), height: CGFloat(code.height)))
        }
    }

    /// Puts the QR code on the clipboard as an image, with its link as a URL and as text, so
    /// whatever it's pasted into takes the one it can use; false if there's no link to copy.
    @discardableResult
    static func copy(_ account: AccountInfo, serverAddress: String) -> Bool {
        guard let url = GuestLink.url(serverAddress: serverAddress, account: account) else {
            return false
        }
        var item: [String: Any] = [UTType.url.identifier: url, UTType.plainText.identifier: url.absoluteString]
        if let png = image(for: url.absoluteString)?.pngData() {
            item[UTType.png.identifier] = png
        }
        UIPasteboard.general.setItems([item])
        return true
    }
}

/// A guest's QR code, its link, and ways to copy or share it.
struct GuestQRView: View {
    let account: AccountInfo
    let serverAddress: String

    @Environment(\.dismiss) private var dismiss
    @State private var copied = false

    private var link: URL? { GuestLink.url(serverAddress: serverAddress, account: account) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if let link, let image = GuestQRCode.image(for: link.absoluteString) {
                        Image(uiImage: image)
                            .interpolation(.none)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: 260)
                            .clipShape(.rect(cornerRadius: 12))
                            .accessibilityLabel("QR code for \(account.name)")
                    }
                    Text(account.setupCode != nil
                         ? "Scan it with a phone’s camera, or with the QR button on the Pool Status app’s sign-in. It lets \(account.name) in once to choose a password."
                         : "\(account.name) has chosen a password. The code now opens the sign-in with the name filled in.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    if let expiresAt = account.expiresAt {
                        Text("Expires \(expiresAt, format: .dateTime.month().day().hour().minute())")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    if let link {
                        Text(link.absoluteString)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .multilineTextAlignment(.center)
                            .padding(10)
                            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 8))
                        HStack(spacing: 12) {
                            Button("Copy QR Code", systemImage: "doc.on.doc") {
                                copied = GuestQRCode.copy(account, serverAddress: serverAddress)
                            }
                            .buttonStyle(.bordered)
                            ShareLink(item: link) {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                            .buttonStyle(.bordered)
                        }
                        if copied {
                            Text("Copied the QR code and its link.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .padding()
                .frame(maxWidth: .infinity)
            }
            .navigationTitle(account.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

/// Admin: add a guest, an operator with a made-up name and a QR code that lets them in once to
/// choose a password. It expires in a week unless another time is picked.
struct NewGuestView: View {
    let created: (AccountInfo) -> Void

    @Environment(StatusStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var expires = true
    @State private var expiresAt = Date.now.addingTimeInterval(7 * 24 * 3600)
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("A guest is an operator with a made-up name, such as sunny-otter, and no password. Its QR code lets them in once, from a phone’s camera or this app, to choose one.")
                        .font(.subheadline)
                }
                Section {
                    Toggle("Expires", isOn: $expires)
                    if expires {
                        DatePicker("Archived On", selection: $expiresAt, in: Date.now..., displayedComponents: [.date, .hourAndMinute])
                    }
                } footer: {
                    if let errorMessage {
                        Text(errorMessage).foregroundStyle(.red)
                    } else {
                        Text(expires ? "Once it passes, the guest is archived and can’t sign in." : "The guest lasts until you remove it.")
                    }
                }
            }
            .navigationTitle("Add Guest")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Add") {
                            errorMessage = nil
                            isSaving = true
                        }
                    }
                }
            }
        }
        .task(id: isSaving) {
            if isSaving {
                await add()
            }
        }
    }

    private func add() async {
        do {
            let guest = try await store.auth.createGuest(expiry: expires ? .at(expiresAt) : .never)
            dismiss()
            created(guest)
        } catch {
            if !error.isCancellation {
                errorMessage = error.localizedDescription
            }
        }
        isSaving = false
    }
}

/// Reads a guest's QR code with the camera, or takes its link from the clipboard, as when it
/// came in a message.
struct ScanGuestCodeView: View {
    let scanned: (GuestLink) -> Void

    private enum Camera {
        case checking, ready, denied, unavailable
    }

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var camera = Camera.checking
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ZStack {
                    switch camera {
                    case .checking:
                        ProgressView()
                    case .ready:
                        QRCameraView(found: take)
                            .ignoresSafeArea(edges: .horizontal)
                        RoundedRectangle(cornerRadius: 20)
                            .strokeBorder(.white.opacity(0.85), lineWidth: 3)
                            .frame(width: 240, height: 240)
                            .accessibilityHidden(true)
                    case .denied:
                        ContentUnavailableView {
                            Label("Camera Not Allowed", systemImage: "camera.fill")
                        } description: {
                            Text("Allow Pool Status to use the camera in Settings, or paste the guest’s link below.")
                        } actions: {
                            Button("Open Settings") {
                                if let url = URL(string: UIApplication.openSettingsURLString) {
                                    openURL(url)
                                }
                            }
                        }
                    case .unavailable:
                        ContentUnavailableView("No Camera", systemImage: "camera.fill",
                                               description: Text("This device has no camera to scan with. Paste the guest’s link below."))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(camera == .ready ? Color.black : Color(.systemGroupedBackground))

                VStack(spacing: 10) {
                    Text(problem ?? String(localized: "Point the camera at the guest QR code an admin shared."))
                        .font(.subheadline)
                        .foregroundStyle(problem == nil ? Color.secondary : Color.red)
                        .multilineTextAlignment(.center)
                    PasteButton(payloadType: String.self) { strings in
                        take(strings.first ?? "")
                    }
                    .labelStyle(.titleAndIcon)
                }
                .padding()
                .frame(maxWidth: .infinity)
                .background(.bar)
            }
            .navigationTitle("Scan QR Code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .task {
            camera = await Self.cameraAccess()
        }
    }

    private func take(_ text: String) {
        guard let link = GuestLink(text) else {
            problem = String(localized: "That isn’t a Pool Status guest code.")
            return
        }
        dismiss()
        scanned(link)
    }

    private static func cameraAccess() async -> Camera {
        guard AVCaptureDevice.default(for: .video) != nil else {
            return .unavailable
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .ready
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video) ? .ready : .denied
        default: return .denied
        }
    }
}

/// The camera's picture, reporting each QR code it reads once.
private struct QRCameraView: UIViewControllerRepresentable {
    let found: (String) -> Void

    func makeUIViewController(context: Context) -> QRCameraController {
        QRCameraController(found: found)
    }

    func updateUIViewController(_ controller: QRCameraController, context: Context) {
        controller.found = found
    }
}

private final class QRCameraController: UIViewController, @preconcurrency AVCaptureMetadataOutputObjectsDelegate {
    /// Starting and stopping the session blocks, so it happens off the main thread.
    private final class Capture: @unchecked Sendable {
        let session = AVCaptureSession()
        let queue = DispatchQueue(label: "QRCameraController")
    }

    var found: (String) -> Void
    private let capture = Capture()
    private var preview: AVCaptureVideoPreviewLayer?
    /// The last code reported, so holding the camera on one reports it once.
    private var lastCode: String?

    init(found: @escaping (String) -> Void) {
        self.found = found
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("not from a storyboard")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let session = capture.session
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        preview = layer
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let capture = capture
        capture.queue.async { capture.session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        let capture = capture
        capture.queue.async { capture.session.stopRunning() }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let code = (metadataObjects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, code != lastCode else {
            return
        }
        lastCode = code
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        found(code)
    }
}
