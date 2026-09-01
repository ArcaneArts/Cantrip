package art.cantrip;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CantripInstallationStorage")
public final class CantripInstallationStoragePlugin extends Plugin {

    private CantripInstallationStorage storage;

    @Override
    public void load() {
        storage = new CantripInstallationStorage(getContext().getApplicationContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(storage.status());
    }

    @PluginMethod
    public void readCatalog(PluginCall call) {
        resolve(call, () -> storage.readCatalog());
    }

    @PluginMethod
    public void applyCatalogTransaction(PluginCall call) {
        resolve(call, () -> {
            JSObject request = call.getObject("request");
            if (request == null) throw new CantripInstallationStorage.StorageException("installation-catalog-corrupt");
            return storage.applyCatalogTransaction(request);
        });
    }

    @PluginMethod
    public void createKey(PluginCall call) {
        resolve(call, () -> {
            JSObject input = call.getObject("input");
            if (input == null) throw new CantripInstallationStorage.StorageException("native-device-key-invalid");
            return storage.createKey(input);
        });
    }

    @PluginMethod
    public void replaceMissingKey(PluginCall call) {
        resolve(call, () -> {
            JSObject input = call.getObject("input");
            if (input == null) throw new CantripInstallationStorage.StorageException("native-device-key-invalid");
            return storage.replaceMissingKey(input);
        });
    }

    @PluginMethod
    public void inspectKey(PluginCall call) {
        try {
            String keyAlias = call.getString("keyAlias");
            if (keyAlias == null) throw new CantripInstallationStorage.StorageException("native-device-key-invalid");
            JSObject result = storage.inspectKey(keyAlias);
            if (result == null) call.resolve(); else call.resolve(result);
        } catch (CantripInstallationStorage.StorageException error) {
            call.reject(error.code, error.code, error);
        }
    }

    @PluginMethod
    public void unwrapAccountMasterKey(PluginCall call) {
        resolve(call, () -> {
            JSObject input = call.getObject("input");
            if (input == null) throw new CantripInstallationStorage.StorageException("client-master-key-wrapper-invalid");
            byte[] plaintext = storage.unwrapAccountMasterKey(input);
            try {
                JSArray bytes = new JSArray();
                for (byte value : plaintext) bytes.put(value & 0xff);
                return new JSObject().put("bytes", bytes);
            } finally {
                CantripHpke.clear(plaintext);
            }
        });
    }

    private interface Operation {
        JSObject run() throws CantripInstallationStorage.StorageException;
    }

    private void resolve(PluginCall call, Operation operation) {
        try {
            call.resolve(operation.run());
        } catch (CantripInstallationStorage.StorageException error) {
            call.reject(error.code, error.code, error);
        } catch (Exception error) {
            call.reject("native-storage-task-failed", "native-storage-task-failed", error);
        }
    }
}
