import CryptoKit
import Foundation

struct CantripNativeStorageError: Error {
    let code: String

    init(_ code: String) {
        self.code = code
    }
}

enum CantripHPKE {
    private static let hpkeInfo = Data("cantrip:e2ee:hpke-key-wrap:v1".utf8)
    private static let kemSuiteID = Data("KEM".utf8) + i2osp(0x0010, length: 2)
    private static let suiteID = Data("HPKE".utf8) + i2osp(0x0010, length: 2) + i2osp(0x0001, length: 2) + i2osp(0x0002, length: 2)

    static func open(
        privateKey: P256.KeyAgreement.PrivateKey,
        recipientPublicKey: Data,
        encapsulatedKey: Data,
        ciphertext: Data,
        authenticatedData: Data
    ) throws -> Data {
        guard recipientPublicKey.count == 65, encapsulatedKey.count == 65, ciphertext.count == 48 else {
            throw CantripNativeStorageError("client-master-key-wrapper-invalid")
        }
        let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: encapsulatedKey)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: ephemeral)
        var dh = shared.withUnsafeBytes { Data($0) }
        defer { dh.resetBytes(in: 0..<dh.count) }
        let kemContext = encapsulatedKey + recipientPublicKey
        let eaePrk = labeledExtract(salt: Data(), label: "eae_prk", input: dh, suiteID: kemSuiteID)
        let sharedSecret = labeledExpand(prk: eaePrk, label: "shared_secret", info: kemContext, length: 32, suiteID: kemSuiteID)
        let pskIdHash = labeledExtract(salt: Data(), label: "psk_id_hash", input: Data(), suiteID: suiteID)
        let infoHash = labeledExtract(salt: Data(), label: "info_hash", input: hpkeInfo, suiteID: suiteID)
        let keyScheduleContext = Data([0]) + pskIdHash + infoHash
        let secret = labeledExtract(salt: sharedSecret, label: "secret", input: Data(), suiteID: suiteID)
        var key = labeledExpand(prk: secret, label: "key", info: keyScheduleContext, length: 32, suiteID: suiteID)
        var nonceData = labeledExpand(prk: secret, label: "base_nonce", info: keyScheduleContext, length: 12, suiteID: suiteID)
        defer {
            key.resetBytes(in: 0..<key.count)
            nonceData.resetBytes(in: 0..<nonceData.count)
        }
        let nonce = try AES.GCM.Nonce(data: nonceData)
        let encrypted = Data(ciphertext.prefix(ciphertext.count - 16))
        let tag = Data(ciphertext.suffix(16))
        let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: encrypted, tag: tag)
        return try AES.GCM.open(sealed, using: SymmetricKey(data: key), authenticating: authenticatedData)
    }

    static func decodeBase64URL(_ value: String, expectedLength: Int? = nil) throws -> Data {
        var standard = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        standard += String(repeating: "=", count: (4 - standard.count % 4) % 4)
        guard let decoded = Data(base64Encoded: standard),
              expectedLength.map({ decoded.count == $0 }) ?? true,
              encodeBase64URL(decoded) == value else {
            throw CantripNativeStorageError("base64url-value-invalid")
        }
        return decoded
    }

    static func encodeBase64URL(_ value: Data) -> String {
        value.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func associatedData(ownerId: String, clientId: String, revision: Int64) throws -> Data {
        let object: [String: Any] = [
            "component": "account-master-key",
            "field": "wrapped_master_key",
            "formatVersion": 1,
            "keyRevision": revision,
            "ownerId": ownerId,
            "rowId": clientId,
            "table": "encryption_client_principals"
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    private static func labeledExtract(salt: Data, label: String, input: Data, suiteID: Data) -> Data {
        hkdfExtract(salt: salt, input: Data("HPKE-v1".utf8) + suiteID + Data(label.utf8) + input)
    }

    private static func labeledExpand(prk: Data, label: String, info: Data, length: Int, suiteID: Data) -> Data {
        hkdfExpand(
            prk: prk,
            info: i2osp(length, length: 2) + Data("HPKE-v1".utf8) + suiteID + Data(label.utf8) + info,
            length: length
        )
    }

    private static func hkdfExtract(salt: Data, input: Data) -> Data {
        let key = SymmetricKey(data: salt.isEmpty ? Data(repeating: 0, count: 32) : salt)
        return Data(HMAC<SHA256>.authenticationCode(for: input, using: key))
    }

    private static func hkdfExpand(prk: Data, info: Data, length: Int) -> Data {
        let key = SymmetricKey(data: prk)
        var output = Data()
        var previous = Data()
        var counter: UInt8 = 1
        while output.count < length {
            previous = Data(HMAC<SHA256>.authenticationCode(for: previous + info + Data([counter]), using: key))
            output += previous
            counter &+= 1
        }
        return Data(output.prefix(length))
    }

    private static func i2osp(_ value: Int, length: Int) -> Data {
        var result = Data(repeating: 0, count: length)
        var remaining = value
        for index in stride(from: length - 1, through: 0, by: -1) {
            result[index] = UInt8(remaining & 0xff)
            remaining >>= 8
        }
        return result
    }
}
