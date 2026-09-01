import Capacitor
import Foundation

@objc(CantripInstallationStoragePlugin)
public final class CantripInstallationStoragePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CantripInstallationStoragePlugin"
    public let jsName = "CantripInstallationStorage"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readCatalog", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyCatalogTransaction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "replaceMissingKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "inspectKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unwrapAccountMasterKey", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "art.cantrip.installation-storage", qos: .userInitiated)
    private var storage: CantripInstallationStorage?

    @objc override public func load() {
        do {
            storage = try CantripInstallationStorage()
        } catch {
            storage = nil
        }
    }

    @objc func status(_ call: CAPPluginCall) {
        perform(call) { storage in storage.status() }
    }

    @objc func readCatalog(_ call: CAPPluginCall) {
        perform(call) { storage in try storage.readCatalog() }
    }

    @objc func applyCatalogTransaction(_ call: CAPPluginCall) {
        perform(call) { storage in
            guard let request = call.getObject("request") else {
                throw CantripNativeStorageError("installation-catalog-corrupt")
            }
            return try storage.applyCatalogTransaction(request)
        }
    }

    @objc func createKey(_ call: CAPPluginCall) {
        perform(call) { storage in
            guard let request = call.getObject("input") else {
                throw CantripNativeStorageError("native-device-key-invalid")
            }
            return try storage.createKey(request)
        }
    }

    @objc func replaceMissingKey(_ call: CAPPluginCall) {
        perform(call) { storage in
            guard let request = call.getObject("input") else {
                throw CantripNativeStorageError("native-device-key-invalid")
            }
            return try storage.replaceMissingKey(request)
        }
    }

    @objc func inspectKey(_ call: CAPPluginCall) {
        performOptional(call) { storage in
            guard let keyAlias = call.getString("keyAlias") else {
                throw CantripNativeStorageError("native-device-key-invalid")
            }
            return try storage.inspectKey(keyAlias)
        }
    }

    @objc func unwrapAccountMasterKey(_ call: CAPPluginCall) {
        queue.async { [weak self] in
            do {
                guard let storage = self?.storage else {
                    throw CantripNativeStorageError("native-key-store-unavailable")
                }
                guard let request = call.getObject("input") else {
                    throw CantripNativeStorageError("client-master-key-wrapper-invalid")
                }
                var plaintext = try storage.unwrapAccountMasterKey(request)
                defer { plaintext.resetBytes(in: 0..<plaintext.count) }
                call.resolve(["bytes": plaintext.map(Int.init)])
            } catch {
                self?.reject(call, error)
            }
        }
    }

    private func perform(_ call: CAPPluginCall, operation: @escaping (CantripInstallationStorage) throws -> [String: Any]) {
        queue.async { [weak self] in
            do {
                guard let storage = self?.storage else {
                    throw CantripNativeStorageError("native-key-store-unavailable")
                }
                call.resolve(try operation(storage))
            } catch {
                self?.reject(call, error)
            }
        }
    }

    private func performOptional(
        _ call: CAPPluginCall,
        operation: @escaping (CantripInstallationStorage) throws -> [String: Any]?
    ) {
        queue.async { [weak self] in
            do {
                guard let storage = self?.storage else {
                    throw CantripNativeStorageError("native-key-store-unavailable")
                }
                if let result = try operation(storage) {
                    call.resolve(result)
                } else {
                    call.resolve()
                }
            } catch {
                self?.reject(call, error)
            }
        }
    }

    private func reject(_ call: CAPPluginCall, _ error: Error) {
        let native = error as? CantripNativeStorageError
        let code = native?.code ?? "native-storage-task-failed"
        call.reject(code, code, error)
    }
}
