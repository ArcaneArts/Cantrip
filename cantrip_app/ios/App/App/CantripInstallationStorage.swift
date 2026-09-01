import CryptoKit
import Foundation
import Security
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let schemaVersion: Int64 = 1
private let provider = "apple-keychain"
private let keychainService = "art.cantrip.installation.hpke.v1"
private let keyAliasFormat = "cantrip.installation.<installation-uuid>.hpke.v1"

private struct InstallationProfile: Codable, Equatable {
    let createdAt: String
    let installationId: String
    let schemaVersion: Int64
}

private struct EncryptionPublicKey: Codable, Equatable {
    let algorithm: String
    let format: String
    let value: String
    let version: Int64
}

private struct InstallationDeviceKey: Codable, Equatable {
    let createdAt: String
    let installationId: String
    let keyAlias: String
    let provider: String
    let publicKey: EncryptionPublicKey
    let status: String
    let version: Int64
}

private struct InstallationAccountBinding: Codable, Equatable {
    let grantRevision: Int64
    let keyAlias: String
    let masterKeyRevision: Int64
    let ownerId: String
    let principalId: String
    let serverId: String
    let updatedAt: String
}

private struct InstallationMigration: Codable, Equatable {
    let completedAt: String?
    let migrationId: String
    let startedAt: String?
    let state: String
    let verificationState: String?
}

private struct InstallationCatalogSnapshot: Codable {
    let accountBindings: [InstallationAccountBinding]
    let deviceKeys: [InstallationDeviceKey]
    let installation: InstallationProfile?
    let migrations: [InstallationMigration]
    let revision: Int64
    let schemaVersion: Int64
}

private struct DeviceKeyDescriptor: Codable, Equatable {
    let createdAt: String
    let installationId: String
    let keyAlias: String
    let provider: String
    let publicKey: EncryptionPublicKey
}

private struct DeviceKeyCreateInput: Codable {
    let createdAt: String?
    let installationId: String
    let keyAlias: String
}

private struct KeychainRecord: Codable {
    let createdAt: String
    let installationId: String
    let keyAlias: String
    var privateKey: String
    let publicKey: String
    let version: Int64
}

private struct HPKESuite: Codable {
    let aead: String
    let kdf: String
    let kem: String
    let mode: String
}

private struct HPKEEnvelope: Codable {
    let algorithm: String
    let ciphertext: String
    let encapsulatedKey: String
    let suite: HPKESuite
    let version: Int64
}

private struct ClientMasterKeyWrapper: Codable {
    let clientId: String
    let envelope: HPKEEnvelope
    let masterKeyRevision: Int64
    let purpose: String
    let version: Int64
}

private struct MasterKeyUnwrapInput: Codable {
    let keyAlias: String
    let ownerId: String
    let wrapper: ClientMasterKeyWrapper
}

private enum CatalogOperation: Decodable {
    case createInstallation(InstallationProfile)
    case putAccountBinding(InstallationAccountBinding)
    case putDeviceKey(InstallationDeviceKey)
    case putMigration(InstallationMigration)

    private enum CodingKeys: String, CodingKey {
        case binding
        case deviceKey
        case migration
        case profile
        case type
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(String.self, forKey: .type) {
        case "create-installation":
            self = .createInstallation(try values.decode(InstallationProfile.self, forKey: .profile))
        case "put-account-binding":
            self = .putAccountBinding(try values.decode(InstallationAccountBinding.self, forKey: .binding))
        case "put-device-key":
            self = .putDeviceKey(try values.decode(InstallationDeviceKey.self, forKey: .deviceKey))
        case "put-migration":
            self = .putMigration(try values.decode(InstallationMigration.self, forKey: .migration))
        default:
            throw CantripNativeStorageError("installation-catalog-corrupt")
        }
    }
}

private struct CatalogTransactionRequest: Decodable {
    let expectedRevision: Int64
    let operations: [CatalogOperation]
}

private enum SQLiteValue {
    case int(Int64)
    case null
    case text(String)
}

