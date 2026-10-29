# Network security config

Declarative TLS policy with `res/xml/network_security_config.xml`: cleartext blocked everywhere, per-domain certificate pinning with backup pins and an expiry, a debug-only override that trusts user-added CAs for proxy inspection, OkHttp's `CertificatePinner` as a complementary layer, and tests that prove cleartext and wrong-pin connections fail.

## When to use

- Every app that talks to a server. The platform default blocks cleartext from API 28, but an explicit config documents the policy, lets you pin high-value domains and gives debug builds a safe way to inspect traffic.
- Pinning protects against a compromised CA; it also bricks networking if you rotate certificates without updating pins. Only pin domains you control, always include a backup pin, and set an expiration.

## Dependencies

None for the config itself. OkHttp pinning uses the client already set up in [retrofit-networking](../retrofit-networking/README.md).

```toml
[libraries]
okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version = "<version>" }   # https://square.github.io/okhttp/changelogs/changelog/
okhttp-tls = { group = "com.squareup.okhttp3", name = "okhttp-tls", version = "<version>" }   # test-only helpers
```

## Manifest and permissions

```xml
<application
    android:networkSecurityConfig="@xml/network_security_config"
    android:usesCleartextTraffic="false"
    ...>
```

`usesCleartextTraffic` is ignored when a config is present but keeps the intent visible to reviewers.

## Implementation

### Main config

`res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Default for every domain: TLS only, system CAs only. -->
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>

    <!-- Pin the API host. Pins are SHA-256 of the Subject Public Key Info, base64. -->
    <domain-config>
        <domain includeSubdomains="true">api.example.com</domain>
        <pin-set expiration="2027-06-30">
            <pin digest="SHA-256">REPLACE_WITH_LEAF_OR_INTERMEDIATE_SPKI_BASE64=</pin>
            <pin digest="SHA-256">REPLACE_WITH_BACKUP_KEY_SPKI_BASE64=</pin>
        </pin-set>
    </domain-config>
</network-security-config>
```

The second pin must belong to a key you hold offline (a backup CSR's public key) or to the next intermediate CA, so a rotation does not require an app update first. After `expiration` the pins are ignored rather than failing; set it a little before the planned rotation and ship an update with new pins before then.

Compute a pin from a certificate or public key:

```sh
openssl s_client -connect api.example.com:443 -servername api.example.com </dev/null 2>/dev/null \
  | openssl x509 -pubkey -noout \
  | openssl pkey -pubin -outform der \
  | openssl dgst -sha256 -binary | base64
```

### Debug override

`src/debug/res/xml/network_security_config.xml` (same resource name; the debug source set wins):

```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />   <!-- lets a proxy such as Charles or mitmproxy inspect debug traffic -->
        </trust-anchors>
    </base-config>

    <!-- Local backend during development -->
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">10.0.2.2</domain>
        <domain includeSubdomains="false">localhost</domain>
    </domain-config>

    <debug-overrides>
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>
```

`<debug-overrides>` applies only when `android:debuggable="true"`, so even if this file leaked into a release build the user-CA trust would not. Keeping the whole file in `src/debug` adds a second layer. Do not pin in debug; proxies cannot satisfy pins.

### OkHttp pinning (optional second layer)

```kotlin
@Provides @Singleton
fun provideOkHttp(auth: AuthInterceptor): OkHttpClient = OkHttpClient.Builder()
    .addInterceptor(auth)
    .apply {
        if (!BuildConfig.DEBUG) {
            certificatePinner(
                CertificatePinner.Builder()
                    .add("api.example.com", "sha256/REPLACE_WITH_LEAF_OR_INTERMEDIATE_SPKI_BASE64=")
                    .add("api.example.com", "sha256/REPLACE_WITH_BACKUP_KEY_SPKI_BASE64=")
                    .build()
            )
        }
    }
    .build()
```

The platform config covers every `HttpsURLConnection`, OkHttp and WebView connection; the OkHttp pinner adds nothing on API 24+ except a clearer exception (`SSLPeerUnverifiedException` with the observed pins in its message), which is useful for diagnosing a rotation. Pick one or keep both in sync; never let them disagree.

### Error mapping

A pin failure surfaces as `javax.net.ssl.SSLPeerUnverifiedException` or `SSLHandshakeException`, both `IOException`s. Map them to a distinct state so the UI can say "secure connection failed, update the app" rather than "you are offline":

```kotlin
catch (e: SSLPeerUnverifiedException) { NetworkResult.Unexpected(e) }   // before the generic IOException branch
```

Report it as a non-fatal to [crash-reporting](../crash-reporting/README.md) with the host as a key; a spike means a rotation went wrong.

## Verify

```sh
./gradlew :app:assembleDebug :app:assembleRelease
# The config is merged into the APK; check the release one contains no user trust anchors:
unzip -p app/build/outputs/apk/release/app-release.apk res/xml/network_security_config.xml | strings | grep -c user   # expect 0
./gradlew :app:lintRelease     # flags cleartext permitted in release or missing pins expiration
./gradlew :app:connectedReleaseAndroidTest --tests "*NetworkPolicyTest*"
```

Instrumented tests (release variant so the real config applies; needs `testBuildType = "release"` or a separate `staging` build type with `debuggable=false`):

```kotlin
@RunWith(AndroidJUnit4::class)
class NetworkPolicyTest {
    private val client = OkHttpClient()

    @Test(expected = IOException::class)
    fun cleartextIsBlocked() {
        client.newCall(Request.Builder().url("http://example.com/").build()).execute()   // UnknownServiceException: CLEARTEXT not permitted
    }

    @Test
    fun pinnedHostConnects() {
        val response = client.newCall(Request.Builder().url("https://api.example.com/health").build()).execute()
        assertTrue(response.isSuccessful)
    }

    @Test(expected = SSLPeerUnverifiedException::class)
    fun wrongPinFails() {
        val pinned = OkHttpClient.Builder().certificatePinner(
            CertificatePinner.Builder().add("api.example.com", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=").build()
        ).build()
        pinned.newCall(Request.Builder().url("https://api.example.com/health").build()).execute()
    }
}
```

The third test exercises OkHttp's pinner; to exercise the platform config's pins, point a test domain-config at a host whose key you know does not match and assert `SSLHandshakeException`. State which layer each test covers.

## Pitfalls

- Pinning a leaf certificate with a 90-day lifetime (Let's Encrypt) without a backup pin breaks the app every renewal. Pin the intermediate or your own backup key.
- Forgetting `expiration` turns a mistake into a permanent outage until users update.
- `includeSubdomains="true"` on a pinned apex domain pins CDNs and third-party subdomains you do not control.
- User CAs in the release config let any installed CA intercept traffic; keep `src="user"` under `debug-overrides` or the debug source set only.
- Cleartext exceptions for `localhost` do not cover `10.0.2.2` and vice versa; list both for emulator work.
- `WebView` honors the config, but a `WebView` loading mixed content still needs `mixedContentMode` set to `MIXED_CONTENT_NEVER_ALLOW`.
- The config is static; a server-side rotation needs a coordinated app release with new pins before the old expiration.

## Sources

- https://developer.android.com/privacy-and-security/security-config
- https://developer.android.com/privacy-and-security/security-ssl
- https://square.github.io/okhttp/features/https/
- https://developer.android.com/privacy-and-security/security-best-practices
