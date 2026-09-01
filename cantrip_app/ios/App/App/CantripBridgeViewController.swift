import Capacitor

final class CantripBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginType(CantripInstallationStoragePlugin.self)
    }
}