final class CantripInstallationStorage {
    private let catalogURL: URL
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let lock = NSLock()

    init() throws {
        let root = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = root.appendingPathComponent("installation/v1", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        catalogURL = directory.appendingPathComponent("catalog.sqlite3", isDirectory: false)
    }

    func status() -> [String: Any] {
        [
            "catalogPath": catalogURL.path,
            "keyAliasFormat": keyAliasFormat,
            "provider": provider,
            "schemaVersion": schemaVersion
        ]
    }

    func readCatalog() throws -> [String: Any] {
        try locked {
            let database = try openDatabase()
            defer { sqlite3_close(database) }
            return try jsonObject(snapshot(database))
        }
    }

    func applyCatalogTransaction(_ source: [String: Any]) throws -> [String: Any] {
        let request = try decode(CatalogTransactionRequest.self, source)
        return try locked {
            let database = try openDatabase()
            defer { sqlite3_close(database) }
            try execute(database, "BEGIN IMMEDIATE")
            var committed = false
            defer { if !committed { try? execute(database, "ROLLBACK") } }
            guard try catalogRevision(database) == request.expectedRevision else {
                throw CantripNativeStorageError("installation-catalog-conflict")
            }
            for operation in request.operations {
                try apply(database, operation)
            }
            if !request.operations.isEmpty {
                try execute(database, "UPDATE catalog_meta SET revision = revision + 1 WHERE singleton_id = 1")
            }
            let result = try snapshot(database)
            try execute(database, "COMMIT")
            committed = true
            return try jsonObject(result)
        }
    }

    func createKey(_ source: [String: Any]) throws -> [String: Any] {
        let input = try decode(DeviceKeyCreateInput.self, source)
        return try locked {
            try validateInstallationId(input.installationId)
            guard input.keyAlias == installationKeyAlias(input.installationId) else {
                throw CantripNativeStorageError("native-device-key-alias-invalid")
            }
            if let createdAt = input.createdAt { try validateTimestamp(createdAt, code: "installation-timestamp-invalid") }
            let database = try openDatabase()
            defer { sqlite3_close(database) }
            guard try scalarText(database, "SELECT installation_id FROM installation WHERE singleton_id = 1") == input.installationId else {
                throw CantripNativeStorageError("installation-missing")
            }
            if let existing = try inspectKeyUnlocked(input.keyAlias) {
                guard existing.installationId == input.installationId else {
                    throw CantripNativeStorageError("native-device-key-conflict")
                }
                return try jsonObject(existing)
            }
            if try rowExists(database, "SELECT 1 FROM device_key WHERE key_alias = ?", [.text(input.keyAlias)]) {
                throw CantripNativeStorageError("native-device-key-missing")
            }
            let privateKey = P256.KeyAgreement.PrivateKey()
            var privateBytes = privateKey.rawRepresentation
            defer { privateBytes.resetBytes(in: 0..<privateBytes.count) }
            let record = KeychainRecord(
                createdAt: input.createdAt ?? currentTimestamp(),
                installationId: input.installationId,
                keyAlias: input.keyAlias,
                privateKey: CantripHPKE.encodeBase64URL(privateBytes),
                publicKey: CantripHPKE.encodeBase64URL(privateKey.publicKey.x963Representation),
                version: 1
            )
            var serialized = try encoder.encode(record)
            defer { serialized.resetBytes(in: 0..<serialized.count) }
            let status = SecItemAdd([
                kSecClass: kSecClassGenericPassword,
                kSecAttrService: keychainService,
                kSecAttrAccount: input.keyAlias,
                kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                kSecValueData: serialized
            ] as CFDictionary, nil)
            if status == errSecDuplicateItem, let winner = try inspectKeyUnlocked(input.keyAlias) {
                return try jsonObject(winner)
            }
            guard status == errSecSuccess else { throw CantripNativeStorageError("native-key-store-unavailable") }
            return try jsonObject(descriptor(record))
        }
    }

    func inspectKey(_ keyAlias: String) throws -> [String: Any]? {
        try locked {
            try validateIdentifier(keyAlias, code: "native-device-key-invalid")
            guard let descriptor = try inspectKeyUnlocked(keyAlias) else { return nil }
            return try jsonObject(descriptor)
        }
    }

    func unwrapAccountMasterKey(_ source: [String: Any]) throws -> Data {
        let input = try decode(MasterKeyUnwrapInput.self, source)
        return try locked {
            try validateWrapper(input)
            guard var record = try readKeychainRecord(input.keyAlias) else {
                throw CantripNativeStorageError("native-device-key-missing")
            }
            defer { record.privateKey = "" }
            try validate(record, expectedAlias: input.keyAlias)
            var privateBytes = try CantripHPKE.decodeBase64URL(record.privateKey)
            defer { privateBytes.resetBytes(in: 0..<privateBytes.count) }
            let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateBytes)
            let recipientPublicKey = try CantripHPKE.decodeBase64URL(record.publicKey, expectedLength: 65)
            let encapsulated = try CantripHPKE.decodeBase64URL(input.wrapper.envelope.encapsulatedKey, expectedLength: 65)
            let ciphertext = try CantripHPKE.decodeBase64URL(input.wrapper.envelope.ciphertext, expectedLength: 48)
            let aad = try CantripHPKE.associatedData(
                ownerId: input.ownerId,
                clientId: input.wrapper.clientId,
                revision: input.wrapper.masterKeyRevision
            )
            let plaintext: Data
            do {
                plaintext = try CantripHPKE.open(
                    privateKey: privateKey,
                    recipientPublicKey: recipientPublicKey,
                    encapsulatedKey: encapsulated,
                    ciphertext: ciphertext,
                    authenticatedData: aad
                )
            } catch {
                throw CantripNativeStorageError("client-master-key-decryption-failed")
            }
            guard plaintext.count == 32 else { throw CantripNativeStorageError("client-master-key-decryption-failed") }
            return plaintext
        }
    }

