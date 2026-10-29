# Security Checklist

Each item has a one-line reason. Snippets show the correct shape where the wrong shape is common. The threat model for a typical app: a lost or rooted device, a hostile network, a malicious app on the same device, and a decompiled APK. Secrets on the client are never fully safe; the goal is to raise cost and limit blast radius.

## Secrets and credentials storage

- [ ] No API keys, tokens or passwords in source, `strings.xml`, `BuildConfig` fields or `local.properties` committed to git; anything in the APK is readable with `apktool` in minutes.
- [ ] Server-side secrets stay on the server; the app authenticates a user and receives a short-lived token. An "API key" that must ship in the APK is treated as public and rate-limited server-side.
- [ ] `EncryptedSharedPreferences` and `EncryptedFile` (androidx.security:security-crypto) are not used in new code; the library is deprecated and unmaintained. Existing uses are migrated.
- [ ] Tokens stored in DataStore 1.2.1 with values encrypted by a key from the Android Keystore (AES-GCM via Tink or `javax.crypto` directly); the Keystore key never leaves hardware, so a file copy from a rooted device is useless without the device.

```kotlin
// Keystore-backed AES key; generated once, never exported.
private fun getOrCreateKey(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry("token_key", null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
        KeyGenParameterSpec.Builder("token_key", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build(),
    )
    return gen.generateKey()
}

fun encrypt(plain: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, getOrCreateKey()) }
    return cipher.iv + cipher.doFinal(plain)   // 12-byte IV prefixed; store the whole blob in DataStore
}
```

- [ ] Keystore key marked `setUserAuthenticationRequired(true)` with a timeout or biometric binding for high-value secrets (payment tokens), so a stolen unlocked device still needs the user.
- [ ] Keys that must be invalidated when biometrics change use `setInvalidatedByBiometricEnrollment(true)`.
- [ ] Nothing sensitive in `SharedPreferences`, plain DataStore, external storage or logs; `adb backup` and file managers read all of those on some devices.
- [ ] `android:allowBackup` set deliberately; if true, `dataExtractionRules` excludes token files so cloud backup does not carry credentials to another device.

## Network

- [ ] Cleartext traffic disabled (default since targetSdk 28); no `usesCleartextTraffic="true"`, and the network security config lists only the debug-build exceptions.

```xml
<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false">
        <trust-anchors><certificates src="system" /></trust-anchors>
    </base-config>
    <debug-overrides>
        <trust-anchors><certificates src="user" /></trust-anchors>   <!-- lets Charles/mitmproxy work in debug only -->
    </debug-overrides>
</network-security-config>
```

- [ ] `android:networkSecurityConfig="@xml/network_security_config"` set on `<application>`.
- [ ] User-installed CAs trusted only under `<debug-overrides>`; a production build that trusts user CAs is trivially intercepted.
- [ ] Certificate pinning used only if the team can rotate pins before the certificate expires. A pin set without a backup pin and an expiry has bricked apps; prefer network security config `<pin-set expiration="...">` with at least two pins, or skip pinning and rely on system CAs plus Certificate Transparency.
- [ ] No custom `TrustManager` or `HostnameVerifier` that accepts everything; the Play pre-launch report flags these and Play can reject the app.
- [ ] Tokens sent in the `Authorization` header, never in query strings (they land in server logs and proxies).
- [ ] Token refresh handled by an OkHttp `Authenticator`, with refresh tokens rotated server-side and revoked on logout.
- [ ] OkHttp `HttpLoggingInterceptor` at `BODY` level only in debug builds.

## App components

- [ ] `android:exported` is explicit on every component. Components with an intent filter default to exported; everything else should be `false`.
- [ ] Exported Activities validate every extra and `data` URI before use; an exported Activity that opens `intent.data` in a WebView is an open redirect.
- [ ] Deep link arguments treated as untrusted: check format, bounds and authorization in the ViewModel before loading (see [../patterns/navigation.md](../patterns/navigation.md)).
- [ ] Broadcast receivers that must be app-internal are registered with `RECEIVER_NOT_EXPORTED` (required on API 34+ for runtime registration).
- [ ] `ContentProvider`s not exported unless shared by design; shared ones use `android:grantUriPermissions` with `FileProvider` and never expose raw file paths.
- [ ] Pending intents created with `FLAG_IMMUTABLE` unless a specific reason requires mutability (required on targetSdk 31+).
- [ ] Implicit intents sent with `Intent.createChooser` or an explicit package when the target is known; implicit intents with sensitive extras can be caught by any app that declares the filter.
- [ ] Custom URL schemes avoided for auth callbacks; use App Links (`https` with `autoVerify`) so another app cannot claim the scheme.
- [ ] Task hijacking mitigated: `android:taskAffinity=""` on the launcher Activity or `launchMode="singleTask"`, so a malicious app cannot insert itself into the task.

## WebView

