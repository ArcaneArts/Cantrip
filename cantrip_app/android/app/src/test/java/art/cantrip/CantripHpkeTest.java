package art.cantrip;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.AlgorithmParameters;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.ECParameterSpec;
import java.security.spec.ECPrivateKeySpec;
import java.util.Arrays;
import org.junit.Test;

public class CantripHpkeTest {

    @Test
    public void opensTypeScriptHpkeFixture() throws Exception {
        byte[] privateScalar = CantripHpke.decodeBase64Url("GWNtSM7CrLBobff0RFc_ShU9pQNYlyleLZ9PF-4oz24", 32);
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec curve = parameters.getParameterSpec(ECParameterSpec.class);
        PrivateKey privateKey = KeyFactory.getInstance("EC").generatePrivate(
            new ECPrivateKeySpec(new BigInteger(1, privateScalar), curve)
        );
        byte[] recipientPublicKey = CantripHpke.decodeBase64Url(
            "BFm_YxDfIRPBuAS45UTQYjE8vzxylVItLMAVyHFU6lIiPo7gCNlzos45NP7Dn2vfhj1cxO-yYGwrBdlAmOzin1M",
            65
        );
        byte[] encapsulated = CantripHpke.decodeBase64Url(
            "BGkT85BaSxTdeamdxr3Q7440QJ112z-MkNB2QpGOgju-WoxFFPNqLg5UJPeKwd1vBbR1KRDY0pIukEgUYVXbSCE",
            65
        );
        byte[] ciphertext = CantripHpke.decodeBase64Url(
            "98u_jm9tt8G_c3OwxvFx7fZOicyrsoK3La8XB1RRGsDneXd6gMaFpkb77z5BN98v",
            48
        );
        byte[] aad = CantripHpke.associatedData("owner-typescript-fixture", "principal-typescript-fixture", 7);
        byte[] opened = CantripHpke.open(privateKey, recipientPublicKey, encapsulated, ciphertext, aad);
        try {
            byte[] expected = new byte[32];
            Arrays.fill(expected, (byte) 47);
            assertArrayEquals(expected, opened);
        } finally {
            CantripHpke.clear(privateScalar, recipientPublicKey, encapsulated, ciphertext, aad, opened);
        }
    }

    @Test
    public void associatedDataMatchesTheCanonicalTypeScriptEncoding() {
        assertEquals(
            "{\"component\":\"account-master-key\",\"field\":\"wrapped_master_key\",\"formatVersion\":1,\"keyRevision\":4,\"ownerId\":\"owner\\nA\",\"rowId\":\"principal-ß\",\"table\":\"encryption_client_principals\"}",
            new String(CantripHpke.associatedData("owner\nA", "principal-ß", 4), StandardCharsets.UTF_8)
        );
    }
}
