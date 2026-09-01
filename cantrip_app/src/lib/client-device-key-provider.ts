import {
  exportHpkePublicKey,
  generateHpkeKeyPair,
  unwrapAccountMasterKeyForClient,
} from "@cantrip/crypto";
import type {
  ClientMasterKeyWrapper,
  EncryptionPublicKey,
} from "@cantrip/protocol/encryption";

import {
  installationKeyAlias,
  type ClientDeviceKeyCustodyBackend,
} from "./installation-catalog";

export type ClientDeviceKeyProviderKind =
  "browser-webcrypto" | "capacitor-native" | "memory" | "tauri-native";

export type ClientDeviceKeyDescriptor = {
  createdAt: string;
  installationId: string;
  keyAlias: string;
  provider: ClientDeviceKeyCustodyBackend;
  publicKey: EncryptionPublicKey;
};

export type ClientDeviceKeyProviderErrorCode =
  "key-conflict" | "key-missing" | "key-store-unavailable" | "key-unusable";

export class ClientDeviceKeyProviderError extends Error {
  constructor(
    readonly code: ClientDeviceKeyProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClientDeviceKeyProviderError";
  }
}

export interface ClientDeviceKeyProvider {
  readonly backend: ClientDeviceKeyCustodyBackend;
  readonly kind: ClientDeviceKeyProviderKind;
  /** Atomically creates the installation key or returns the existing key. */
  create(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor>;
  /**
   * Replaces a cataloged key only after an external recovery method has
   * unlocked the existing account master key. Normal startup must never call
   * this operation for a lookup miss.
   */
  replaceMissing(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor>;
  inspect(keyAlias: string): Promise<ClientDeviceKeyDescriptor | null>;
  unwrapAccountMasterKey(input: {
    keyAlias: string;
    ownerId: string;
    wrapper: ClientMasterKeyWrapper;
  }): Promise<Uint8Array>;
}

type MemoryKeyRecord = {
  descriptor: ClientDeviceKeyDescriptor;
  keyPair: CryptoKeyPair;
};

function cloneDescriptor(
  descriptor: ClientDeviceKeyDescriptor,
): ClientDeviceKeyDescriptor {
  return { ...descriptor, publicKey: { ...descriptor.publicKey } };
}

export class MemoryClientDeviceKeyBackend {
  private readonly creationFlights = new Map<
    string,
    Promise<MemoryKeyRecord>
  >();
  private readonly records = new Map<string, MemoryKeyRecord>();

  async create(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor> {
    if (input.keyAlias !== installationKeyAlias(input.installationId)) {
      throw new ClientDeviceKeyProviderError(
        "key-conflict",
        "The key alias does not belong to the requested installation.",
      );
    }
    const existing = this.records.get(input.keyAlias);
    if (existing) {
      if (existing.descriptor.installationId !== input.installationId) {
        throw new ClientDeviceKeyProviderError(
          "key-conflict",
          "The key alias already belongs to another installation.",
        );
      }
      return cloneDescriptor(existing.descriptor);
    }

    const activeCreation = this.creationFlights.get(input.keyAlias);
    if (activeCreation) {
      return cloneDescriptor((await activeCreation).descriptor);
    }

    const creation = this.createRecord(input);
    this.creationFlights.set(input.keyAlias, creation);
    try {
      return cloneDescriptor((await creation).descriptor);
    } finally {
      if (this.creationFlights.get(input.keyAlias) === creation) {
        this.creationFlights.delete(input.keyAlias);
      }
    }
  }

  inspect(keyAlias: string): Promise<ClientDeviceKeyDescriptor | null> {
    const record = this.records.get(keyAlias);
    return Promise.resolve(record ? cloneDescriptor(record.descriptor) : null);
  }

  removeForTests(keyAlias: string): void {
    this.records.delete(keyAlias);
  }

  async unwrapAccountMasterKey(input: {
    keyAlias: string;
    ownerId: string;
    wrapper: ClientMasterKeyWrapper;
  }): Promise<Uint8Array> {
    const record = this.records.get(input.keyAlias);
    if (!record) {
      throw new ClientDeviceKeyProviderError(
        "key-missing",
        "The installation key is unavailable.",
      );
    }
    return unwrapAccountMasterKeyForClient({
      clientKeyPair: record.keyPair,
      ownerId: input.ownerId,
      wrapper: input.wrapper,
    });
  }

  private async createRecord(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<MemoryKeyRecord> {
    const keyPair = await generateHpkeKeyPair();
    const descriptor: ClientDeviceKeyDescriptor = {
      createdAt: input.createdAt ?? new Date().toISOString(),
      installationId: input.installationId,
      keyAlias: input.keyAlias,
      provider: "memory",
      publicKey: await exportHpkePublicKey(keyPair.publicKey),
    };
    const record = { descriptor, keyPair };
    this.records.set(input.keyAlias, record);
    return record;
  }
}

export class MemoryClientDeviceKeyProvider implements ClientDeviceKeyProvider {
  readonly backend = "memory" as const;
  readonly kind = "memory" as const;

  constructor(
    private readonly storage: MemoryClientDeviceKeyBackend = new MemoryClientDeviceKeyBackend(),
  ) {}

  create(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor> {
    return this.storage.create(input);
  }

  inspect(keyAlias: string): Promise<ClientDeviceKeyDescriptor | null> {
    return this.storage.inspect(keyAlias);
  }

  replaceMissing(input: {
    createdAt?: string;
    installationId: string;
    keyAlias: string;
  }): Promise<ClientDeviceKeyDescriptor> {
    return this.storage.create(input);
  }

  unwrapAccountMasterKey(input: {
    keyAlias: string;
    ownerId: string;
    wrapper: ClientMasterKeyWrapper;
  }): Promise<Uint8Array> {
    return this.storage.unwrapAccountMasterKey(input);
  }
}
