import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

import org.tizen.common.util.CipherUtil;

// Prints a certificate password (read from standard input) in the encrypted form the
// Tizen CLI decrypts from profiles.xml without a platform keyring.
public final class EncryptProfilePassword {
    public static void main(String[] args) throws Exception {
        String password = new String(readAll(System.in), StandardCharsets.UTF_8);
        if (password.isEmpty()) {
            throw new IllegalArgumentException("empty password on standard input");
        }
        String encrypted = CipherUtil.getEncryptedString(password);
        if (!password.equals(CipherUtil.getDecryptedString(encrypted))) {
            throw new IllegalStateException("encrypted password does not decrypt to the input");
        }
        System.out.print(encrypted);
    }

    // Java 8 compatible: the Tizen SDK bundles a Java 8 runtime.
    private static byte[] readAll(InputStream input) throws java.io.IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[256];
        for (int read; (read = input.read(chunk)) != -1;) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }
}
