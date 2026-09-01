import CryptoKit
import Foundation

let privateBytes = try CantripHPKE.decodeBase64URL(
    "GWNtSM7CrLBobff0RFc_ShU9pQNYlyleLZ9PF-4oz24",
    expectedLength: 32
)
let privateKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: privateBytes)
let recipientPublicKey = try CantripHPKE.decodeBase64URL(
    "BFm_YxDfIRPBuAS45UTQYjE8vzxylVItLMAVyHFU6lIiPo7gCNlzos45NP7Dn2vfhj1cxO-yYGwrBdlAmOzin1M",
    expectedLength: 65
)
let encapsulatedKey = try CantripHPKE.decodeBase64URL(
    "BGkT85BaSxTdeamdxr3Q7440QJ112z-MkNB2QpGOgju-WoxFFPNqLg5UJPeKwd1vBbR1KRDY0pIukEgUYVXbSCE",
    expectedLength: 65
)
let ciphertext = try CantripHPKE.decodeBase64URL(
    "98u_jm9tt8G_c3OwxvFx7fZOicyrsoK3La8XB1RRGsDneXd6gMaFpkb77z5BN98v",
    expectedLength: 48
)
let authenticatedData = try CantripHPKE.associatedData(
    ownerId: "owner-typescript-fixture",
    clientId: "principal-typescript-fixture",
    revision: 7
)
let opened = try CantripHPKE.open(
    privateKey: privateKey,
    recipientPublicKey: recipientPublicKey,
    encapsulatedKey: encapsulatedKey,
    ciphertext: ciphertext,
    authenticatedData: authenticatedData
)
precondition(opened == Data(repeating: 47, count: 32), "Swift HPKE did not open the TypeScript fixture")

let canonicalData = try CantripHPKE.associatedData(
    ownerId: "owner\nA",
    clientId: "principal-ß",
    revision: 4
)
let canonical = String(decoding: canonicalData, as: UTF8.self)
precondition(
    canonical == #"{"component":"account-master-key","field":"wrapped_master_key","formatVersion":1,"keyRevision":4,"ownerId":"owner\nA","rowId":"principal-ß","table":"encryption_client_principals"}"#,
    "Swift associated data does not match TypeScript canonical JSON"
)
