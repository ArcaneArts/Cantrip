use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hpke::{
    aead::AesGcm256,
    kdf::HkdfSha256,
    kem::{DhP256HkdfSha256, Kem as KemTrait},
    single_shot_open, Deserializable, OpModeR, Serializable,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const CATALOG_SCHEMA_VERSION: i64 = 1;
const DEVICE_KEY_VERSION: i64 = 1;
const HPKE_INFO: &[u8] = b"cantrip:e2ee:hpke-key-wrap:v1";
const KEYRING_SERVICE: &str = "art.cantrip.installation.hpke.v1";

type NativeKem = DhP256HkdfSha256;

trait DeviceSecretStore: Send + Sync {
    fn get(&self, key_alias: &str) -> Result<Option<Vec<u8>>, String>;
    fn put(&self, key_alias: &str, secret: &[u8]) -> Result<(), String>;
}

struct KeyringDeviceSecretStore;

impl DeviceSecretStore for KeyringDeviceSecretStore {
    fn get(&self, key_alias: &str) -> Result<Option<Vec<u8>>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key_alias)
            .map_err(|_| "native-key-store-unavailable".to_owned())?;
        match entry.get_secret() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("native-key-store-unavailable".to_owned()),
        }
    }

    fn put(&self, key_alias: &str, secret: &[u8]) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key_alias)
            .map_err(|_| "native-key-store-unavailable".to_owned())?;
        entry
            .set_secret(secret)
            .map_err(|_| "native-key-store-unavailable".to_owned())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallationProfile {
    created_at: String,
    installation_id: String,
    schema_version: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeEncryptionPublicKey {
    algorithm: String,
    format: String,
    value: String,
    version: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallationDeviceKey {
    created_at: String,
    installation_id: String,
    key_alias: String,
    provider: String,
    public_key: NativeEncryptionPublicKey,
    status: String,
    version: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallationAccountBinding {
    grant_revision: i64,
    key_alias: String,
    master_key_revision: i64,
    owner_id: String,
    principal_id: String,
    server_id: String,
    updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallationMigration {
    completed_at: Option<String>,
    migration_id: String,
    started_at: Option<String>,
    state: String,
    verification_state: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallationCatalogSnapshot {
    account_bindings: Vec<NativeInstallationAccountBinding>,
    device_keys: Vec<NativeInstallationDeviceKey>,
    installation: Option<NativeInstallationProfile>,
    migrations: Vec<NativeInstallationMigration>,
    revision: i64,
    schema_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCatalogTransactionRequest {
    expected_revision: i64,
    operations: Vec<NativeCatalogOperation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "kebab-case", tag = "type")]
enum NativeCatalogOperation {
    CreateInstallation {
        profile: NativeInstallationProfile,
    },
    PutAccountBinding {
        binding: NativeInstallationAccountBinding,
    },
    PutDeviceKey {
        device_key: NativeInstallationDeviceKey,
    },
    PutMigration {
        migration: NativeInstallationMigration,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallationStorageStatus {
    catalog_path: String,
    key_alias_format: &'static str,
    provider: &'static str,
    schema_version: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeInstallationStorageError {
    code: String,
    message: &'static str,
    retryable: bool,
}

impl From<String> for NativeInstallationStorageError {
    fn from(code: String) -> Self {
        let retryable = code.contains("unavailable") || code == "installation-catalog-conflict";
        let message = match code.as_str() {
            "installation-account-binding-invalid" => {
                "The installation account binding is invalid."
            }
            "installation-catalog-conflict" => {
                "The installation catalog changed in another application window."
            }
            "installation-catalog-corrupt" => "The installation catalog cannot be read safely.",
            "installation-catalog-version-unsupported" => {
                "The installation catalog was created by an unsupported newer version."
            }
            "installation-catalog-path-unavailable" | "installation-catalog-unavailable" => {
                "The installation catalog is unavailable."
            }
            "installation-conflict" => {
                "The installation catalog already belongs to another installation."
            }
            "installation-device-key-invalid" => "The installation key metadata is invalid.",
            "installation-migration-invalid" => "The installation migration record is invalid.",
            "installation-missing" => "The installation profile is missing.",
            "installation-profile-invalid" => "The installation profile is invalid.",
            "native-device-key-alias-invalid" => {
                "The native key alias does not belong to this installation."
            }
            "native-device-key-conflict" | "native-device-key-metadata-mismatch" => {
                "The native installation key conflicts with the catalog."
            }
            "native-device-key-missing" => "The native installation key is missing.",
            "native-device-key-invalid" => "The native installation key is invalid.",
            "native-key-store-unavailable" => {
                "The operating system secure-key store is unavailable."
            }
            "client-master-key-decryption-failed" => {
                "The native installation key cannot unlock this account binding."
            }
            "native-storage-task-failed" => "The native storage task failed.",
            _ => "Native installation storage rejected the operation.",
        };
        Self {
            code,
            message,
            retryable,
        }
    }
}

pub struct SensitiveBytes(Zeroizing<Vec<u8>>);

impl Serialize for SensitiveBytes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.collect_seq(self.0.iter())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDeviceKeyCreateInput {
    created_at: Option<String>,
    installation_id: String,
    key_alias: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDeviceKeyDescriptor {
    created_at: String,
    installation_id: String,
    key_alias: String,
    provider: &'static str,
    public_key: NativeEncryptionPublicKey,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDeviceKeySecret {
    created_at: String,
    installation_id: String,
    key_alias: String,
    private_key: String,
    version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMasterKeyUnwrapInput {
    key_alias: String,
    owner_id: String,
    wrapper: NativeClientMasterKeyWrapper,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeClientMasterKeyWrapper {
    client_id: String,
    envelope: NativeHpkeEnvelope,
    master_key_revision: i64,
    purpose: String,
    version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeHpkeEnvelope {
    algorithm: String,
    ciphertext: String,
    encapsulated_key: String,
    suite: NativeHpkeSuite,
    version: i64,
}

#[derive(Debug, Deserialize)]
struct NativeHpkeSuite {
    aead: String,
    kdf: String,
    kem: String,
    mode: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientMasterKeyAssociatedData<'a> {
    component: &'static str,
    field: &'static str,
    format_version: i64,
    key_revision: i64,
    owner_id: &'a str,
    row_id: &'a str,
    table: &'static str,
}

pub struct NativeInstallationStorage {
    access: Mutex<()>,
    catalog_path: PathBuf,
    initialization_error: Option<String>,
    secrets: Arc<dyn DeviceSecretStore>,
}

impl NativeInstallationStorage {
    #[cfg(test)]
    fn open(catalog_path: PathBuf, secrets: Arc<dyn DeviceSecretStore>) -> Result<Self, String> {
        let storage = Self::deferred(catalog_path, secrets);
        storage.connection()?;
        Ok(storage)
    }

    fn deferred(catalog_path: PathBuf, secrets: Arc<dyn DeviceSecretStore>) -> Self {
        Self {
            access: Mutex::new(()),
            catalog_path,
            initialization_error: None,
            secrets,
        }
    }

    fn unavailable(code: String, secrets: Arc<dyn DeviceSecretStore>) -> Self {
        Self {
            access: Mutex::new(()),
            catalog_path: PathBuf::new(),
            initialization_error: Some(code),
            secrets,
        }
    }

    fn connection(&self) -> Result<Connection, String> {
        if let Some(error) = self.initialization_error.as_ref() {
            return Err(error.clone());
        }
        prepare_catalog_parent(&self.catalog_path)?;
        let connection = Connection::open(&self.catalog_path)
            .map_err(|_| "installation-catalog-unavailable".to_owned())?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;",
            )
            .map_err(|_| "installation-catalog-corrupt".to_owned())?;
        initialize_schema(&connection)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.catalog_path, fs::Permissions::from_mode(0o600))
                .map_err(|_| "installation-catalog-unavailable".to_owned())?;
        }
        Ok(connection)
    }

    fn snapshot(&self) -> Result<NativeInstallationCatalogSnapshot, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "installation-catalog-unavailable".to_owned())?;
        snapshot_from_connection(&self.connection()?)
    }

    fn apply_transaction(
        &self,
        request: NativeCatalogTransactionRequest,
    ) -> Result<NativeInstallationCatalogSnapshot, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "installation-catalog-unavailable".to_owned())?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| "installation-catalog-unavailable".to_owned())?;
        let revision = catalog_revision(&transaction)?;
        if revision != request.expected_revision {
            return Err("installation-catalog-conflict".to_owned());
        }
        for operation in request.operations.iter() {
            self.apply_operation(&transaction, operation)?;
        }
        if !request.operations.is_empty() {
            transaction
                .execute(
                    "UPDATE catalog_meta SET revision = revision + 1 WHERE singleton_id = 1",
                    [],
                )
                .map_err(|_| "installation-catalog-unavailable".to_owned())?;
        }
        transaction
            .commit()
            .map_err(|_| "installation-catalog-unavailable".to_owned())?;
        snapshot_from_connection(&connection)
    }

    fn apply_operation(
        &self,
        transaction: &Transaction<'_>,
        operation: &NativeCatalogOperation,
    ) -> Result<(), String> {
        match operation {
            NativeCatalogOperation::CreateInstallation { profile } => {
                validate_profile(profile)?;
                let existing: Option<String> = transaction
                    .query_row(
                        "SELECT installation_id FROM installation WHERE singleton_id = 1",
                        [],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|_| "installation-catalog-unavailable".to_owned())?;
                if let Some(existing) = existing {
                    return if existing == profile.installation_id {
                        Ok(())
                    } else {
                        Err("installation-conflict".to_owned())
                    };
                }
                transaction
                    .execute(
                        "INSERT INTO installation (singleton_id, installation_id, created_at, schema_version) VALUES (1, ?1, ?2, ?3)",
                        params![profile.installation_id, profile.created_at, profile.schema_version],
                    )
                    .map_err(|_| "installation-catalog-unavailable".to_owned())?;
                Ok(())
            }
            NativeCatalogOperation::PutDeviceKey { device_key } => {
                validate_device_key(transaction, device_key)?;
                let descriptor = self
                    .inspect_key_unlocked(&device_key.key_alias)?
                    .ok_or_else(|| "native-device-key-missing".to_owned())?;
                if descriptor.created_at != device_key.created_at
                    || descriptor.installation_id != device_key.installation_id
                    || descriptor.provider != device_key.provider
                    || descriptor.public_key != device_key.public_key
                {
                    return Err("native-device-key-metadata-mismatch".to_owned());
                }
                transaction
                    .execute(
                        "INSERT INTO device_key (key_alias, installation_id, public_key_json, provider, created_at, status, version) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(key_alias) DO UPDATE SET public_key_json = excluded.public_key_json, provider = excluded.provider, status = excluded.status",
                        params![
                            device_key.key_alias,
                            device_key.installation_id,
                            serde_json::to_string(&device_key.public_key).map_err(|_| "installation-device-key-invalid".to_owned())?,
                            device_key.provider,
                            device_key.created_at,
                            device_key.status,
                            device_key.version,
                        ],
                    )
                    .map_err(|_| "installation-catalog-unavailable".to_owned())?;
                Ok(())
            }
            NativeCatalogOperation::PutAccountBinding { binding } => {
                validate_binding(transaction, binding)?;
                transaction
                    .execute(
                        "INSERT INTO account_binding (server_id, owner_id, principal_id, key_alias, grant_revision, master_key_revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(server_id, owner_id) DO UPDATE SET principal_id = excluded.principal_id, key_alias = excluded.key_alias, grant_revision = excluded.grant_revision, master_key_revision = excluded.master_key_revision, updated_at = excluded.updated_at",
                        params![binding.server_id, binding.owner_id, binding.principal_id, binding.key_alias, binding.grant_revision, binding.master_key_revision, binding.updated_at],
                    )
                    .map_err(|_| "installation-catalog-unavailable".to_owned())?;
                Ok(())
            }
            NativeCatalogOperation::PutMigration { migration } => {
                validate_migration(migration)?;
                transaction
                    .execute(
                        "INSERT INTO migration (migration_id, started_at, completed_at, state, verification_state) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(migration_id) DO UPDATE SET started_at = excluded.started_at, completed_at = excluded.completed_at, state = excluded.state, verification_state = excluded.verification_state",
                        params![migration.migration_id, migration.started_at, migration.completed_at, migration.state, migration.verification_state],
                    )
                    .map_err(|_| "installation-catalog-unavailable".to_owned())?;
                Ok(())
            }
        }
    }

    fn create_key(
        &self,
        input: NativeDeviceKeyCreateInput,
    ) -> Result<NativeDeviceKeyDescriptor, String> {
        validate_installation_id(&input.installation_id)?;
        if input.key_alias != installation_key_alias(&input.installation_id) {
            return Err("native-device-key-alias-invalid".to_owned());
        }
        if let Some(created_at) = input.created_at.as_deref() {
            validate_timestamp(created_at)?;
        }
        let _guard = self
            .access
            .lock()
            .map_err(|_| "native-key-store-unavailable".to_owned())?;
        let connection = self.connection()?;
        let installation: Option<String> = connection
            .query_row(
                "SELECT installation_id FROM installation WHERE singleton_id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "installation-catalog-unavailable".to_owned())?;
        if installation.as_deref() != Some(input.installation_id.as_str()) {
            return Err("installation-missing".to_owned());
        }
        if let Some(descriptor) = self.inspect_key_unlocked(&input.key_alias)? {
            return if descriptor.installation_id == input.installation_id {
                Ok(descriptor)
            } else {
                Err("native-device-key-conflict".to_owned())
            };
        }

        let (private_key, public_key) = NativeKem::gen_keypair();
        let mut private_key_bytes = private_key.to_bytes().to_vec();
        let created_at = input.created_at.unwrap_or_else(current_timestamp);
        let mut secret_record = NativeDeviceKeySecret {
            created_at: created_at.clone(),
            installation_id: input.installation_id.clone(),
            key_alias: input.key_alias.clone(),
            private_key: URL_SAFE_NO_PAD.encode(&private_key_bytes),
            version: DEVICE_KEY_VERSION,
        };
        let mut serialized = serde_json::to_vec(&secret_record)
            .map_err(|_| "native-device-key-invalid".to_owned())?;
        let result = self.secrets.put(&input.key_alias, &serialized);
        serialized.zeroize();
        private_key_bytes.zeroize();
        secret_record.private_key.zeroize();
        result?;
        Ok(NativeDeviceKeyDescriptor {
            created_at,
            installation_id: input.installation_id,
            key_alias: input.key_alias,
            provider: native_key_provider(),
            public_key: public_key_metadata(public_key.to_bytes().as_slice()),
        })
    }

    fn inspect_key(&self, key_alias: &str) -> Result<Option<NativeDeviceKeyDescriptor>, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "native-key-store-unavailable".to_owned())?;
        self.inspect_key_unlocked(key_alias)
    }

    fn inspect_key_unlocked(
        &self,
        key_alias: &str,
    ) -> Result<Option<NativeDeviceKeyDescriptor>, String> {
        validate_identifier(key_alias)?;
        let Some(mut secret) = self.secrets.get(key_alias)? else {
            return Ok(None);
        };
        let result = parse_key_secret(&secret, key_alias);
        secret.zeroize();
        result.map(Some)
    }

    fn unwrap_account_master_key(
        &self,
        input: NativeMasterKeyUnwrapInput,
    ) -> Result<SensitiveBytes, String> {
        validate_wrapper(&input)?;
        let _guard = self
            .access
            .lock()
            .map_err(|_| "native-key-store-unavailable".to_owned())?;
        let Some(mut secret) = self.secrets.get(&input.key_alias)? else {
            return Err("native-device-key-missing".to_owned());
        };
        let mut record: NativeDeviceKeySecret =
            serde_json::from_slice(&secret).map_err(|_| "native-device-key-invalid".to_owned())?;
        secret.zeroize();
        validate_secret_record(&record, &input.key_alias)?;
        let mut private_key_bytes = decode_base64url(&record.private_key, 32)?;
        record.private_key.zeroize();
        let private_key = <NativeKem as KemTrait>::PrivateKey::from_bytes(&private_key_bytes)
            .map_err(|_| "native-device-key-invalid".to_owned())?;
        private_key_bytes.zeroize();
        let encapsulated_bytes = decode_base64url(&input.wrapper.envelope.encapsulated_key, 65)?;
        let encapsulated_key =
            <NativeKem as KemTrait>::EncappedKey::from_bytes(&encapsulated_bytes)
                .map_err(|_| "client-master-key-wrapper-invalid".to_owned())?;
        let ciphertext = decode_base64url(&input.wrapper.envelope.ciphertext, 48)?;
        let associated_data = serde_json::to_vec(&ClientMasterKeyAssociatedData {
            component: "account-master-key",
            field: "wrapped_master_key",
            format_version: 1,
            key_revision: input.wrapper.master_key_revision,
            owner_id: &input.owner_id,
            row_id: &input.wrapper.client_id,
            table: "encryption_client_principals",
        })
        .map_err(|_| "client-master-key-wrapper-invalid".to_owned())?;
        let mut plaintext = single_shot_open::<AesGcm256, HkdfSha256, NativeKem>(
            &OpModeR::Base,
            &private_key,
            &encapsulated_key,
            HPKE_INFO,
            &ciphertext,
            &associated_data,
        )
        .map_err(|_| "client-master-key-decryption-failed".to_owned())?;
        if plaintext.len() != 32 {
            plaintext.zeroize();
            return Err("client-master-key-decryption-failed".to_owned());
        }
        Ok(SensitiveBytes(Zeroizing::new(plaintext)))
    }
}

pub fn build(app: &tauri::App) -> NativeInstallationStorage {
    let secrets: Arc<dyn DeviceSecretStore> = Arc::new(KeyringDeviceSecretStore);
    match app.path().app_local_data_dir() {
        Ok(root) => NativeInstallationStorage::deferred(
            root.join("installation").join("v1").join("catalog.sqlite3"),
            secrets,
        ),
        Err(_) => NativeInstallationStorage::unavailable(
            "installation-catalog-path-unavailable".to_owned(),
            secrets,
        ),
    }
}

#[tauri::command]
pub fn native_installation_storage_status(
    storage: State<'_, Arc<NativeInstallationStorage>>,
) -> Result<NativeInstallationStorageStatus, NativeInstallationStorageError> {
    if let Some(error) = storage.initialization_error.as_ref() {
        return Err(error.clone().into());
    }
    Ok(NativeInstallationStorageStatus {
        catalog_path: storage.catalog_path.to_string_lossy().into_owned(),
        key_alias_format: "cantrip.installation.v1.<installation-uuid>",
        provider: native_key_provider(),
        schema_version: CATALOG_SCHEMA_VERSION,
    })
}

#[tauri::command]
pub async fn read_native_installation_catalog(
    storage: State<'_, Arc<NativeInstallationStorage>>,
) -> Result<NativeInstallationCatalogSnapshot, NativeInstallationStorageError> {
    let storage = Arc::clone(storage.inner());
    run_blocking(move || storage.snapshot()).await
}

#[tauri::command]
pub async fn apply_native_installation_catalog_transaction(
    request: NativeCatalogTransactionRequest,
    storage: State<'_, Arc<NativeInstallationStorage>>,
) -> Result<NativeInstallationCatalogSnapshot, NativeInstallationStorageError> {
    let storage = Arc::clone(storage.inner());
    run_blocking(move || storage.apply_transaction(request)).await
}

#[tauri::command]
pub async fn create_native_installation_key(
    input: NativeDeviceKeyCreateInput,
    storage: State<'_, Arc<NativeInstallationStorage>>,
) -> Result<NativeDeviceKeyDescriptor, NativeInstallationStorageError> {
    let storage = Arc::clone(storage.inner());
    run_blocking(move || storage.create_key(input)).await
}

#[tauri::command]
pub async fn inspect_native_installation_key(
    key_alias: String,
    storage: State<'_, Arc<NativeInstallationStorage>>,
) -> Result<Option<NativeDeviceKeyDescriptor>, NativeInstallationStorageError> {
    let storage = Arc::clone(storage.inner());
    run_blocking(move || storage.inspect_key(&key_alias)).await
}

#[tauri::command]
pub async fn unwrap_native_account_master_key(
    input: NativeMasterKeyUnwrapInput,
    storage: State<'_, Arc<NativeInstallationStorage>>,
) -> Result<SensitiveBytes, NativeInstallationStorageError> {
    let storage = Arc::clone(storage.inner());
    run_blocking(move || storage.unwrap_account_master_key(input)).await
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, NativeInstallationStorageError> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| NativeInstallationStorageError::from("native-storage-task-failed".to_owned()))?
        .map_err(Into::into)
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    let schema_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|_| "installation-catalog-corrupt".to_owned())?;
    if schema_version > CATALOG_SCHEMA_VERSION {
        return Err("installation-catalog-version-unsupported".to_owned());
    }
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS catalog_meta (
              singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
              schema_version INTEGER NOT NULL,
              revision INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO catalog_meta (singleton_id, schema_version, revision)
              VALUES (1, 1, 0);
            CREATE TABLE IF NOT EXISTS installation (
              singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
              installation_id TEXT NOT NULL UNIQUE,
              created_at TEXT NOT NULL,
              schema_version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS device_key (
              key_alias TEXT PRIMARY KEY,
              installation_id TEXT NOT NULL,
              public_key_json TEXT NOT NULL,
              provider TEXT NOT NULL,
              created_at TEXT NOT NULL,
              status TEXT NOT NULL,
              version INTEGER NOT NULL,
              FOREIGN KEY (installation_id) REFERENCES installation(installation_id)
            );
            CREATE TABLE IF NOT EXISTS account_binding (
              server_id TEXT NOT NULL,
              owner_id TEXT NOT NULL,
              principal_id TEXT NOT NULL,
              key_alias TEXT NOT NULL,
              grant_revision INTEGER NOT NULL,
              master_key_revision INTEGER NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (server_id, owner_id),
              FOREIGN KEY (key_alias) REFERENCES device_key(key_alias)
            );
            CREATE TABLE IF NOT EXISTS migration (
              migration_id TEXT PRIMARY KEY,
              started_at TEXT,
              completed_at TEXT,
              state TEXT NOT NULL,
              verification_state TEXT
            );
            PRAGMA user_version = 1;
            ",
        )
        .map_err(|_| "installation-catalog-corrupt".to_owned())?;
    Ok(())
}

fn snapshot_from_connection(
    connection: &Connection,
) -> Result<NativeInstallationCatalogSnapshot, String> {
    let revision = catalog_revision(connection)?;
    let installation = connection
        .query_row(
            "SELECT created_at, installation_id, schema_version FROM installation WHERE singleton_id = 1",
            [],
            |row| {
                Ok(NativeInstallationProfile {
                    created_at: row.get(0)?,
                    installation_id: row.get(1)?,
                    schema_version: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;

    let mut device_statement = connection
        .prepare("SELECT created_at, installation_id, key_alias, provider, public_key_json, status, version FROM device_key ORDER BY key_alias")
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;
    let device_keys = device_statement
        .query_map([], |row| {
            let public_key_json: String = row.get(4)?;
            let public_key = serde_json::from_str(&public_key_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    public_key_json.len(),
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(NativeInstallationDeviceKey {
                created_at: row.get(0)?,
                installation_id: row.get(1)?,
                key_alias: row.get(2)?,
                provider: row.get(3)?,
                public_key,
                status: row.get(5)?,
                version: row.get(6)?,
            })
        })
        .map_err(|_| "installation-catalog-unavailable".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;

    let mut binding_statement = connection
        .prepare("SELECT grant_revision, key_alias, master_key_revision, owner_id, principal_id, server_id, updated_at FROM account_binding ORDER BY server_id, owner_id")
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;
    let account_bindings = binding_statement
        .query_map([], |row| {
            Ok(NativeInstallationAccountBinding {
                grant_revision: row.get(0)?,
                key_alias: row.get(1)?,
                master_key_revision: row.get(2)?,
                owner_id: row.get(3)?,
                principal_id: row.get(4)?,
                server_id: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|_| "installation-catalog-unavailable".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;

    let mut migration_statement = connection
        .prepare("SELECT completed_at, migration_id, started_at, state, verification_state FROM migration ORDER BY migration_id")
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;
    let migrations = migration_statement
        .query_map([], |row| {
            Ok(NativeInstallationMigration {
                completed_at: row.get(0)?,
                migration_id: row.get(1)?,
                started_at: row.get(2)?,
                state: row.get(3)?,
                verification_state: row.get(4)?,
            })
        })
        .map_err(|_| "installation-catalog-unavailable".to_owned())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;

    Ok(NativeInstallationCatalogSnapshot {
        account_bindings,
        device_keys,
        installation,
        migrations,
        revision,
        schema_version: CATALOG_SCHEMA_VERSION,
    })
}

fn catalog_revision(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT revision FROM catalog_meta WHERE singleton_id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| "installation-catalog-unavailable".to_owned())
}

fn validate_profile(profile: &NativeInstallationProfile) -> Result<(), String> {
    validate_installation_id(&profile.installation_id)?;
    validate_timestamp(&profile.created_at)?;
    if profile.schema_version != CATALOG_SCHEMA_VERSION {
        return Err("installation-profile-invalid".to_owned());
    }
    Ok(())
}

fn validate_device_key(
    transaction: &Transaction<'_>,
    device_key: &NativeInstallationDeviceKey,
) -> Result<(), String> {
    validate_timestamp(&device_key.created_at)?;
    if device_key.version != DEVICE_KEY_VERSION
        || device_key.provider != native_key_provider()
        || !matches!(device_key.status.as_str(), "active" | "retired")
        || device_key.key_alias != installation_key_alias(&device_key.installation_id)
        || device_key.public_key.version != 1
        || device_key.public_key.algorithm != "P-256"
        || device_key.public_key.format != "raw"
        || decode_base64url(&device_key.public_key.value, 65).is_err()
    {
        return Err("installation-device-key-invalid".to_owned());
    }
    let installation_id: Option<String> = transaction
        .query_row(
            "SELECT installation_id FROM installation WHERE singleton_id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;
    if installation_id.as_deref() != Some(device_key.installation_id.as_str()) {
        return Err("installation-device-key-invalid".to_owned());
    }
    Ok(())
}

fn validate_binding(
    transaction: &Transaction<'_>,
    binding: &NativeInstallationAccountBinding,
) -> Result<(), String> {
    validate_identifier(&binding.server_id)?;
    validate_identifier(&binding.owner_id)?;
    validate_identifier(&binding.principal_id)?;
    validate_identifier(&binding.key_alias)?;
    validate_timestamp(&binding.updated_at)?;
    if binding.grant_revision < 1 || binding.master_key_revision < 1 {
        return Err("installation-account-binding-invalid".to_owned());
    }
    let active: Option<i64> = transaction
        .query_row(
            "SELECT 1 FROM device_key WHERE key_alias = ?1 AND status = 'active'",
            params![binding.key_alias],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "installation-catalog-unavailable".to_owned())?;
    if active.is_none() {
        return Err("installation-account-binding-invalid".to_owned());
    }
    Ok(())
}

fn validate_migration(migration: &NativeInstallationMigration) -> Result<(), String> {
    validate_identifier(&migration.migration_id)?;
    if let Some(started_at) = migration.started_at.as_deref() {
        validate_timestamp(started_at)?;
    }
    if let Some(completed_at) = migration.completed_at.as_deref() {
        validate_timestamp(completed_at)?;
    }
    if !matches!(
        migration.state.as_str(),
        "failed" | "in-progress" | "pending" | "verified"
    ) {
        return Err("installation-migration-invalid".to_owned());
    }
    if migration.state == "verified"
        && (migration.started_at.is_none()
            || migration.completed_at.is_none()
            || migration
                .verification_state
                .as_deref()
                .unwrap_or_default()
                .is_empty())
    {
        return Err("installation-migration-invalid".to_owned());
    }
    Ok(())
}

fn validate_wrapper(input: &NativeMasterKeyUnwrapInput) -> Result<(), String> {
    validate_identifier(&input.key_alias)?;
    validate_identifier(&input.owner_id)?;
    validate_identifier(&input.wrapper.client_id)?;
    if input.wrapper.version != 1
        || input.wrapper.purpose != "client-account-master-key"
        || input.wrapper.master_key_revision < 1
        || input.wrapper.envelope.version != 1
        || input.wrapper.envelope.algorithm != "HPKE-RFC9180"
        || input.wrapper.envelope.suite.mode != "base"
        || input.wrapper.envelope.suite.kem != "DHKEM(P-256,HKDF-SHA256)"
        || input.wrapper.envelope.suite.kdf != "HKDF-SHA256"
        || input.wrapper.envelope.suite.aead != "AES-256-GCM"
    {
        return Err("client-master-key-wrapper-invalid".to_owned());
    }
    Ok(())
}

fn parse_key_secret(
    secret: &[u8],
    expected_key_alias: &str,
) -> Result<NativeDeviceKeyDescriptor, String> {
    let mut record: NativeDeviceKeySecret =
        serde_json::from_slice(secret).map_err(|_| "native-device-key-invalid".to_owned())?;
    validate_secret_record(&record, expected_key_alias)?;
    let mut private_key_bytes = decode_base64url(&record.private_key, 32)?;
    record.private_key.zeroize();
    let private_key = <NativeKem as KemTrait>::PrivateKey::from_bytes(&private_key_bytes)
        .map_err(|_| "native-device-key-invalid".to_owned())?;
    private_key_bytes.zeroize();
    let public_key = NativeKem::sk_to_pk(&private_key);
    Ok(NativeDeviceKeyDescriptor {
        created_at: record.created_at,
        installation_id: record.installation_id,
        key_alias: record.key_alias,
        provider: native_key_provider(),
        public_key: public_key_metadata(public_key.to_bytes().as_slice()),
    })
}

fn validate_secret_record(
    record: &NativeDeviceKeySecret,
    expected_key_alias: &str,
) -> Result<(), String> {
    validate_installation_id(&record.installation_id)?;
    validate_timestamp(&record.created_at)?;
    if record.version != DEVICE_KEY_VERSION
        || record.key_alias != expected_key_alias
        || record.key_alias != installation_key_alias(&record.installation_id)
    {
        return Err("native-device-key-invalid".to_owned());
    }
    Ok(())
}

fn public_key_metadata(bytes: &[u8]) -> NativeEncryptionPublicKey {
    NativeEncryptionPublicKey {
        algorithm: "P-256".to_owned(),
        format: "raw".to_owned(),
        value: URL_SAFE_NO_PAD.encode(bytes),
        version: 1,
    }
}

fn decode_base64url(value: &str, expected_length: usize) -> Result<Vec<u8>, String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "base64url-value-invalid".to_owned())?;
    if decoded.len() != expected_length || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return Err("base64url-value-invalid".to_owned());
    }
    Ok(decoded)
}

fn validate_installation_id(value: &str) -> Result<(), String> {
    let parsed = Uuid::parse_str(value).map_err(|_| "installation-profile-invalid".to_owned())?;
    if parsed.get_variant() != uuid::Variant::RFC4122 {
        return Err("installation-profile-invalid".to_owned());
    }
    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 255 {
        return Err("installation-identifier-invalid".to_owned());
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> Result<(), String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|_| ())
        .map_err(|_| "installation-timestamp-invalid".to_owned())
}

fn installation_key_alias(installation_id: &str) -> String {
    format!("cantrip.installation.v1.{installation_id}")
}

fn current_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn native_key_provider() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "apple-keychain"
    }
    #[cfg(target_os = "windows")]
    {
        "windows-protected-storage"
    }
    #[cfg(target_os = "linux")]
    {
        "linux-secret-service"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        "unsupported-native"
    }
}

fn prepare_catalog_parent(catalog_path: &Path) -> Result<(), String> {
    let parent = catalog_path
        .parent()
        .ok_or_else(|| "installation-catalog-path-unavailable".to_owned())?;
    fs::create_dir_all(parent).map_err(|_| "installation-catalog-path-unavailable".to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|_| "installation-catalog-path-unavailable".to_owned())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use hpke::{single_shot_seal, Deserializable as _, OpModeS};
    use tempfile::tempdir;

    use super::*;

    #[derive(Default)]
    struct MemorySecretStore {
        secrets: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl DeviceSecretStore for MemorySecretStore {
        fn get(&self, key_alias: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self
                .secrets
                .lock()
                .map_err(|_| "test-secret-store-unavailable".to_owned())?
                .get(key_alias)
                .cloned())
        }

        fn put(&self, key_alias: &str, secret: &[u8]) -> Result<(), String> {
            self.secrets
                .lock()
                .map_err(|_| "test-secret-store-unavailable".to_owned())?
                .insert(key_alias.to_owned(), secret.to_vec());
            Ok(())
        }
    }

    impl MemorySecretStore {
        fn replace(&self, key_alias: &str, secret: &[u8]) {
            self.secrets
                .lock()
                .expect("secret store lock")
                .insert(key_alias.to_owned(), secret.to_vec());
        }

        fn stored(&self, key_alias: &str) -> Vec<u8> {
            self.secrets
                .lock()
                .expect("secret store lock")
                .get(key_alias)
                .expect("stored secret")
                .clone()
        }
    }

    fn test_storage() -> (tempfile::TempDir, NativeInstallationStorage) {
        let directory = tempdir().expect("temp directory");
        let storage = NativeInstallationStorage::open(
            directory.path().join("installation/v1/catalog.sqlite3"),
            Arc::new(MemorySecretStore::default()),
        )
        .expect("storage");
        (directory, storage)
    }

    fn profile() -> NativeInstallationProfile {
        NativeInstallationProfile {
            created_at: "2026-08-31T20:00:00.000Z".to_owned(),
            installation_id: "5f83bb42-5671-4b11-a87f-32842af21af2".to_owned(),
            schema_version: 1,
        }
    }

    fn create_profile(storage: &NativeInstallationStorage) {
        storage
            .apply_transaction(NativeCatalogTransactionRequest {
                expected_revision: 0,
                operations: vec![NativeCatalogOperation::CreateInstallation { profile: profile() }],
            })
            .expect("create profile");
    }

    fn create_key_and_metadata(storage: &NativeInstallationStorage) -> NativeDeviceKeyDescriptor {
        let key_alias = installation_key_alias(&profile().installation_id);
        let descriptor = storage
            .create_key(NativeDeviceKeyCreateInput {
                created_at: Some("2026-08-31T20:00:01.000Z".to_owned()),
                installation_id: profile().installation_id,
                key_alias,
            })
            .expect("create key");
        storage
            .apply_transaction(NativeCatalogTransactionRequest {
                expected_revision: 1,
                operations: vec![NativeCatalogOperation::PutDeviceKey {
                    device_key: NativeInstallationDeviceKey {
                        created_at: descriptor.created_at.clone(),
                        installation_id: descriptor.installation_id.clone(),
                        key_alias: descriptor.key_alias.clone(),
                        provider: descriptor.provider.to_owned(),
                        public_key: descriptor.public_key.clone(),
                        status: "active".to_owned(),
                        version: 1,
                    },
                }],
            })
            .expect("store key metadata");
        descriptor
    }

    #[test]
    fn catalog_transactions_are_atomic_and_revisioned() {
        let (_directory, storage) = test_storage();
        let invalid_migration = NativeInstallationMigration {
            completed_at: None,
            migration_id: "legacy-indexeddb-v1".to_owned(),
            started_at: Some("2026-08-31T20:00:00.000Z".to_owned()),
            state: "verified".to_owned(),
            verification_state: None,
        };
        let failure = storage.apply_transaction(NativeCatalogTransactionRequest {
            expected_revision: 0,
            operations: vec![
                NativeCatalogOperation::CreateInstallation { profile: profile() },
                NativeCatalogOperation::PutMigration {
                    migration: invalid_migration,
                },
            ],
        });
        assert_eq!(
            failure.expect_err("invalid migration"),
            "installation-migration-invalid"
        );
        assert!(storage.snapshot().expect("snapshot").installation.is_none());

        create_profile(&storage);
        let snapshot = storage.snapshot().expect("snapshot");
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.installation, Some(profile()));
        let conflict = storage.apply_transaction(NativeCatalogTransactionRequest {
            expected_revision: 0,
            operations: vec![],
        });
        assert_eq!(
            conflict.expect_err("stale revision"),
            "installation-catalog-conflict"
        );
    }

    #[test]
    fn native_key_creation_is_idempotent_and_catalog_metadata_is_verified() {
        let (_directory, storage) = test_storage();
        create_profile(&storage);
        let key_alias = installation_key_alias(&profile().installation_id);
        let first = storage
            .create_key(NativeDeviceKeyCreateInput {
                created_at: Some("2026-08-31T20:00:01.000Z".to_owned()),
                installation_id: profile().installation_id,
                key_alias: key_alias.clone(),
            })
            .expect("create key");
        let second = storage
            .create_key(NativeDeviceKeyCreateInput {
                created_at: None,
                installation_id: first.installation_id.clone(),
                key_alias: key_alias.clone(),
            })
            .expect("load key");
        assert_eq!(first, second);

        let snapshot = storage
            .apply_transaction(NativeCatalogTransactionRequest {
                expected_revision: 1,
                operations: vec![NativeCatalogOperation::PutDeviceKey {
                    device_key: NativeInstallationDeviceKey {
                        created_at: first.created_at.clone(),
                        installation_id: first.installation_id.clone(),
                        key_alias: first.key_alias.clone(),
                        provider: first.provider.to_owned(),
                        public_key: first.public_key.clone(),
                        status: "active".to_owned(),
                        version: 1,
                    },
                }],
            })
            .expect("store metadata");
        assert_eq!(snapshot.device_keys.len(), 1);
        assert_eq!(snapshot.device_keys[0].public_key, first.public_key);
    }

    #[test]
    fn one_installation_key_supports_multiple_server_account_bindings() {
        let (_directory, storage) = test_storage();
        create_profile(&storage);
        let descriptor = create_key_and_metadata(&storage);
        let snapshot = storage
            .apply_transaction(NativeCatalogTransactionRequest {
                expected_revision: 2,
                operations: vec![
                    NativeCatalogOperation::PutAccountBinding {
                        binding: NativeInstallationAccountBinding {
                            grant_revision: 1,
                            key_alias: descriptor.key_alias.clone(),
                            master_key_revision: 1,
                            owner_id: "owner-a".to_owned(),
                            principal_id: "principal-a".to_owned(),
                            server_id: "server-a".to_owned(),
                            updated_at: "2026-08-31T20:00:02.000Z".to_owned(),
                        },
                    },
                    NativeCatalogOperation::PutAccountBinding {
                        binding: NativeInstallationAccountBinding {
                            grant_revision: 3,
                            key_alias: descriptor.key_alias.clone(),
                            master_key_revision: 2,
                            owner_id: "owner-b".to_owned(),
                            principal_id: "principal-b".to_owned(),
                            server_id: "server-b".to_owned(),
                            updated_at: "2026-08-31T20:00:03.000Z".to_owned(),
                        },
                    },
                ],
            })
            .expect("store bindings");
        assert_eq!(snapshot.account_bindings.len(), 2);
        assert!(snapshot
            .account_bindings
            .iter()
            .all(|binding| binding.key_alias == descriptor.key_alias));
    }

    #[test]
    fn corrupt_secure_store_record_is_never_replaced() {
        let directory = tempdir().expect("temp directory");
        let secrets = Arc::new(MemorySecretStore::default());
        let storage = NativeInstallationStorage::open(
            directory.path().join("installation/v1/catalog.sqlite3"),
            secrets.clone(),
        )
        .expect("storage");
        create_profile(&storage);
        let descriptor = create_key_and_metadata(&storage);
        secrets.replace(&descriptor.key_alias, b"not-a-valid-key-record");
        let corrupt_record = secrets.stored(&descriptor.key_alias);

        let failure = storage.create_key(NativeDeviceKeyCreateInput {
            created_at: None,
            installation_id: profile().installation_id,
            key_alias: descriptor.key_alias.clone(),
        });

        assert_eq!(
            failure.expect_err("corrupt key must fail closed"),
            "native-device-key-invalid"
        );
        assert_eq!(secrets.stored(&descriptor.key_alias), corrupt_record);
    }

    #[test]
    fn catalog_schema_never_contains_private_key_material() {
        let (_directory, storage) = test_storage();
        let connection = storage.connection().expect("connection");
        let mut statement = connection
            .prepare("SELECT sql FROM sqlite_master WHERE type = 'table'")
            .expect("schema query");
        let schema = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("schema rows")
            .collect::<Result<Vec<_>, _>>()
            .expect("schema")
            .join("\n")
            .to_ascii_lowercase();
        assert!(!schema.contains("private_key"));
        assert!(!schema.contains("privatekey"));
    }

    #[test]
    fn newer_catalog_schema_is_preserved_and_rejected() {
        let directory = tempdir().expect("temp directory");
        let catalog_path = directory.path().join("installation/v1/catalog.sqlite3");
        prepare_catalog_parent(&catalog_path).expect("catalog parent");
        let connection = Connection::open(&catalog_path).expect("catalog");
        connection
            .execute_batch("CREATE TABLE future_data (value TEXT); PRAGMA user_version = 2;")
            .expect("future schema");
        drop(connection);
        let storage = NativeInstallationStorage::deferred(
            catalog_path.clone(),
            Arc::new(MemorySecretStore::default()),
        );

        assert_eq!(
            storage
                .snapshot()
                .expect_err("future schema must fail closed"),
            "installation-catalog-version-unsupported"
        );
        let preserved = Connection::open(catalog_path).expect("preserved catalog");
        let version: i64 = preserved
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("schema version");
        assert_eq!(version, 2);
        let marker: i64 = preserved
            .query_row("SELECT COUNT(*) FROM future_data", [], |row| row.get(0))
            .expect("future table");
        assert_eq!(marker, 0);
    }

    #[test]
    fn private_key_unwrap_stays_inside_native_provider() {
        let (_directory, storage) = test_storage();
        create_profile(&storage);
        let key_alias = installation_key_alias(&profile().installation_id);
        let descriptor = storage
            .create_key(NativeDeviceKeyCreateInput {
                created_at: None,
                installation_id: profile().installation_id,
                key_alias: key_alias.clone(),
            })
            .expect("create key");
        let public_bytes = decode_base64url(&descriptor.public_key.value, 65).expect("public key");
        let public_key = <NativeKem as KemTrait>::PublicKey::from_bytes(&public_bytes)
            .expect("public key import");
        let owner_id = "owner-a";
        let client_id = "principal-a";
        let revision = 2;
        let associated_data = serde_json::to_vec(&ClientMasterKeyAssociatedData {
            component: "account-master-key",
            field: "wrapped_master_key",
            format_version: 1,
            key_revision: revision,
            owner_id,
            row_id: client_id,
            table: "encryption_client_principals",
        })
        .expect("associated data");
        let expected = vec![47_u8; 32];
        let (encapsulated, ciphertext) = single_shot_seal::<AesGcm256, HkdfSha256, NativeKem>(
            &OpModeS::Base,
            &public_key,
            HPKE_INFO,
            &expected,
            &associated_data,
        )
        .expect("seal");
        let opened = storage
            .unwrap_account_master_key(NativeMasterKeyUnwrapInput {
                key_alias,
                owner_id: owner_id.to_owned(),
                wrapper: NativeClientMasterKeyWrapper {
                    client_id: client_id.to_owned(),
                    envelope: NativeHpkeEnvelope {
                        algorithm: "HPKE-RFC9180".to_owned(),
                        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
                        encapsulated_key: URL_SAFE_NO_PAD.encode(encapsulated.to_bytes()),
                        suite: NativeHpkeSuite {
                            aead: "AES-256-GCM".to_owned(),
                            kdf: "HKDF-SHA256".to_owned(),
                            kem: "DHKEM(P-256,HKDF-SHA256)".to_owned(),
                            mode: "base".to_owned(),
                        },
                        version: 1,
                    },
                    master_key_revision: revision,
                    purpose: "client-account-master-key".to_owned(),
                    version: 1,
                },
            })
            .expect("unwrap");
        assert_eq!(opened.0.as_slice(), expected);
    }
}
