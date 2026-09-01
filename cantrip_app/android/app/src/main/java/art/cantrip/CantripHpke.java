package art.cantrip;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPoint;
import java.security.spec.ECPublicKeySpec;
import java.util.Arrays;
import java.util.Base64;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

final class CantripHpke {

    private static final byte[] HPKE_INFO = "cantrip:e2ee:hpke-key-wrap:v1".getBytes(StandardCharsets.UTF_8);
    private static final byte[] KEM_SUITE_ID = concat("KEM".getBytes(StandardCharsets.US_ASCII), i2osp(0x0010, 2));
    private static final byte[] SUITE_ID = concat(
        "HPKE".getBytes(StandardCharsets.US_ASCII),
        i2osp(0x0010, 2),
        i2osp(0x0001, 2),
        i2osp(0x0002, 2)
    );

    private CantripHpke() {}

    static byte[] open(PrivateKey privateKey, byte[] recipientPublicKey, byte[] encapsulatedKey, byte[] ciphertext, byte[] aad)
        throws Exception {
        PublicKey ephemeralPublicKey = parsePublicKey(encapsulatedKey);
        KeyAgreement agreement = KeyAgreement.getInstance("ECDH");
        agreement.init(privateKey);
        agreement.doPhase(ephemeralPublicKey, true);
        byte[] dh = leftPad(agreement.generateSecret(), 32);
        byte[] kemContext = concat(encapsulatedKey, recipientPublicKey);
        byte[] eaePrk = labeledExtract(new byte[0], "eae_prk", dh, KEM_SUITE_ID);
        byte[] sharedSecret = labeledExpand(eaePrk, "shared_secret", kemContext, 32, KEM_SUITE_ID);
        byte[] pskIdHash = labeledExtract(new byte[0], "psk_id_hash", new byte[0], SUITE_ID);
        byte[] infoHash = labeledExtract(new byte[0], "info_hash", HPKE_INFO, SUITE_ID);
        byte[] keyScheduleContext = concat(new byte[] { 0 }, pskIdHash, infoHash);
        byte[] secret = labeledExtract(sharedSecret, "secret", new byte[0], SUITE_ID);
        byte[] key = labeledExpand(secret, "key", keyScheduleContext, 32, SUITE_ID);
        byte[] nonce = labeledExpand(secret, "base_nonce", keyScheduleContext, 12, SUITE_ID);
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, nonce));
            cipher.updateAAD(aad);
            return cipher.doFinal(ciphertext);
        } finally {
            clear(dh, kemContext, eaePrk, sharedSecret, pskIdHash, infoHash, keyScheduleContext, secret, key, nonce);
        }
    }

    static byte[] decodeBase64Url(String value, int expectedLength) throws Exception {
        if (value == null) throw new Exception("base64url-value-invalid");
        byte[] decoded;
        try {
            decoded = Base64.getUrlDecoder().decode(value);
        } catch (IllegalArgumentException error) {
            throw new Exception("base64url-value-invalid", error);
        }
        if (decoded.length != expectedLength || !encodeBase64Url(decoded).equals(value)) {
            Arrays.fill(decoded, (byte) 0);
            throw new Exception("base64url-value-invalid");
        }
        return decoded;
    }

    static String encodeBase64Url(byte[] value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }

    static byte[] publicKeyBytes(java.security.interfaces.ECPublicKey publicKey) {
        byte[] output = new byte[65];
        output[0] = 4;
        copyUnsigned(publicKey.getW().getAffineX().toByteArray(), output, 1, 32);
        copyUnsigned(publicKey.getW().getAffineY().toByteArray(), output, 33, 32);
        return output;
    }

    static byte[] associatedData(String ownerId, String clientId, long revision) {
        String canonical =
            "{\"component\":\"account-master-key\",\"field\":\"wrapped_master_key\",\"formatVersion\":1,\"keyRevision\":" +
            revision +
            ",\"ownerId\":" +
            quoteJson(ownerId) +
            ",\"rowId\":" +
            quoteJson(clientId) +
            ",\"table\":\"encryption_client_principals\"}";
        return canonical.getBytes(StandardCharsets.UTF_8);
    }

    private static PublicKey parsePublicKey(byte[] raw) throws Exception {
        if (raw.length != 65 || raw[0] != 4) throw new Exception("client-master-key-wrapper-invalid");
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec curve = parameters.getParameterSpec(ECParameterSpec.class);
        byte[] x = Arrays.copyOfRange(raw, 1, 33);
        byte[] y = Arrays.copyOfRange(raw, 33, 65);
        try {
            ECPoint point = new ECPoint(new java.math.BigInteger(1, x), new java.math.BigInteger(1, y));
            return KeyFactory.getInstance("EC").generatePublic(new ECPublicKeySpec(point, curve));
        } finally {
            clear(x, y);
        }
    }

    private static String quoteJson(String value) {
        StringBuilder result = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            switch (character) {
                case '"': result.append("\\\""); break;
                case '\\': result.append("\\\\"); break;
                case '\b': result.append("\\b"); break;
                case '\f': result.append("\\f"); break;
                case '\n': result.append("\\n"); break;
                case '\r': result.append("\\r"); break;
                case '\t': result.append("\\t"); break;
                default:
                    if (character < 0x20 || (Character.isSurrogate(character) && !validSurrogatePair(value, index))) {
                        result.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                    } else {
                        result.append(character);
                    }
            }
        }
        return result.append('"').toString();
    }

    private static boolean validSurrogatePair(String value, int index) {
        char character = value.charAt(index);
        return (
            (Character.isHighSurrogate(character) && index + 1 < value.length() && Character.isLowSurrogate(value.charAt(index + 1))) ||
            (Character.isLowSurrogate(character) && index > 0 && Character.isHighSurrogate(value.charAt(index - 1)))
        );
    }

    private static byte[] labeledExtract(byte[] salt, String label, byte[] ikm, byte[] suiteId) throws Exception {
        return hkdfExtract(salt, concat("HPKE-v1".getBytes(StandardCharsets.US_ASCII), suiteId, label.getBytes(StandardCharsets.US_ASCII), ikm));
    }

    private static byte[] labeledExpand(byte[] prk, String label, byte[] info, int length, byte[] suiteId) throws Exception {
        return hkdfExpand(
            prk,
            concat(i2osp(length, 2), "HPKE-v1".getBytes(StandardCharsets.US_ASCII), suiteId, label.getBytes(StandardCharsets.US_ASCII), info),
            length
        );
    }

    private static byte[] hkdfExtract(byte[] salt, byte[] ikm) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt.length == 0 ? new byte[32] : salt, "HmacSHA256"));
        return mac.doFinal(ikm);
    }

    private static byte[] hkdfExpand(byte[] prk, byte[] info, int length) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] previous = new byte[0];
        for (int counter = 1; output.size() < length; counter += 1) {
            mac.reset();
            mac.update(previous);
            mac.update(info);
            mac.update((byte) counter);
            previous = mac.doFinal();
            output.write(previous);
        }
        byte[] expanded = Arrays.copyOf(output.toByteArray(), length);
        Arrays.fill(previous, (byte) 0);
        return expanded;
    }

    private static byte[] i2osp(int value, int length) {
        byte[] result = new byte[length];
        for (int index = length - 1; index >= 0; index -= 1) {
            result[index] = (byte) (value & 0xff);
            value >>>= 8;
        }
        return result;
    }

    private static byte[] concat(byte[]... arrays) {
        int length = 0;
        for (byte[] array : arrays) length += array.length;
        byte[] result = new byte[length];
        int offset = 0;
        for (byte[] array : arrays) {
            System.arraycopy(array, 0, result, offset, array.length);
            offset += array.length;
        }
        return result;
    }

    private static byte[] leftPad(byte[] value, int length) throws Exception {
        if (value.length > length) throw new Exception("client-master-key-decryption-failed");
        if (value.length == length) return value;
        byte[] result = new byte[length];
        System.arraycopy(value, 0, result, length - value.length, value.length);
        Arrays.fill(value, (byte) 0);
        return result;
    }

    private static void copyUnsigned(byte[] source, byte[] destination, int offset, int length) {
        int start = Math.max(0, source.length - length);
        int count = Math.min(length, source.length);
        System.arraycopy(source, start, destination, offset + length - count, count);
        Arrays.fill(source, (byte) 0);
    }

    static void clear(byte[]... values) {
        for (byte[] value : values) if (value != null) Arrays.fill(value, (byte) 0);
    }
}
