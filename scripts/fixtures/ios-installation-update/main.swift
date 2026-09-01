import Foundation
import Security
import SQLite3

func requireString(_ source: [String: Any], _ key: String) -> String {
    guard let value = source[key] as? String else {
        fatalError("Missing frozen fixture value: \(key)")
    }
    return value
}

guard CommandLine.arguments.count == 3 else {
    fatalError("Expected the frozen catalog SQL and custody JSON paths")
}

let catalogSQL = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
    .replacingOccurrences(of: "__CANTRIP_NATIVE_PROVIDER__", with: "apple-keychain")
let fixtureData = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
guard let fixture = try JSONSerialization.jsonObject(with: fixtureData) as? [String: Any],
      fixture["fixtureVersion"] as? Int == 1,
      let keychainRecord = fixture["iosKeychainRecord"] as? [String: Any],
      let wrapper = fixture["accountMasterKeyWrapper"] as? [String: Any] else {
    fatalError("Invalid frozen version-one fixture")
}

let installationId = requireString(fixture, "installationId")
let keyAlias = requireString(fixture, "keyAlias")
let service = "art.cantrip.installation.hpke.v1.update-fixture.\(ProcessInfo.processInfo.processIdentifier)"
let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("cantrip-ios-update-fixture-\(UUID().uuidString)", isDirectory: true)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }

let keychainQuery: [CFString: Any] = [
    kSecClass: kSecClassGenericPassword,
    kSecAttrService: service,
    kSecAttrAccount: keyAlias
]
SecItemDelete(keychainQuery as CFDictionary)
defer { SecItemDelete(keychainQuery as CFDictionary) }
var keychainInsert = keychainQuery
keychainInsert[kSecValueData] = try JSONSerialization.data(withJSONObject: keychainRecord)
precondition(
    SecItemAdd(keychainInsert as CFDictionary, nil) == errSecSuccess,
    "Could not seed frozen version-one Keychain custody"
)

let catalogURL = root
    .appendingPathComponent("installation/v1", isDirectory: true)
    .appendingPathComponent("catalog.sqlite3", isDirectory: false)
try FileManager.default.createDirectory(
    at: catalogURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
)
var database: OpaquePointer?
precondition(sqlite3_open(catalogURL.path, &database) == SQLITE_OK, "Could not create frozen catalog")
var sqliteMessage: UnsafeMutablePointer<CChar>?
let sqliteStatus = sqlite3_exec(database, catalogSQL, nil, nil, &sqliteMessage)
if let sqliteMessage { sqlite3_free(sqliteMessage) }
precondition(sqliteStatus == SQLITE_OK, "Could not seed frozen catalog")
sqlite3_close(database)

let storage = try CantripInstallationStorage(rootURL: root, keychainService: service)
let snapshot = try storage.readCatalog()
precondition(snapshot["revision"] as? Int64 == 3 || snapshot["revision"] as? Int == 3)
guard let installation = snapshot["installation"] as? [String: Any] else {
    fatalError("Current iOS runtime did not read the frozen installation")
}
precondition(installation["installationId"] as? String == installationId)
guard let deviceKeys = snapshot["deviceKeys"] as? [[String: Any]], deviceKeys.count == 1 else {
    fatalError("Current iOS runtime did not read the frozen key metadata")
}
precondition(deviceKeys[0]["provider"] as? String == "apple-keychain")

guard let descriptor = try storage.inspectKey(keyAlias) else {
    fatalError("Current iOS runtime did not find frozen Keychain custody")
}
precondition(descriptor["keyAlias"] as? String == keyAlias)
guard let publicKey = descriptor["publicKey"] as? [String: Any] else {
    fatalError("Current iOS runtime returned invalid public-key metadata")
}
precondition(publicKey["value"] as? String == requireString(fixture, "publicKey"))

let opened = try storage.unwrapAccountMasterKey([
    "keyAlias": keyAlias,
    "ownerId": requireString(fixture, "ownerId"),
    "wrapper": wrapper
])
precondition(
    opened.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "") == requireString(fixture, "expectedAccountMasterKey"),
    "Current iOS runtime could not decrypt the frozen version-one marker"
)
