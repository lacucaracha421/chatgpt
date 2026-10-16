package com.lakomics.mobile;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import java.math.BigInteger;
import java.net.Socket;
import java.security.*;
import java.security.cert.X509Certificate;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.*;
import javax.net.ssl.*;
import javax.security.auth.x500.X500Principal;

/** The private key never leaves AndroidKeyStore. TLS asks it to sign through this key manager. */
final class LanIdentity extends X509ExtendedKeyManager {
    private static final String ALIAS = "lakomics.lan";
    private final PrivateKey key;
    private final X509Certificate certificate;
    final String fingerprint;

    private LanIdentity(PrivateKey key, X509Certificate certificate) throws Exception {
        this.key = key; this.certificate = certificate;
        fingerprint = ExchangeTransfer.hex(ExchangeTransfer.sha().digest(certificate.getEncoded()));
    }

    static synchronized LanIdentity load(String deviceId) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        X500Principal subject = new X500Principal("CN=Lakomics " + deviceId);
        try { return read(store, subject); }
        catch (Exception unusable) {
            if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS);
            Calendar end = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            end.clear(); end.set(2100, Calendar.JANUARY, 1);
            KeyPairGenerator generator = KeyPairGenerator.getInstance("EC", "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    // Conscrypt signs the TLS 1.3 CertificateVerify over a digest it computed itself (NONEwithECDSA),
                    // so the key must allow DIGEST_NONE as well as the hashed forms.
                    .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384, KeyProperties.DIGEST_SHA512)
                    .setCertificateSubject(subject).setCertificateSerialNumber(BigInteger.ONE)
                    .setCertificateNotBefore(new Date(0)).setCertificateNotAfter(end.getTime()).build());
            generator.generateKeyPair();
            return read(store, subject);
        }
    }

    private static LanIdentity read(KeyStore store, X500Principal subject) throws Exception {
        PrivateKey key = (PrivateKey) store.getKey(ALIAS, null);
        X509Certificate cert = (X509Certificate) store.getCertificate(ALIAS);
        if (key == null || cert == null || !subject.equals(cert.getSubjectX500Principal())
                || !(cert.getPublicKey() instanceof ECPublicKey)
                || ((ECPublicKey) cert.getPublicKey()).getParams().getCurve().getField().getFieldSize() != 256)
            throw new KeyStoreException("Unusable LAN identity");
        cert.verify(cert.getPublicKey());
        byte[] probe = new byte[32]; new SecureRandom().nextBytes(probe);
        // Probe the raw form TLS uses; a key made before DIGEST_NONE was allowed fails here and is replaced.
        Signature signer = Signature.getInstance("NONEwithECDSA"); signer.initSign(key); signer.update(probe);
        byte[] signature = signer.sign();
        signer.initVerify(cert.getPublicKey()); signer.update(probe);
        if (!signer.verify(signature)) throw new KeyStoreException("LAN certificate/key mismatch");
        return new LanIdentity(key, cert);
    }

    private String alias(String type) { return type != null && type.startsWith("EC") ? ALIAS : null; }
    public String chooseServerAlias(String type, Principal[] issuers, Socket socket) { return alias(type); }
    public String chooseEngineServerAlias(String type, Principal[] issuers, SSLEngine engine) { return alias(type); }
    public String chooseClientAlias(String[] types, Principal[] issuers, Socket socket) {
        for (String type : types) if (alias(type) != null) return ALIAS;
        return null;
    }
    public String chooseEngineClientAlias(String[] types, Principal[] issuers, SSLEngine engine) { return chooseClientAlias(types, issuers, null); }
    public String[] getClientAliases(String type, Principal[] issuers) { return alias(type) == null ? null : new String[]{ALIAS}; }
    public String[] getServerAliases(String type, Principal[] issuers) { return getClientAliases(type, issuers); }
    public PrivateKey getPrivateKey(String alias) { return ALIAS.equals(alias) ? key : null; }
    public X509Certificate[] getCertificateChain(String alias) { return ALIAS.equals(alias) ? new X509Certificate[]{certificate} : null; }
}
