package art.cantrip;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Scanner;
import java.util.Set;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 35)
public final class CantripInstallationStorageUpdateTest {

    private static final class FrozenWrappingKeyStore implements CantripInstallationStorage.WrappingKeyStore {

        private final String expectedAlias;
        private final SecretKey key;

        FrozenWrappingKeyStore(String expectedAlias, String encoded) {
            this.expectedAlias = expectedAlias;
            key = new SecretKeySpec(decode(encoded), "AES");
        }

        @Override
        public SecretKey get(String keyAlias) {
            assertEquals(expectedAlias, keyAlias);
            return key;
        }

        @Override
        public SecretKey getOrCreate(String keyAlias) {
            assertEquals(expectedAlias, keyAlias);
            return key;
        }
    }

    @Test
    public void androidMetadataDoesNotBlockFreshCatalogCreation() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        File catalogFile = new File(
            context.getCacheDir(),
            "cantrip-fresh-catalog-" + System.nanoTime() + "/installation/v1/catalog.sqlite3"
        );
        SharedPreferences preferences = context.getSharedPreferences(
            "cantrip-fresh-catalog-" + System.nanoTime(),
            Context.MODE_PRIVATE
        );
        CantripInstallationStorage storage = new CantripInstallationStorage(
            catalogFile,
            preferences,
            new FrozenWrappingKeyStore(
                "fresh-installation-key",
                "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI"
            )
        );

        JSObject snapshot = storage.readCatalog();
        assertEquals(0, snapshot.getLong("revision"));
        assertEquals(JSONObject.NULL, snapshot.get("installation"));
    }

    @Test
    public void currentRuntimeOpensAndDecryptsFrozenVersionOneState() throws Exception {
        JSONObject fixture = new JSONObject(resource("v1-custody.json"));
        assertEquals(1, fixture.getInt("fixtureVersion"));
        String keyAlias = fixture.getString("keyAlias");

        Context context = RuntimeEnvironment.getApplication();
        File root = new File(context.getCacheDir(), "cantrip-update-fixture-" + System.nanoTime());
        File catalogFile = new File(root, "installation/v1/catalog.sqlite3");
        assertNotNull(catalogFile.getParentFile());
        //noinspection ResultOfMethodCallIgnored
        catalogFile.getParentFile().mkdirs();

        try (SQLiteDatabase database = SQLiteDatabase.openOrCreateDatabase(catalogFile, null)) {
            String sql = resource("v1-catalog.sql").replace("__CANTRIP_NATIVE_PROVIDER__", "android-keystore");
            for (String statement : sql.split(";")) {
                if (!statement.trim().isEmpty()) database.execSQL(statement);
            }
            assertEquals(1, database.getVersion());
            Set<String> tables = new HashSet<>();
            try (Cursor cursor = database.rawQuery(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'android_metadata'",
                null
            )) {
                while (cursor.moveToNext()) tables.add(cursor.getString(0));
            }
            assertEquals(
                new HashSet<>(Arrays.asList("account_binding", "catalog_meta", "device_key", "installation", "migration")),
                tables
            );
        }

        SharedPreferences preferences = context.getSharedPreferences(
            "cantrip-update-fixture-" + System.nanoTime(),
            Context.MODE_PRIVATE
        );
        preferences.edit().putString(keyAlias, fixture.getJSONObject("androidKeyRecord").toString()).commit();
        CantripInstallationStorage storage = new CantripInstallationStorage(
            catalogFile,
            preferences,
            new FrozenWrappingKeyStore(keyAlias, fixture.getString("androidWrappingKey"))
        );

        JSObject snapshot = storage.readCatalog();
        assertEquals(3, snapshot.getLong("revision"));
        assertEquals(fixture.getString("installationId"), snapshot.getJSONObject("installation").getString("installationId"));
        JSONArray deviceKeys = snapshot.getJSONArray("deviceKeys");
        assertEquals(1, deviceKeys.length());
        assertEquals("android-keystore", deviceKeys.getJSONObject(0).getString("provider"));
        assertEquals("server-update-fixture", snapshot.getJSONArray("accountBindings").getJSONObject(0).getString("serverId"));

        JSObject descriptor = storage.inspectKey(keyAlias);
        assertNotNull(descriptor);
        assertEquals(keyAlias, descriptor.getString("keyAlias"));
        assertEquals(fixture.getString("publicKey"), descriptor.getJSONObject("publicKey").getString("value"));

        JSObject unwrap = new JSObject();
        unwrap.put("keyAlias", keyAlias);
        unwrap.put("ownerId", fixture.getString("ownerId"));
        unwrap.put("wrapper", new JSObject(fixture.getJSONObject("accountMasterKeyWrapper").toString()));
        assertArrayEquals(decode(fixture.getString("expectedAccountMasterKey")), storage.unwrapAccountMasterKey(unwrap));
    }

    private static byte[] decode(String value) {
        return Base64.decode(value, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String resource(String name) throws Exception {
        try (InputStream input = CantripInstallationStorageUpdateTest.class.getClassLoader().getResourceAsStream(name)) {
            if (input == null) throw new IllegalStateException("Missing frozen update fixture " + name);
            try (Scanner scanner = new Scanner(input, StandardCharsets.UTF_8.name()).useDelimiter("\\A")) {
                return scanner.hasNext() ? scanner.next() : "";
            }
        }
    }
}