- [ ] WebView used only when necessary; `Custom Tabs` (`androidx.browser`) for external web content gives the system browser's security and sign-in state.
- [ ] `javaScriptEnabled` only if the content needs it; `allowFileAccess = false`, `allowContentAccess = false`, `allowFileAccessFromFileURLs = false` (the last two are false by default on modern targets; set them anyway).
- [ ] `addJavascriptInterface` only for first-party pages, and the WebView only loads URLs from an allowlist checked in `shouldOverrideUrlLoading`; a bridge exposed to arbitrary pages is remote code execution.
- [ ] `setWebContentsDebuggingEnabled(BuildConfig.DEBUG)` so release WebViews are not inspectable.
- [ ] Safe Browsing left enabled (default) and `WebViewAssetLoader` used for bundled HTML instead of `file://`.

## Platform integrity and user verification

- [ ] Play Integrity API used for high-value actions (purchases, account changes), verified server-side; the verdict is a signal, not a gate, and the app degrades gracefully on an unverifiable device.
- [ ] No homegrown root detection presented as a security control; it is trivially bypassed. Use it for telemetry if at all.
- [ ] Biometric gating via `androidx.biometric` with `BIOMETRIC_STRONG` and a `CryptoObject` bound to the Keystore key when protecting a secret; a biometric prompt without a crypto object can be bypassed by hooking the callback.
- [ ] Fallback to device credential (`DEVICE_CREDENTIAL`) offered so users without enrolled biometrics are not locked out.
- [ ] Sensitive screens set `FLAG_SECURE` on the window to block screenshots and screen recording where the product requires it (banking, health).
- [ ] Sign-in uses Credential Manager 1.6.0 (passkeys, Sign in with Google, saved passwords) rather than a custom password form plus a third-party SDK.

## Input validation

- [ ] Room queries parameterized (`:param` in `@Query`); never string-concatenate into `@RawQuery` or `SupportSQLiteDatabase.execSQL`.
- [ ] File names from untrusted sources sanitized before use in a path (`..` and `/` rejected) and files written only under the app's own directories.
- [ ] Sizes bounded on uploads and decodes (an attacker-provided 20,000 x 20,000 image is a denial of service).
- [ ] Intent extras read with explicit types and null checks; `getParcelableExtra(name, Class)` on API 33+.

## Logging and diagnostics

- [ ] No tokens, passwords, personal data or full request bodies in logs; `Log.d` output is readable by any app with `READ_LOGS` on older devices and by anyone with `adb` on all of them.
- [ ] Crash reporter configured to scrub identifiers; breadcrumbs carry screen names and event types, not user content.
- [ ] Debug-only logging stripped by R8 with `-assumenosideeffects class android.util.Log { public static *** d(...); public static *** v(...); }` or routed through a facade that is a no-op in release.

## Build and dependencies

- [ ] R8 enabled on release for obfuscation; it does not protect secrets but raises the cost of reading the code.
- [ ] Mapping file kept per release so crash reports deobfuscate.
- [ ] Dependency scanning in CI: `./gradlew dependencyUpdates` (ben-manes plugin) or Renovate for freshness, and OWASP Dependency-Check or GitHub Dependabot alerts for known CVEs in transitive dependencies.
- [ ] Lint security checks enabled and failing the build: `ExportedContentProvider`, `ExportedReceiver`, `SetJavaScriptEnabled`, `TrustAllX509TrustManager`, `UnsafeProtectedBroadcastReceiver`, `HardcodedDebugMode`.
- [ ] Secrets scanning (`gitleaks` or `trufflehog`) runs on every push so a committed keystore password is caught before it spreads.
- [ ] Signing keys stored in CI secrets; keystore file never committed (see [release.md](release.md)).
- [ ] Third-party SDKs reviewed for permissions they add to the merged manifest and data they collect; both must appear in the Data safety form.

## Permissions

- [ ] Least privilege: Photo Picker instead of media permissions, `ACCESS_COARSE_LOCATION` unless fine is essential, no `READ_PHONE_STATE`.
- [ ] Runtime permissions requested in context with a rationale when `shouldShowRequestPermissionRationale` is true; handle permanent denial by linking to app settings.
- [ ] Permissions removed from the manifest when the feature is removed.

## Verify

```sh
./gradlew :app:lintRelease
./gradlew :app:assembleRelease
# Confirm no cleartext permitted and config is referenced:
grep -n networkSecurityConfig app/build/intermediates/merged_manifests/release/AndroidManifest.xml
# Look for secrets that survived into the APK:
unzip -p app/build/outputs/apk/release/app-release.apk classes.dex | strings | grep -iE "api[_-]?key|secret|password" | head
# Exported components in the installed app:
adb shell dumpsys package com.example.app | grep -A2 -i "exported"
```

Run the pre-launch report on an internal test track; it includes an automated security scan. Treat its findings as blocking.

## Sources

- https://developer.android.com/privacy-and-security/security-tips
- https://developer.android.com/privacy-and-security/security-best-practices
- https://developer.android.com/privacy-and-security/cryptography
- https://developer.android.com/privacy-and-security/keystore
- https://developer.android.com/privacy-and-security/security-config
- https://developer.android.com/topic/libraries/architecture/datastore
- https://developer.android.com/jetpack/androidx/releases/security
- https://developer.android.com/identity/sign-in/biometric-auth
- https://developer.android.com/identity/sign-in/credential-manager
- https://developer.android.com/google/play/integrity
- https://developer.android.com/develop/ui/views/layout/webapps/managing-webview
- https://developer.android.com/privacy-and-security/risks