    private func openDatabase() throws -> OpaquePointer {
        var database: OpaquePointer?
        guard sqlite3_open_v2(catalogURL.path, &database, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let database else {
            if let database { sqlite3_close(database) }
            throw CantripNativeStorageError("installation-catalog-unavailable")
        }
        do {
            sqlite3_busy_timeout(database, 5_000)
            try execute(database, "PRAGMA foreign_keys = ON")
            try initializeSchema(database)
            return database
        } catch {
            sqlite3_close(database)
            throw error
        }
    }

    private func initializeSchema(_ database: OpaquePointer) throws {
        let version = try scalarInt(database, "PRAGMA user_version")
        if version > schemaVersion { throw CantripNativeStorageError("installation-catalog-version-unsupported") }
        if version == 0 {
            guard try userTables(database).isEmpty else { throw CantripNativeStorageError("installation-catalog-corrupt") }
            try execute(database, "BEGIN IMMEDIATE")
            do {
                try executeBatch(database, Self.schemaSQL)
                try execute(database, "COMMIT")
            } catch {
                try? execute(database, "ROLLBACK")
                throw error
            }
        }
        try verifySchema(database)
    }

    private func verifySchema(_ database: OpaquePointer) throws {
        guard try scalarInt(database, "PRAGMA user_version") == schemaVersion,
              try userTables(database) == Set(["account_binding", "catalog_meta", "device_key", "installation", "migration"]),
              try scalarInt(database, "SELECT COUNT(*) FROM catalog_meta WHERE singleton_id = 1 AND schema_version = 1 AND revision >= 0") == 1,
              try scalarText(database, "PRAGMA quick_check(1)") == "ok",
              try scalarInt(database, "SELECT COUNT(*) FROM pragma_foreign_key_check") == 0 else {
            throw CantripNativeStorageError("installation-catalog-corrupt")
        }
    }

    private func snapshot(_ database: OpaquePointer) throws -> InstallationCatalogSnapshot {
        let installation = try query(database, "SELECT created_at, installation_id, schema_version FROM installation WHERE singleton_id = 1") { statement in
            InstallationProfile(createdAt: text(statement, 0), installationId: text(statement, 1), schemaVersion: sqlite3_column_int64(statement, 2))
        }
        if installation.count > 1 { throw CantripNativeStorageError("installation-catalog-corrupt") }
        let deviceKeys = try query(database, "SELECT created_at, installation_id, key_alias, provider, public_key_json, status, version FROM device_key ORDER BY key_alias") { statement in
            InstallationDeviceKey(
                createdAt: text(statement, 0),
                installationId: text(statement, 1),
                keyAlias: text(statement, 2),
                provider: text(statement, 3),
                publicKey: try decoder.decode(EncryptionPublicKey.self, from: Data(text(statement, 4).utf8)),
                status: text(statement, 5),
                version: sqlite3_column_int64(statement, 6)
            )
        }
        let bindings = try query(database, "SELECT server_id, owner_id, principal_id, key_alias, grant_revision, master_key_revision, updated_at FROM account_binding ORDER BY server_id, owner_id") { statement in
            InstallationAccountBinding(
                grantRevision: sqlite3_column_int64(statement, 4),
                keyAlias: text(statement, 3),
                masterKeyRevision: sqlite3_column_int64(statement, 5),
                ownerId: text(statement, 1),
                principalId: text(statement, 2),
                serverId: text(statement, 0),
                updatedAt: text(statement, 6)
            )
        }
        let migrations = try query(database, "SELECT migration_id, started_at, completed_at, state, verification_state FROM migration ORDER BY migration_id") { statement in
            InstallationMigration(
                completedAt: optionalText(statement, 2),
                migrationId: text(statement, 0),
                startedAt: optionalText(statement, 1),
                state: text(statement, 3),
                verificationState: optionalText(statement, 4)
            )
        }
        let value = InstallationCatalogSnapshot(
            accountBindings: bindings,
            deviceKeys: deviceKeys,
            installation: installation.first,
            migrations: migrations,
            revision: try catalogRevision(database),
            schemaVersion: schemaVersion
        )
        try validateSnapshot(value)
        return value
    }

    private func apply(_ database: OpaquePointer, _ operation: CatalogOperation) throws {
        switch operation {
        case let .createInstallation(profile):
            try validate(profile)
            if let existing = try scalarText(database, "SELECT installation_id FROM installation WHERE singleton_id = 1") {
                guard existing == profile.installationId else { throw CantripNativeStorageError("installation-conflict") }
                return
            }
            try execute(database, "INSERT INTO installation (singleton_id, installation_id, created_at, schema_version) VALUES (1, ?, ?, ?)", [
                .text(profile.installationId), .text(profile.createdAt), .int(profile.schemaVersion)
            ])
        case let .putDeviceKey(deviceKey):
            try validate(database, deviceKey)
            guard let nativeDescriptor = try inspectKeyUnlocked(deviceKey.keyAlias) else {
                throw CantripNativeStorageError("native-device-key-missing")
            }
            guard nativeDescriptor == descriptor(deviceKey) else {
                throw CantripNativeStorageError("native-device-key-metadata-mismatch")
            }
            if let catalogKey = try readDeviceKey(database, deviceKey.keyAlias),
               catalogKey.createdAt != deviceKey.createdAt ||
               catalogKey.installationId != deviceKey.installationId ||
               catalogKey.keyAlias != deviceKey.keyAlias ||
               catalogKey.provider != deviceKey.provider ||
               catalogKey.publicKey != deviceKey.publicKey ||
               catalogKey.version != deviceKey.version {
                throw CantripNativeStorageError("native-device-key-metadata-mismatch")
            }
            let publicKey = String(data: try encoder.encode(deviceKey.publicKey), encoding: .utf8)!
            try execute(database, "INSERT INTO device_key (key_alias, installation_id, public_key_json, provider, created_at, status, version) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key_alias) DO UPDATE SET status = excluded.status", [
                .text(deviceKey.keyAlias), .text(deviceKey.installationId), .text(publicKey), .text(deviceKey.provider), .text(deviceKey.createdAt), .text(deviceKey.status), .int(deviceKey.version)
            ])
        case let .putAccountBinding(binding):
            try validate(database, binding)
            try execute(database, "INSERT INTO account_binding (server_id, owner_id, principal_id, key_alias, grant_revision, master_key_revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(server_id, owner_id) DO UPDATE SET principal_id = excluded.principal_id, key_alias = excluded.key_alias, grant_revision = excluded.grant_revision, master_key_revision = excluded.master_key_revision, updated_at = excluded.updated_at", [
                .text(binding.serverId), .text(binding.ownerId), .text(binding.principalId), .text(binding.keyAlias), .int(binding.grantRevision), .int(binding.masterKeyRevision), .text(binding.updatedAt)
            ])
        case let .putMigration(migration):
            try validate(migration)
            try execute(database, "INSERT INTO migration (migration_id, started_at, completed_at, state, verification_state) VALUES (?, ?, ?, ?, ?) ON CONFLICT(migration_id) DO UPDATE SET started_at = excluded.started_at, completed_at = excluded.completed_at, state = excluded.state, verification_state = excluded.verification_state", [
                .text(migration.migrationId), sqliteValue(migration.startedAt), sqliteValue(migration.completedAt), .text(migration.state), sqliteValue(migration.verificationState)
            ])
        }
    }

    private func validateSnapshot(_ snapshot: InstallationCatalogSnapshot) throws {
        if let installation = snapshot.installation { try validate(installation) }
        guard snapshot.schemaVersion == schemaVersion, snapshot.revision >= 0 else {
            throw CantripNativeStorageError("installation-catalog-corrupt")
        }
        for deviceKey in snapshot.deviceKeys {
            guard snapshot.installation?.installationId == deviceKey.installationId else {
                throw CantripNativeStorageError("installation-catalog-corrupt")
            }
            try validateFields(deviceKey)
        }
        for binding in snapshot.accountBindings {
            try validateFields(binding)
            guard snapshot.deviceKeys.contains(where: { $0.keyAlias == binding.keyAlias && $0.status == "active" }) else {
                throw CantripNativeStorageError("installation-catalog-corrupt")
            }
        }
        for migration in snapshot.migrations { try validate(migration) }
    }

    private func validate(_ profile: InstallationProfile) throws {
        try validateInstallationId(profile.installationId)
        try validateTimestamp(profile.createdAt, code: "installation-profile-invalid")
        guard profile.schemaVersion == schemaVersion else { throw CantripNativeStorageError("installation-profile-invalid") }
    }

    private func validate(_ database: OpaquePointer, _ deviceKey: InstallationDeviceKey) throws {
        guard try scalarText(database, "SELECT installation_id FROM installation WHERE singleton_id = 1") == deviceKey.installationId else {
            throw CantripNativeStorageError("installation-device-key-invalid")
        }
        try validateFields(deviceKey)
    }

    private func validateFields(_ deviceKey: InstallationDeviceKey) throws {
        try validateInstallationId(deviceKey.installationId)
        try validateTimestamp(deviceKey.createdAt, code: "installation-device-key-invalid")
        guard deviceKey.keyAlias == installationKeyAlias(deviceKey.installationId),
              deviceKey.provider == provider,
              deviceKey.version == 1,
              deviceKey.status == "active" || deviceKey.status == "retired",
              deviceKey.publicKey.algorithm == "P-256",
              deviceKey.publicKey.format == "raw",
              deviceKey.publicKey.version == 1 else {
            throw CantripNativeStorageError("installation-device-key-invalid")
        }
        _ = try CantripHPKE.decodeBase64URL(deviceKey.publicKey.value, expectedLength: 65)
    }

    private func validate(_ database: OpaquePointer, _ binding: InstallationAccountBinding) throws {
        try validateFields(binding)
        guard binding.grantRevision >= 1, binding.masterKeyRevision >= 1,
              try rowExists(database, "SELECT 1 FROM device_key WHERE key_alias = ? AND status = 'active'", [.text(binding.keyAlias)]) else {
            throw CantripNativeStorageError("installation-account-binding-invalid")
        }
    }

    private func validateFields(_ binding: InstallationAccountBinding) throws {
        try validateIdentifier(binding.serverId, code: "installation-account-binding-invalid")
        try validateIdentifier(binding.ownerId, code: "installation-account-binding-invalid")
        try validateIdentifier(binding.principalId, code: "installation-account-binding-invalid")
        try validateIdentifier(binding.keyAlias, code: "installation-account-binding-invalid")
        try validateTimestamp(binding.updatedAt, code: "installation-account-binding-invalid")
    }

    private func validate(_ migration: InstallationMigration) throws {
        try validateIdentifier(migration.migrationId, code: "installation-migration-invalid")
        if let startedAt = migration.startedAt { try validateTimestamp(startedAt, code: "installation-migration-invalid") }
        if let completedAt = migration.completedAt { try validateTimestamp(completedAt, code: "installation-migration-invalid") }
        guard ["failed", "in-progress", "pending", "verified"].contains(migration.state) else {
            throw CantripNativeStorageError("installation-migration-invalid")
        }
        if migration.state == "verified" && (migration.startedAt == nil || migration.completedAt == nil || migration.verificationState?.isEmpty != false) {
            throw CantripNativeStorageError("installation-migration-invalid")
        }
    }

    private func validateWrapper(_ input: MasterKeyUnwrapInput) throws {
        try validateIdentifier(input.keyAlias, code: "client-master-key-wrapper-invalid")
        try validateIdentifier(input.ownerId, code: "client-master-key-wrapper-invalid")
        try validateIdentifier(input.wrapper.clientId, code: "client-master-key-wrapper-invalid")
        let envelope = input.wrapper.envelope
        let suite = envelope.suite
        guard input.wrapper.version == 1,
              input.wrapper.purpose == "client-account-master-key",
              input.wrapper.masterKeyRevision >= 1,
              envelope.version == 1,
              envelope.algorithm == "HPKE-RFC9180",
              suite.mode == "base",
              suite.kem == "DHKEM(P-256,HKDF-SHA256)",
              suite.kdf == "HKDF-SHA256",
              suite.aead == "AES-256-GCM" else {
            throw CantripNativeStorageError("client-master-key-wrapper-invalid")
        }
    }

    private func inspectKeyUnlocked(_ keyAlias: String) throws -> DeviceKeyDescriptor? {
        guard var record = try readKeychainRecord(keyAlias) else { return nil }
        defer { record.privateKey = "" }
        try validate(record, expectedAlias: keyAlias)
        var privateBytes = try CantripHPKE.decodeBase64URL(record.privateKey)
        defer { privateBytes.resetBytes(in: 0..<privateBytes.count) }
        _ = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateBytes)
        return descriptor(record)
    }

