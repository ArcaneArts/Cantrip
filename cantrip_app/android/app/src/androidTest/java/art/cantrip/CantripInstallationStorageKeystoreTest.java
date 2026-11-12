package art.cantrip;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Comparator;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public final class CantripInstallationStorageKeystoreTest {

    @Test
    public void createsAndReopensAnInstallationKeyWithAndroidKeystore() throws Exception {
        Context app = ApplicationProvider.getApplicationContext();
        String installationId = UUID.randomUUID().toString();
        String keyAlias = "cantrip.installation." + installationId + ".hpke.v1";
        String testName = "cantrip-keystore-test-" + installationId;
        File directory = new File(app.getCacheDir(), testName);
        Context fixture = new ContextWrapper(app) {
            @Override
            public File getFilesDir() {
                return directory;
            }

            @Override
            public SharedPreferences getSharedPreferences(String name, int mode) {
                return app.getSharedPreferences(testName, mode);
            }
        };
        try {
            CantripInstallationStorage storage = new CantripInstallationStorage(fixture);
            JSObject profile = new JSObject()
                .put("installationId", installationId)
                .put("createdAt", Instant.now().toString())
                .put("schemaVersion", 1);
            JSObject create = new JSObject().put("type", "create-installation").put("profile", profile);
            storage.applyCatalogTransaction(
                new JSObject().put("expectedRevision", 0).put("operations", new JSONArray().put(create))
            );

            JSObject created = storage.createKey(new JSObject().put("installationId", installationId).put("keyAlias", keyAlias));
            JSObject reopened = new CantripInstallationStorage(fixture).inspectKey(keyAlias);
            assertNotNull(reopened);
            assertEquals("android-keystore", reopened.getString("provider"));
            assertEquals(created.getJSONObject("publicKey").getString("value"), reopened.getJSONObject("publicKey").getString("value"));
        } finally {
            KeyStore keystore = KeyStore.getInstance("AndroidKeyStore");
            keystore.load(null);
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(keyAlias.getBytes(StandardCharsets.UTF_8));
            keystore.deleteEntry("cantrip.installation.wrap.v1." + CantripHpke.encodeBase64Url(digest));
            app.deleteSharedPreferences(testName);
            if (directory.isDirectory()) {
                try (Stream<Path> files = Files.walk(directory.toPath())) {
                    for (Path file : files.sorted(Comparator.reverseOrder()).collect(Collectors.toList())) {
                        Files.deleteIfExists(file);
                    }
                }
            }
        }
    }
}
