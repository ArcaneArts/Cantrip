import {
  clientMasterKeyWrapperSchema,
  passwordWrappedMasterKeySchema,
  workerComponentKeyGrantSchema,
  type ClientMasterKeyWrapper,
  type EncryptionAssociatedData,
  type EncryptionComponentScope,
  type EncryptionPublicKey,
  type PasswordKdfParameters,
  type PasswordWrappedMasterKey,
  type WorkerComponentKeyGrant,
} from "@cantrip/protocol/encryption";

import {
  bytesEqual,
  clearSensitiveBytes,
  randomBytes,
  requireByteLength,
} from "./bytes.js";
import {
  exportHpkePublicKey,
  unwrapKeyForRecipient,
  wrapKeyForRecipient,
} from "./hpke.js";
import { createPasswordKdfParameters, derivePasswordKey } from "./kdf.js";
import { decryptPayload, encryptPayload } from "./payload.js";

export function generateAccountMasterKey(): Uint8Array {
  return randomBytes(32);
}

export function passwordMasterKeyAssociatedData(
  ownerId: string,
  masterKeyRevision: number,
): EncryptionAssociatedData {
  return {
    ownerId,
    component: "account-master-key",
    table: "account_encryption_profiles",
    rowId: ownerId,
    field: "password_wrapped_master_key",
    formatVersion: 1,
    keyRevision: masterKeyRevision,
  };
}

export function clientMasterKeyAssociatedData(input: {
  ownerId: string;
  clientId: string;
  masterKeyRevision: number;
}): EncryptionAssociatedData {
  return {
    ownerId: input.ownerId,
    component: "account-master-key",
    table: "encryption_client_principals",
    rowId: input.clientId,
    field: "wrapped_master_key",
    formatVersion: 1,
    keyRevision: input.masterKeyRevision,
  };
}

export function workerComponentKeyAssociatedData(input: {
  ownerId: string;
  workerId: string;
  component: Exclude<EncryptionComponentScope, "account-master-key">;
  keyRevision: number;
}): EncryptionAssociatedData {
  return {
    ownerId: input.ownerId,
    component: input.component,
    table: "encryption_worker_grants",
    rowId: input.workerId,
    field: "wrapped_component_key",
    formatVersion: 1,
    keyRevision: input.keyRevision,
  };
}

export async function wrapAccountMasterKeyWithPassword(input: {
  password: string;
  ownerId: string;
  accountMasterKey: Uint8Array;
  masterKeyRevision: number;
  kdf?: PasswordKdfParameters;
}): Promise<PasswordWrappedMasterKey> {
  requireByteLength(input.accountMasterKey, 32, "Account Master Key");
  const kdf = input.kdf ?? createPasswordKdfParameters();
  const passwordKey = await derivePasswordKey(input.password, kdf);
  try {
    const associatedData = passwordMasterKeyAssociatedData(
      input.ownerId,
      input.masterKeyRevision,
    );
    const envelope = await encryptPayload({
      key: passwordKey,
      plaintext: input.accountMasterKey,
      associatedData,
    });
    const verification = await decryptPayload({
      key: passwordKey,
      envelope,
      associatedData,
    });
    try {
      if (!bytesEqual(input.accountMasterKey, verification)) {
        throw new Error("Password wrapper verification failed.");
      }
    } finally {
      clearSensitiveBytes(verification);
    }
    return passwordWrappedMasterKeySchema.parse({
      version: 1,
      purpose: "password-wrapped-account-master-key",
      masterKeyRevision: input.masterKeyRevision,
      kdf,
      envelope,
    });
  } finally {
    clearSensitiveBytes(passwordKey);
  }
}

export async function unwrapAccountMasterKeyWithPassword(input: {
  password: string;
  ownerId: string;
  wrapper: PasswordWrappedMasterKey;
}): Promise<Uint8Array> {
  const wrapper = passwordWrappedMasterKeySchema.parse(input.wrapper);
  const passwordKey = await derivePasswordKey(input.password, wrapper.kdf);
  try {
    return await decryptPayload({
      key: passwordKey,
      envelope: wrapper.envelope,
      associatedData: passwordMasterKeyAssociatedData(
        input.ownerId,
        wrapper.masterKeyRevision,
      ),
    });
  } finally {
    clearSensitiveBytes(passwordKey);
  }
}

export async function wrapAccountMasterKeyForClient(input: {
  ownerId: string;
  clientId: string;
  accountMasterKey: Uint8Array;
  masterKeyRevision: number;
  clientPublicKey: EncryptionPublicKey;
}): Promise<ClientMasterKeyWrapper> {
  return clientMasterKeyWrapperSchema.parse({
    version: 1,
    purpose: "client-account-master-key",
    clientId: input.clientId,
    masterKeyRevision: input.masterKeyRevision,
    envelope: await wrapKeyForRecipient({
      key: input.accountMasterKey,
      recipientPublicKey: input.clientPublicKey,
      associatedData: clientMasterKeyAssociatedData(input),
    }),
  });
}

export async function unwrapAccountMasterKeyForClient(input: {
  ownerId: string;
  wrapper: ClientMasterKeyWrapper;
  clientKeyPair: CryptoKeyPair;
}): Promise<Uint8Array> {
  const wrapper = clientMasterKeyWrapperSchema.parse(input.wrapper);
  return unwrapKeyForRecipient({
    envelope: wrapper.envelope,
    recipientKeyPair: input.clientKeyPair,
    associatedData: clientMasterKeyAssociatedData({
      ownerId: input.ownerId,
      clientId: wrapper.clientId,
      masterKeyRevision: wrapper.masterKeyRevision,
    }),
  });
}

export async function wrapComponentKeyForWorker(input: {
  ownerId: string;
  workerId: string;
  component: Exclude<EncryptionComponentScope, "account-master-key">;
  componentKey: Uint8Array;
  keyRevision: number;
  workerPublicKey: EncryptionPublicKey;
}): Promise<WorkerComponentKeyGrant> {
  return workerComponentKeyGrantSchema.parse({
    version: 1,
    purpose: "worker-component-key",
    workerId: input.workerId,
    component: input.component,
    keyRevision: input.keyRevision,
    envelope: await wrapKeyForRecipient({
      key: input.componentKey,
      recipientPublicKey: input.workerPublicKey,
      associatedData: workerComponentKeyAssociatedData(input),
    }),
  });
}

export async function unwrapComponentKeyForWorker(input: {
  ownerId: string;
  grant: WorkerComponentKeyGrant;
  workerKeyPair: CryptoKeyPair;
}): Promise<Uint8Array> {
  const grant = workerComponentKeyGrantSchema.parse(input.grant);
  return unwrapKeyForRecipient({
    envelope: grant.envelope,
    recipientKeyPair: input.workerKeyPair,
    associatedData: workerComponentKeyAssociatedData({
      ownerId: input.ownerId,
      workerId: grant.workerId,
      component: grant.component,
      keyRevision: grant.keyRevision,
    }),
  });
}

export async function publicKeyForPair(
  keyPair: CryptoKeyPair,
): Promise<EncryptionPublicKey> {
  return exportHpkePublicKey(keyPair.publicKey);
}