    private func readDeviceKey(_ database: OpaquePointer, _ keyAlias: String) throws -> InstallationDeviceKey? {
        let values = try query(
            database,
            "SELECT created_at, installation_id, key_alias, provider, public_key_json, status, version FROM device_key WHERE key_alias = ?",
            [.text(keyAlias)]
        ) { statement in
            InstallationDeviceKey(
                createdAt: text(statement, 0),
                installationId: text(statement, 1),
                keyAlias: text(statement, 2),
                provider: text(statement, 3),
                publicKey: try decoder.decode(EncryptionPublicKey.self, from: Data(text(statement, 4).utf8)),
                status: text(statement, 5),
                version: sqlite3_column_int64(statement, 6)
            )
        }
        guard values.count <= 1 else { throw CantripNativeStorageError("installation-catalog-corrupt") }
        return values.first
    }

    private func readKeychainRecord(_ keyAlias: String) throws -> KeychainRecord? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: keychainService,
            kSecAttrAccount: keyAlias,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, var data = result as? Data else {
            throw CantripNativeStorageError("native-key-store-unavailable")
        }
        defer { data.resetBytes(in: 0..<data.count) }
        do { return try decoder.decode(KeychainRecord.self, from: data) }
        catch { throw CantripNativeStorageError("native-device-key-invalid") }
    }

    private func validate(_ record: KeychainRecord, expectedAlias: String) throws {
        try validateInstallationId(record.installationId)
        try validateTimestamp(record.createdAt, code: "native-device-key-invalid")
        guard record.version == 1,
              record.keyAlias == expectedAlias,
              record.keyAlias == installationKeyAlias(record.installationId) else {
            throw CantripNativeStorageError("native-device-key-invalid")
        }
        _ = try CantripHPKE.decodeBase64URL(record.publicKey, expectedLength: 65)
    }

    private func descriptor(_ record: KeychainRecord) -> DeviceKeyDescriptor {
        DeviceKeyDescriptor(
            createdAt: record.createdAt,
            installationId: record.installationId,
            keyAlias: record.keyAlias,
            provider: provider,
            publicKey: EncryptionPublicKey(algorithm: "P-256", format: "raw", value: record.publicKey, version: 1)
        )
    }

    private func descriptor(_ key: InstallationDeviceKey) -> DeviceKeyDescriptor {
        DeviceKeyDescriptor(
            createdAt: key.createdAt,
            installationId: key.installationId,
            keyAlias: key.keyAlias,
            provider: key.provider,
            publicKey: key.publicKey
        )
    }

    private func decode<T: Decodable>(_ type: T.Type, _ source: [String: Any]) throws -> T {
        do { return try decoder.decode(type, from: JSONSerialization.data(withJSONObject: source)) }
        catch let error as CantripNativeStorageError { throw error }
        catch { throw CantripNativeStorageError("installation-catalog-corrupt") }
    }

    private func jsonObject<T: Encodable>(_ value: T) throws -> [String: Any] {
        let object = try JSONSerialization.jsonObject(with: encoder.encode(value))
        guard let dictionary = object as? [String: Any] else { throw CantripNativeStorageError("native-storage-task-failed") }
        return dictionary
    }

    private func locked<T>(_ operation: () throws -> T) throws -> T {
        lock.lock()
        defer { lock.unlock() }
        return try operation()
    }

    private func catalogRevision(_ database: OpaquePointer) throws -> Int64 {
        let revision = try scalarInt(database, "SELECT revision FROM catalog_meta WHERE singleton_id = 1")
        guard revision >= 0 else { throw CantripNativeStorageError("installation-catalog-corrupt") }
        return revision
    }

    private func execute(_ database: OpaquePointer, _ sql: String, _ values: [SQLiteValue] = []) throws {
        var statement: OpaquePointer?
        if sqlite3_prepare_v2(database, sql, -1, &statement, nil) != SQLITE_OK {
            throw CantripNativeStorageError("installation-catalog-unavailable")
        }
        defer { sqlite3_finalize(statement) }
        try bind(statement, values)
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { return }
            if result != SQLITE_ROW { throw CantripNativeStorageError("installation-catalog-unavailable") }
        }
    }

    private func executeBatch(_ database: OpaquePointer, _ sql: String) throws {
        var message: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(database, sql, nil, nil, &message)
        if let message { sqlite3_free(message) }
        guard result == SQLITE_OK else {
            throw CantripNativeStorageError("installation-catalog-unavailable")
        }
    }

    private func query<T>(_ database: OpaquePointer, _ sql: String, _ values: [SQLiteValue] = [], map: (OpaquePointer) throws -> T) throws -> [T] {
        var statement: OpaquePointer?
        if sqlite3_prepare_v2(database, sql, -1, &statement, nil) != SQLITE_OK {
            throw CantripNativeStorageError("installation-catalog-corrupt")
        }
        defer { sqlite3_finalize(statement) }
        try bind(statement, values)
        var result: [T] = []
        while true {
            let status = sqlite3_step(statement)
            if status == SQLITE_DONE { return result }
            if status != SQLITE_ROW { throw CantripNativeStorageError("installation-catalog-corrupt") }
            result.append(try map(statement!))
        }
    }

    private func bind(_ statement: OpaquePointer?, _ values: [SQLiteValue]) throws {
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let status: Int32
            switch value {
            case let .int(value): status = sqlite3_bind_int64(statement, index, value)
            case .null: status = sqlite3_bind_null(statement, index)
            case let .text(value): status = sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
            }
            if status != SQLITE_OK { throw CantripNativeStorageError("installation-catalog-unavailable") }
        }
    }

    private func scalarInt(_ database: OpaquePointer, _ sql: String, _ values: [SQLiteValue] = []) throws -> Int64 {
        let result = try query(database, sql, values) { sqlite3_column_int64($0, 0) }
        guard result.count == 1 else { throw CantripNativeStorageError("installation-catalog-corrupt") }
        return result[0]
    }

    private func scalarText(_ database: OpaquePointer, _ sql: String, _ values: [SQLiteValue] = []) throws -> String? {
        let result = try query(database, sql, values) { optionalText($0, 0) }
        if result.isEmpty { return nil }
        guard result.count == 1 else { throw CantripNativeStorageError("installation-catalog-corrupt") }
        return result[0]
    }

    private func rowExists(_ database: OpaquePointer, _ sql: String, _ values: [SQLiteValue]) throws -> Bool {
        !(try query(database, sql, values) { _ in true }).isEmpty
    }

    private func userTables(_ database: OpaquePointer) throws -> Set<String> {
        Set(try query(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'") { text($0, 0) })
    }

    private func text(_ statement: OpaquePointer, _ column: Int32) -> String {
        String(cString: sqlite3_column_text(statement, column))
    }

    private func optionalText(_ statement: OpaquePointer, _ column: Int32) -> String? {
        sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : text(statement, column)
    }

    private func sqliteValue(_ value: String?) -> SQLiteValue {
        value.map(SQLiteValue.text) ?? .null
    }

    private func validateIdentifier(_ value: String, code: String) throws {
        guard !value.isEmpty, value.utf8.count <= 255 else { throw CantripNativeStorageError(code) }
    }

    private func validateInstallationId(_ value: String) throws {
        guard let parsed = UUID(uuidString: value), parsed.uuidString.lowercased() == value else {
            throw CantripNativeStorageError("installation-profile-invalid")
        }
        let bytes = withUnsafeBytes(of: parsed.uuid) { Array($0) }
        let version = bytes[6] >> 4
        guard (1...8).contains(version), bytes[8] & 0xc0 == 0x80 else {
            throw CantripNativeStorageError("installation-profile-invalid")
        }
    }

    private func validateTimestamp(_ value: String, code: String) throws {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let ordinary = ISO8601DateFormatter()
        ordinary.formatOptions = [.withInternetDateTime]
        guard fractional.date(from: value) != nil || ordinary.date(from: value) != nil else {
            throw CantripNativeStorageError(code)
        }
    }

    private func installationKeyAlias(_ installationId: String) -> String {
        "cantrip.installation.\(installationId).hpke.v1"
    }

    private func currentTimestamp() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private static let schemaSQL = """
    CREATE TABLE catalog_meta (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL);
    INSERT INTO catalog_meta (singleton_id, schema_version, revision) VALUES (1, 1, 0);
    CREATE TABLE installation (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), installation_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, schema_version INTEGER NOT NULL);
    CREATE TABLE device_key (key_alias TEXT PRIMARY KEY, installation_id TEXT NOT NULL, public_key_json TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, FOREIGN KEY (installation_id) REFERENCES installation(installation_id));
    CREATE TABLE account_binding (server_id TEXT NOT NULL, owner_id TEXT NOT NULL, principal_id TEXT NOT NULL, key_alias TEXT NOT NULL, grant_revision INTEGER NOT NULL, master_key_revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (server_id, owner_id), FOREIGN KEY (key_alias) REFERENCES device_key(key_alias));
    CREATE TABLE migration (migration_id TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT, state TEXT NOT NULL, verification_state TEXT);
    PRAGMA user_version = 1;
    """
}
