package art.cantrip;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class CantripInstallationStorage {

    static final class StorageException extends Exception {

        final String code;

        StorageException(String code) {
            super(code);
            this.code = code;
        }

        StorageException(String code, Throwable cause) {
            super(code, cause);
            this.code = code;
        }
    }

    private static final int SCHEMA_VERSION = 1;
    private static final int DEVICE_KEY_VERSION = 1;
    private static final String PROVIDER = "android-keystore";
    private static final String KEY_ALIAS_FORMAT = "cantrip.installation.<installation-uuid>.hpke.v1";
    private static final String PREFERENCES = "cantrip-installation-key-v1";
    private static final Set<String> TABLES = new HashSet<>(
        Arrays.asList("account_binding", "catalog_meta", "device_key", "installation", "migration")
    );
    private static final String SCHEMA_SQL =
        "CREATE TABLE catalog_meta (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), schema_version INTEGER NOT NULL, revision INTEGER NOT NULL);" +
        "INSERT INTO catalog_meta (singleton_id, schema_version, revision) VALUES (1, 1, 0);" +
        "CREATE TABLE installation (singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1), installation_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, schema_version INTEGER NOT NULL);" +
        "CREATE TABLE device_key (key_alias TEXT PRIMARY KEY, installation_id TEXT NOT NULL, public_key_json TEXT NOT NULL, provider TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, FOREIGN KEY (installation_id) REFERENCES installation(installation_id));" +
        "CREATE TABLE account_binding (server_id TEXT NOT NULL, owner_id TEXT NOT NULL, principal_id TEXT NOT NULL, key_alias TEXT NOT NULL, grant_revision INTEGER NOT NULL, master_key_revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (server_id, owner_id), FOREIGN KEY (key_alias) REFERENCES device_key(key_alias));" +
        "CREATE TABLE migration (migration_id TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT, state TEXT NOT NULL, verification_state TEXT);" +
        "PRAGMA user_version = 1;";

    private final File catalogFile;
    private final Object lock = new Object();
    private final SharedPreferences preferences;

    CantripInstallationStorage(Context context) {
        File directory = new File(context.getFilesDir(), "installation/v1");
        catalogFile = new File(directory, "catalog.sqlite3");
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    JSObject status() {
        JSObject status = new JSObject();
        status.put("catalogPath", catalogFile.getAbsolutePath());
        status.put("keyAliasFormat", KEY_ALIAS_FORMAT);
        status.put("provider", PROVIDER);
        status.put("schemaVersion", SCHEMA_VERSION);
        return status;
    }

    JSObject readCatalog() throws StorageException {
        synchronized (lock) {
            try (SQLiteDatabase database = openDatabase()) {
                return snapshot(database);
            }
        }
    }

    JSObject applyCatalogTransaction(JSObject request) throws StorageException {
        synchronized (lock) {
            try (SQLiteDatabase database = openDatabase()) {
                database.beginTransaction();
                try {
                    long expectedRevision = requiredLong(request, "expectedRevision", "installation-catalog-corrupt");
                    long revision = catalogRevision(database);
                    if (revision != expectedRevision) throw new StorageException("installation-catalog-conflict");
                    JSONArray operations = requiredArray(request, "operations", "installation-catalog-corrupt");
                    for (int index = 0; index < operations.length(); index += 1) {
                        JSONObject operation = operations.optJSONObject(index);
                        if (operation == null) throw new StorageException("installation-catalog-corrupt");
                        applyOperation(database, operation);
                    }
                    if (operations.length() > 0) {
                        database.execSQL("UPDATE catalog_meta SET revision = revision + 1 WHERE singleton_id = 1");
                    }
                    JSObject result = snapshot(database);
                    database.setTransactionSuccessful();
                    return result;
                } finally {
                    database.endTransaction();
                }
            }
        }
    }

    JSObject createKey(JSObject input) throws StorageException {
        return createKey(input, false);
    }

    JSObject replaceMissingKey(JSObject input) throws StorageException {
        return createKey(input, true);
    }

    private JSObject createKey(JSObject input, boolean replaceMissing) throws StorageException {
        synchronized (lock) {
            String installationId = requiredString(input, "installationId", "installation-profile-invalid");
            String keyAlias = requiredString(input, "keyAlias", "native-device-key-alias-invalid");
            validateInstallationId(installationId);
            if (!keyAlias.equals(installationKeyAlias(installationId))) {
                throw new StorageException("native-device-key-alias-invalid");
            }
            String requestedCreatedAt = input.optString("createdAt", null);
            if (requestedCreatedAt != null) validateTimestamp(requestedCreatedAt, "installation-timestamp-invalid");
            try (SQLiteDatabase database = openDatabase()) {
                String catalogInstallation = scalarString(
                    database,
                    "SELECT installation_id FROM installation WHERE singleton_id = 1",
                    null
                );
                if (!installationId.equals(catalogInstallation)) throw new StorageException("installation-missing");
                JSObject existing = inspectKeyUnlocked(keyAlias);
                if (existing != null) {
                    if (!installationId.equals(existing.optString("installationId"))) {
                        throw new StorageException("native-device-key-conflict");
                    }
                    return existing;
                }
                boolean catalogKeyExists = rowExists(database, "SELECT 1 FROM device_key WHERE key_alias = ?", new String[] { keyAlias });
                if (catalogKeyExists && !replaceMissing) {
                    throw new StorageException("native-device-key-missing");
                }
                if (!catalogKeyExists && replaceMissing) throw new StorageException("native-device-key-missing");
            }

            byte[] privateKey = null;
            byte[] publicKey = null;
            byte[] encrypted = null;
            byte[] iv = new byte[12];
            try {
                KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
                generator.initialize(new ECGenParameterSpec("secp256r1"));
                KeyPair pair = generator.generateKeyPair();
                privateKey = pair.getPrivate().getEncoded();
                publicKey = CantripHpke.publicKeyBytes((ECPublicKey) pair.getPublic());
                new SecureRandom().nextBytes(iv);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, getOrCreateWrappingKey(keyAlias), new GCMParameterSpec(128, iv));
                cipher.updateAAD(keyAlias.getBytes(StandardCharsets.UTF_8));
                encrypted = cipher.doFinal(privateKey);
                String createdAt = requestedCreatedAt == null ? Instant.now().toString() : requestedCreatedAt;
                JSObject record = new JSObject();
                record.put("createdAt", createdAt);
                record.put("encryptedPrivateKey", CantripHpke.encodeBase64Url(encrypted));
                record.put("installationId", installationId);
                record.put("iv", CantripHpke.encodeBase64Url(iv));
                record.put("keyAlias", keyAlias);
                record.put("publicKey", CantripHpke.encodeBase64Url(publicKey));
                record.put("version", DEVICE_KEY_VERSION);
                if (!preferences.edit().putString(keyAlias, record.toString()).commit()) {
                    throw new StorageException("native-key-store-unavailable");
                }
                return descriptor(record);
            } catch (StorageException error) {
                throw error;
            } catch (Exception error) {
                throw new StorageException("native-key-store-unavailable", error);
            } finally {
                CantripHpke.clear(privateKey, publicKey, encrypted, iv);
            }
        }
    }

    JSObject inspectKey(String keyAlias) throws StorageException {
        synchronized (lock) {
            validateIdentifier(keyAlias, "native-device-key-invalid");
            return inspectKeyUnlocked(keyAlias);
        }
    }

    byte[] unwrapAccountMasterKey(JSObject input) throws StorageException {
        synchronized (lock) {
            String keyAlias = requiredString(input, "keyAlias", "client-master-key-wrapper-invalid");
            String ownerId = requiredString(input, "ownerId", "client-master-key-wrapper-invalid");
            JSObject wrapper = requiredObject(input, "wrapper", "client-master-key-wrapper-invalid");
            validateWrapper(wrapper);
            String recordText = preferences.getString(keyAlias, null);
            if (recordText == null) throw new StorageException("native-device-key-missing");
            byte[] privateKeyBytes = null;
            byte[] recipientPublicKey = null;
            byte[] encapsulated = null;
            byte[] ciphertext = null;
            byte[] aad = null;
            try {
                JSObject record = new JSObject(recordText);
                validateKeyRecord(record, keyAlias);
                privateKeyBytes = decryptPrivateKey(record);
                PrivateKey privateKey = KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(privateKeyBytes));
                recipientPublicKey = CantripHpke.decodeBase64Url(record.getString("publicKey"), 65);
                JSObject envelope = requiredObject(wrapper, "envelope", "client-master-key-wrapper-invalid");
                encapsulated = CantripHpke.decodeBase64Url(envelope.getString("encapsulatedKey"), 65);
                ciphertext = CantripHpke.decodeBase64Url(envelope.getString("ciphertext"), 48);
                aad = CantripHpke.associatedData(ownerId, wrapper.getString("clientId"), wrapper.getLong("masterKeyRevision"));
                byte[] plaintext = CantripHpke.open(privateKey, recipientPublicKey, encapsulated, ciphertext, aad);
                if (plaintext.length != 32) {
                    CantripHpke.clear(plaintext);
                    throw new StorageException("client-master-key-decryption-failed");
                }
                return plaintext;
            } catch (StorageException error) {
                throw error;
            } catch (Exception error) {
                String code = error.getMessage();
                if (code != null && (code.startsWith("base64url-") || code.startsWith("client-master-key-"))) {
                    throw new StorageException(code, error);
                }
                throw new StorageException("client-master-key-decryption-failed", error);
            } finally {
                CantripHpke.clear(privateKeyBytes, recipientPublicKey, encapsulated, ciphertext, aad);
            }
        }
    }

    private SQLiteDatabase openDatabase() throws StorageException {
        try {
            File parent = catalogFile.getParentFile();
            if (parent == null || (!parent.exists() && !parent.mkdirs())) {
                throw new StorageException("installation-catalog-path-unavailable");
            }
            SQLiteDatabase database = SQLiteDatabase.openOrCreateDatabase(catalogFile, null);
            database.execSQL("PRAGMA foreign_keys = ON");
            initializeSchema(database);
            return database;
        } catch (StorageException error) {
            throw error;
        } catch (SQLiteException error) {
            throw new StorageException("installation-catalog-unavailable", error);
        }
    }

    private void initializeSchema(SQLiteDatabase database) throws StorageException {
        int version = database.getVersion();
        if (version > SCHEMA_VERSION) throw new StorageException("installation-catalog-version-unsupported");
        if (version == 0) {
            if (userTables(database).size() > 0) throw new StorageException("installation-catalog-corrupt");
            database.beginTransaction();
            try {
                for (String statement : SCHEMA_SQL.split(";")) {
                    if (!statement.trim().isEmpty()) database.execSQL(statement);
                }
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }
        }
        verifySchema(database);
    }

    private void verifySchema(SQLiteDatabase database) throws StorageException {
        if (database.getVersion() != SCHEMA_VERSION || !userTables(database).equals(TABLES)) {
            throw new StorageException("installation-catalog-corrupt");
        }
        try (Cursor cursor = database.rawQuery(
            "SELECT singleton_id, schema_version, revision FROM catalog_meta",
            null
        )) {
            if (!cursor.moveToFirst() || cursor.getInt(0) != 1 || cursor.getInt(1) != 1 || cursor.getLong(2) < 0 || cursor.moveToNext()) {
                throw new StorageException("installation-catalog-corrupt");
            }
        }
        try (Cursor cursor = database.rawQuery("PRAGMA quick_check(1)", null)) {
            if (!cursor.moveToFirst() || !"ok".equals(cursor.getString(0))) throw new StorageException("installation-catalog-corrupt");
        }
        try (Cursor cursor = database.rawQuery("PRAGMA foreign_key_check", null)) {
            if (cursor.moveToFirst()) throw new StorageException("installation-catalog-corrupt");
        }
    }

    private Set<String> userTables(SQLiteDatabase database) {
        Set<String> result = new HashSet<>();
        try (Cursor cursor = database.rawQuery(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            null
        )) {
            while (cursor.moveToNext()) result.add(cursor.getString(0));
        }
        return result;
    }

    private JSObject snapshot(SQLiteDatabase database) throws StorageException {
        JSObject snapshot = new JSObject();
        snapshot.put("schemaVersion", SCHEMA_VERSION);
        snapshot.put("revision", catalogRevision(database));
        JSObject installation = readInstallation(database);
        snapshot.put("installation", installation == null ? JSONObject.NULL : installation);
        snapshot.put("deviceKeys", readDeviceKeys(database));
        snapshot.put("accountBindings", readAccountBindings(database));
        snapshot.put("migrations", readMigrations(database));
        validateSnapshot(snapshot, database);
        return snapshot;
    }

    private JSObject readInstallation(SQLiteDatabase database) throws StorageException {
        try (Cursor cursor = database.rawQuery(
            "SELECT created_at, installation_id, schema_version FROM installation WHERE singleton_id = 1",
            null
        )) {
            if (!cursor.moveToFirst()) return null;
            JSObject profile = new JSObject();
            profile.put("createdAt", cursor.getString(0));
            profile.put("installationId", cursor.getString(1));
            profile.put("schemaVersion", cursor.getInt(2));
            if (cursor.moveToNext()) throw new StorageException("installation-catalog-corrupt");
            validateProfile(profile);
            return profile;
        }
    }

    private JSArray readDeviceKeys(SQLiteDatabase database) throws StorageException {
        JSArray values = new JSArray();
        try (Cursor cursor = database.rawQuery(
            "SELECT created_at, installation_id, key_alias, provider, public_key_json, status, version FROM device_key ORDER BY key_alias",
            null
        )) {
            while (cursor.moveToNext()) {
                try {
                    JSObject value = new JSObject();
                    value.put("createdAt", cursor.getString(0));
                    value.put("installationId", cursor.getString(1));
                    value.put("keyAlias", cursor.getString(2));
                    value.put("provider", cursor.getString(3));
                    value.put("publicKey", new JSObject(cursor.getString(4)));
                    value.put("status", cursor.getString(5));
                    value.put("version", cursor.getInt(6));
                    values.put(value);
                } catch (JSONException error) {
                    throw new StorageException("installation-catalog-corrupt", error);
                }
            }
        }
        return values;
    }

    private JSObject readDeviceKey(SQLiteDatabase database, String keyAlias) throws StorageException {
        try (Cursor cursor = database.rawQuery(
            "SELECT created_at, installation_id, key_alias, provider, public_key_json, version FROM device_key WHERE key_alias = ?",
            new String[] { keyAlias }
        )) {
            if (!cursor.moveToFirst()) return null;
            try {
                JSObject value = new JSObject();
                value.put("createdAt", cursor.getString(0));
                value.put("installationId", cursor.getString(1));
                value.put("keyAlias", cursor.getString(2));
                value.put("provider", cursor.getString(3));
                value.put("publicKey", new JSObject(cursor.getString(4)));
                value.put("version", cursor.getInt(5));
                if (cursor.moveToNext()) throw new StorageException("installation-catalog-corrupt");
                return value;
            } catch (JSONException error) {
                throw new StorageException("installation-catalog-corrupt", error);
            }
        }
    }

    private JSArray readAccountBindings(SQLiteDatabase database) {
        JSArray values = new JSArray();
        try (Cursor cursor = database.rawQuery(
            "SELECT server_id, owner_id, principal_id, key_alias, grant_revision, master_key_revision, updated_at FROM account_binding ORDER BY server_id, owner_id",
            null
        )) {
            while (cursor.moveToNext()) {
                JSObject value = new JSObject();
                value.put("serverId", cursor.getString(0));
                value.put("ownerId", cursor.getString(1));
                value.put("principalId", cursor.getString(2));
                value.put("keyAlias", cursor.getString(3));
                value.put("grantRevision", cursor.getLong(4));
                value.put("masterKeyRevision", cursor.getLong(5));
                value.put("updatedAt", cursor.getString(6));
                values.put(value);
            }
        }
        return values;
    }

    private JSArray readMigrations(SQLiteDatabase database) {
        JSArray values = new JSArray();
        try (Cursor cursor = database.rawQuery(
            "SELECT migration_id, started_at, completed_at, state, verification_state FROM migration ORDER BY migration_id",
            null
        )) {
            while (cursor.moveToNext()) {
                JSObject value = new JSObject();
                value.put("migrationId", cursor.getString(0));
                value.put("startedAt", cursor.isNull(1) ? JSONObject.NULL : cursor.getString(1));
                value.put("completedAt", cursor.isNull(2) ? JSONObject.NULL : cursor.getString(2));
                value.put("state", cursor.getString(3));
                value.put("verificationState", cursor.isNull(4) ? JSONObject.NULL : cursor.getString(4));
                values.put(value);
            }
        }
        return values;
    }

    private void applyOperation(SQLiteDatabase database, JSONObject operation) throws StorageException {
        String type = requiredString(operation, "type", "installation-catalog-corrupt");
        switch (type) {
            case "create-installation":
                putInstallation(database, requiredObject(operation, "profile", "installation-profile-invalid"));
                break;
            case "put-device-key":
                putDeviceKey(database, requiredObject(operation, "deviceKey", "installation-device-key-invalid"), false);
                break;
            case "replace-device-key":
                putDeviceKey(database, requiredObject(operation, "deviceKey", "installation-device-key-invalid"), true);
                break;
            case "put-account-binding":
                putAccountBinding(database, requiredObject(operation, "binding", "installation-account-binding-invalid"));
                break;
            case "put-migration":
                putMigration(database, requiredObject(operation, "migration", "installation-migration-invalid"));
                break;
            default:
                throw new StorageException("installation-catalog-corrupt");
        }
    }

    private void putInstallation(SQLiteDatabase database, JSObject profile) throws StorageException {
        validateProfile(profile);
        String installationId = profile.optString("installationId");
        String existing = scalarString(database, "SELECT installation_id FROM installation WHERE singleton_id = 1", null);
        if (existing != null) {
            if (!existing.equals(installationId)) throw new StorageException("installation-conflict");
            return;
        }
        ContentValues values = new ContentValues();
        values.put("singleton_id", 1);
        values.put("installation_id", installationId);
        values.put("created_at", profile.optString("createdAt"));
        values.put("schema_version", SCHEMA_VERSION);
        database.insertOrThrow("installation", null, values);
    }

    private void putDeviceKey(SQLiteDatabase database, JSObject deviceKey, boolean replacing) throws StorageException {
        validateDeviceKey(database, deviceKey);
        String keyAlias = deviceKey.optString("keyAlias");
        JSObject descriptor = inspectKeyUnlocked(keyAlias);
        if (descriptor == null) throw new StorageException("native-device-key-missing");
        if (!descriptorMetadataMatches(deviceKey, descriptor)) {
            throw new StorageException("native-device-key-metadata-mismatch");
        }
        JSObject catalogKey = readDeviceKey(database, keyAlias);
        if (
            catalogKey != null &&
            (
                catalogKey.optInt("version", -1) != deviceKey.optInt("version", -1) ||
                !catalogKey.optString("installationId").equals(deviceKey.optString("installationId")) ||
                !catalogKey.optString("provider").equals(deviceKey.optString("provider")) ||
                (!replacing && !descriptorMetadataMatches(deviceKey, catalogKey))
            )
        ) {
            throw new StorageException("native-device-key-metadata-mismatch");
        }
        ContentValues values = new ContentValues();
        values.put("key_alias", keyAlias);
        values.put("installation_id", deviceKey.optString("installationId"));
        values.put("public_key_json", deviceKey.optJSONObject("publicKey").toString());
        values.put("provider", deviceKey.optString("provider"));
        values.put("created_at", deviceKey.optString("createdAt"));
        values.put("status", deviceKey.optString("status"));
        values.put("version", deviceKey.optInt("version"));
        String conflictUpdate = replacing
            ? "public_key_json = excluded.public_key_json, created_at = excluded.created_at, status = excluded.status"
            : "status = excluded.status";
        database.execSQL(
            "INSERT INTO device_key (key_alias, installation_id, public_key_json, provider, created_at, status, version) VALUES (?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(key_alias) DO UPDATE SET " + conflictUpdate,
            new Object[] {
                values.getAsString("key_alias"),
                values.getAsString("installation_id"),
                values.getAsString("public_key_json"),
                values.getAsString("provider"),
                values.getAsString("created_at"),
                values.getAsString("status"),
                values.getAsInteger("version")
            }
        );
    }

    private void putAccountBinding(SQLiteDatabase database, JSObject binding) throws StorageException {
        validateBinding(database, binding);
        ContentValues values = new ContentValues();
        values.put("server_id", binding.optString("serverId"));
        values.put("owner_id", binding.optString("ownerId"));
        values.put("principal_id", binding.optString("principalId"));
        values.put("key_alias", binding.optString("keyAlias"));
        values.put("grant_revision", binding.optLong("grantRevision"));
        values.put("master_key_revision", binding.optLong("masterKeyRevision"));
        values.put("updated_at", binding.optString("updatedAt"));
        database.insertWithOnConflict("account_binding", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private void putMigration(SQLiteDatabase database, JSObject migration) throws StorageException {
        validateMigration(migration);
        ContentValues values = new ContentValues();
        values.put("migration_id", migration.optString("migrationId"));
        putNullable(values, "started_at", migration, "startedAt");
        putNullable(values, "completed_at", migration, "completedAt");
        values.put("state", migration.optString("state"));
        putNullable(values, "verification_state", migration, "verificationState");
        database.insertWithOnConflict("migration", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    private void validateSnapshot(JSObject snapshot, SQLiteDatabase database) throws StorageException {
        JSONObject installation = snapshot.optJSONObject("installation");
        if (installation != null) validateProfile(requiredObject(snapshot, "installation", "installation-catalog-corrupt"));
        JSONArray deviceKeys = snapshot.optJSONArray("deviceKeys");
        JSONArray bindings = snapshot.optJSONArray("accountBindings");
        JSONArray migrations = snapshot.optJSONArray("migrations");
        if (deviceKeys == null || bindings == null || migrations == null) throw new StorageException("installation-catalog-corrupt");
        try {
            for (int index = 0; index < deviceKeys.length(); index += 1) validateDeviceKey(database, new JSObject(deviceKeys.getJSONObject(index).toString()));
            for (int index = 0; index < bindings.length(); index += 1) validateBinding(database, new JSObject(bindings.getJSONObject(index).toString()));
        } catch (JSONException error) {
            throw new StorageException("installation-catalog-corrupt", error);
        }
        for (int index = 0; index < migrations.length(); index += 1) {
            try {
                validateMigration(new JSObject(migrations.getJSONObject(index).toString()));
            } catch (JSONException error) {
                throw new StorageException("installation-catalog-corrupt", error);
            }
        }
    }

    private void validateProfile(JSObject profile) throws StorageException {
        String installationId = requiredString(profile, "installationId", "installation-profile-invalid");
        validateInstallationId(installationId);
        validateTimestamp(requiredString(profile, "createdAt", "installation-profile-invalid"), "installation-profile-invalid");
        if (profile.optInt("schemaVersion", -1) != SCHEMA_VERSION) throw new StorageException("installation-profile-invalid");
    }

    private void validateDeviceKey(SQLiteDatabase database, JSObject key) throws StorageException {
        String installationId = requiredString(key, "installationId", "installation-device-key-invalid");
        String alias = requiredString(key, "keyAlias", "installation-device-key-invalid");
        String catalogInstallation = scalarString(database, "SELECT installation_id FROM installation WHERE singleton_id = 1", null);
        JSONObject publicKey = key.optJSONObject("publicKey");
        if (
            !installationId.equals(catalogInstallation) ||
            !alias.equals(installationKeyAlias(installationId)) ||
            !PROVIDER.equals(key.optString("provider")) ||
            !("active".equals(key.optString("status")) || "retired".equals(key.optString("status"))) ||
            key.optInt("version", -1) != DEVICE_KEY_VERSION ||
            publicKey == null ||
            !"P-256".equals(publicKey.optString("algorithm")) ||
            !"raw".equals(publicKey.optString("format")) ||
            publicKey.optInt("version", -1) != 1
        ) throw new StorageException("installation-device-key-invalid");
        validateTimestamp(requiredString(key, "createdAt", "installation-device-key-invalid"), "installation-device-key-invalid");
        try {
            CantripHpke.clear(CantripHpke.decodeBase64Url(publicKey.optString("value"), 65));
        } catch (Exception error) {
            throw new StorageException("installation-device-key-invalid", error);
        }
    }

    private void validateBinding(SQLiteDatabase database, JSObject binding) throws StorageException {
        String keyAlias = requiredString(binding, "keyAlias", "installation-account-binding-invalid");
        validateIdentifier(requiredString(binding, "serverId", "installation-account-binding-invalid"), "installation-account-binding-invalid");
        validateIdentifier(requiredString(binding, "ownerId", "installation-account-binding-invalid"), "installation-account-binding-invalid");
        validateIdentifier(requiredString(binding, "principalId", "installation-account-binding-invalid"), "installation-account-binding-invalid");
        validateTimestamp(requiredString(binding, "updatedAt", "installation-account-binding-invalid"), "installation-account-binding-invalid");
        if (
            binding.optLong("grantRevision", 0) < 1 ||
            binding.optLong("masterKeyRevision", 0) < 1 ||
            !rowExists(database, "SELECT 1 FROM device_key WHERE key_alias = ? AND status = 'active'", new String[] { keyAlias })
        ) throw new StorageException("installation-account-binding-invalid");
    }

    private void validateMigration(JSObject migration) throws StorageException {
        validateIdentifier(requiredString(migration, "migrationId", "installation-migration-invalid"), "installation-migration-invalid");
        String state = requiredString(migration, "state", "installation-migration-invalid");
        if (!("failed".equals(state) || "in-progress".equals(state) || "pending".equals(state) || "verified".equals(state))) {
            throw new StorageException("installation-migration-invalid");
        }
        String startedAt = nullableString(migration, "startedAt");
        String completedAt = nullableString(migration, "completedAt");
        String verification = nullableString(migration, "verificationState");
        if (startedAt != null) validateTimestamp(startedAt, "installation-migration-invalid");
        if (completedAt != null) validateTimestamp(completedAt, "installation-migration-invalid");
        if ("verified".equals(state) && (startedAt == null || completedAt == null || verification == null || verification.isEmpty())) {
            throw new StorageException("installation-migration-invalid");
        }
    }

    private void validateWrapper(JSObject wrapper) throws StorageException {
        JSONObject envelope = wrapper.optJSONObject("envelope");
        JSONObject suite = envelope == null ? null : envelope.optJSONObject("suite");
        if (
            wrapper.optInt("version", -1) != 1 ||
            !"client-account-master-key".equals(wrapper.optString("purpose")) ||
            wrapper.optLong("masterKeyRevision", 0) < 1 ||
            requiredString(wrapper, "clientId", "client-master-key-wrapper-invalid").isEmpty() ||
            envelope == null ||
            envelope.optInt("version", -1) != 1 ||
            !"HPKE-RFC9180".equals(envelope.optString("algorithm")) ||
            suite == null ||
            !"base".equals(suite.optString("mode")) ||
            !"DHKEM(P-256,HKDF-SHA256)".equals(suite.optString("kem")) ||
            !"HKDF-SHA256".equals(suite.optString("kdf")) ||
            !"AES-256-GCM".equals(suite.optString("aead"))
        ) throw new StorageException("client-master-key-wrapper-invalid");
    }

    private JSObject inspectKeyUnlocked(String keyAlias) throws StorageException {
        String recordText = preferences.getString(keyAlias, null);
        if (recordText == null) return null;
        byte[] privateKey = null;
        try {
            JSObject record = new JSObject(recordText);
            validateKeyRecord(record, keyAlias);
            privateKey = decryptPrivateKey(record);
            KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(privateKey));
            return descriptor(record);
        } catch (StorageException error) {
            throw error;
        } catch (Exception error) {
            throw new StorageException("native-device-key-invalid", error);
        } finally {
            CantripHpke.clear(privateKey);
        }
    }

    private void validateKeyRecord(JSObject record, String expectedAlias) throws StorageException {
        String installationId = requiredString(record, "installationId", "native-device-key-invalid");
        String alias = requiredString(record, "keyAlias", "native-device-key-invalid");
        validateInstallationId(installationId);
        validateTimestamp(requiredString(record, "createdAt", "native-device-key-invalid"), "native-device-key-invalid");
        if (record.optInt("version", -1) != 1 || !expectedAlias.equals(alias) || !alias.equals(installationKeyAlias(installationId))) {
            throw new StorageException("native-device-key-invalid");
        }
        try {
            CantripHpke.clear(CantripHpke.decodeBase64Url(record.optString("publicKey"), 65));
        } catch (Exception error) {
            throw new StorageException("native-device-key-invalid", error);
        }
    }

    private JSObject descriptor(JSObject record) {
        JSObject publicKey = new JSObject();
        publicKey.put("algorithm", "P-256");
        publicKey.put("format", "raw");
        publicKey.put("value", record.optString("publicKey"));
        publicKey.put("version", 1);
        JSObject descriptor = new JSObject();
        descriptor.put("createdAt", record.optString("createdAt"));
        descriptor.put("installationId", record.optString("installationId"));
        descriptor.put("keyAlias", record.optString("keyAlias"));
        descriptor.put("provider", PROVIDER);
        descriptor.put("publicKey", publicKey);
        return descriptor;
    }

    private boolean descriptorMetadataMatches(JSObject stored, JSObject descriptor) {
        return (
            stored.optString("createdAt").equals(descriptor.optString("createdAt")) &&
            stored.optString("installationId").equals(descriptor.optString("installationId")) &&
            stored.optString("keyAlias").equals(descriptor.optString("keyAlias")) &&
            stored.optString("provider").equals(descriptor.optString("provider")) &&
            publicKeysMatch(stored.optJSONObject("publicKey"), descriptor.optJSONObject("publicKey"))
        );
    }

    private static boolean publicKeysMatch(JSONObject left, JSONObject right) {
        return (
            left != null &&
            right != null &&
            left.optInt("version", -1) == right.optInt("version", -1) &&
            left.optString("algorithm").equals(right.optString("algorithm")) &&
            left.optString("format").equals(right.optString("format")) &&
            left.optString("value").equals(right.optString("value"))
        );
    }

    private byte[] decryptPrivateKey(JSObject record) throws StorageException {
        byte[] encrypted = null;
        byte[] iv = null;
        try {
            encrypted = decodeVariableBase64Url(record.optString("encryptedPrivateKey"));
            iv = CantripHpke.decodeBase64Url(record.optString("iv"), 12);
            SecretKey wrappingKey = getWrappingKey(record.optString("keyAlias"));
            if (wrappingKey == null) throw new StorageException("native-device-key-missing");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey, new GCMParameterSpec(128, iv));
            cipher.updateAAD(record.optString("keyAlias").getBytes(StandardCharsets.UTF_8));
            return cipher.doFinal(encrypted);
        } catch (StorageException error) {
            throw error;
        } catch (Exception error) {
            throw new StorageException("native-device-key-invalid", error);
        } finally {
            CantripHpke.clear(encrypted, iv);
        }
    }

    private SecretKey getOrCreateWrappingKey(String keyAlias) throws Exception {
        SecretKey existing = getWrappingKey(keyAlias);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(
                wrappingKeyAlias(keyAlias),
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build()
        );
        return generator.generateKey();
    }

    private SecretKey getWrappingKey(String keyAlias) throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        java.security.Key key = keyStore.getKey(wrappingKeyAlias(keyAlias), null);
        return key instanceof SecretKey ? (SecretKey) key : null;
    }

    private String wrappingKeyAlias(String keyAlias) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(keyAlias.getBytes(StandardCharsets.UTF_8));
        try {
            return "cantrip.installation.wrap.v1." + CantripHpke.encodeBase64Url(digest);
        } finally {
            CantripHpke.clear(digest);
        }
    }

    private long catalogRevision(SQLiteDatabase database) throws StorageException {
        try (Cursor cursor = database.rawQuery("SELECT revision FROM catalog_meta WHERE singleton_id = 1", null)) {
            if (!cursor.moveToFirst() || cursor.getLong(0) < 0 || cursor.moveToNext()) {
                throw new StorageException("installation-catalog-corrupt");
            }
            return cursor.getLong(0);
        }
    }

    private static String scalarString(SQLiteDatabase database, String sql, String[] arguments) {
        try (Cursor cursor = database.rawQuery(sql, arguments)) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    private static boolean rowExists(SQLiteDatabase database, String sql, String[] arguments) {
        try (Cursor cursor = database.rawQuery(sql, arguments)) {
            return cursor.moveToFirst();
        }
    }

    private static void putNullable(ContentValues values, String column, JSObject source, String key) {
        String value = nullableString(source, key);
        if (value == null) values.putNull(column); else values.put(column, value);
    }

    private static String nullableString(JSONObject object, String key) {
        return object.isNull(key) ? null : object.optString(key, null);
    }

    private static JSObject requiredObject(JSONObject object, String key, String code) throws StorageException {
        JSONObject value = object.optJSONObject(key);
        if (value == null) throw new StorageException(code);
        if (value instanceof JSObject) return (JSObject) value;
        try {
            return new JSObject(value.toString());
        } catch (JSONException error) {
            throw new StorageException(code, error);
        }
    }

    private static JSONArray requiredArray(JSONObject object, String key, String code) throws StorageException {
        JSONArray value = object.optJSONArray(key);
        if (value == null) throw new StorageException(code);
        return value;
    }

    private static String requiredString(JSONObject object, String key, String code) throws StorageException {
        String value = object.optString(key, null);
        if (value == null || value.isEmpty()) throw new StorageException(code);
        return value;
    }

    private static long requiredLong(JSONObject object, String key, String code) throws StorageException {
        if (!object.has(key)) throw new StorageException(code);
        long value = object.optLong(key, Long.MIN_VALUE);
        if (value == Long.MIN_VALUE) throw new StorageException(code);
        return value;
    }

    private static void validateIdentifier(String value, String code) throws StorageException {
        if (value == null || value.isEmpty() || value.length() > 255) throw new StorageException(code);
    }

    private static void validateInstallationId(String value) throws StorageException {
        try {
            UUID parsed = UUID.fromString(value);
            int version = parsed.version();
            if (!parsed.toString().equals(value) || version < 1 || version > 8 || parsed.variant() != 2) {
                throw new StorageException("installation-profile-invalid");
            }
        } catch (IllegalArgumentException error) {
            throw new StorageException("installation-profile-invalid", error);
        }
    }

    private static void validateTimestamp(String value, String code) throws StorageException {
        try {
            Instant.parse(value);
        } catch (DateTimeParseException error) {
            throw new StorageException(code, error);
        }
    }

    private static String installationKeyAlias(String installationId) {
        return "cantrip.installation." + installationId + ".hpke.v1";
    }

    private static byte[] decodeVariableBase64Url(String value) throws StorageException {
        if (value == null || value.isEmpty()) throw new StorageException("native-device-key-invalid");
        try {
            byte[] decoded = android.util.Base64.decode(value, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
            if (!CantripHpke.encodeBase64Url(decoded).equals(value)) {
                CantripHpke.clear(decoded);
                throw new StorageException("native-device-key-invalid");
            }
            return decoded;
        } catch (IllegalArgumentException error) {
            throw new StorageException("native-device-key-invalid", error);
        }
    }
}
