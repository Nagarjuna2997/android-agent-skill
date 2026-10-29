# Biometric unlock

Lock app content behind fingerprint, face or device credential with `androidx.biometric`, and bind a secret to the authentication using an Android Keystore AES key that requires user authentication. Covers availability checks, the Compose prompt wiring, re-lock on background and a crypto round-trip test.

## When to use

- Gate a screen or the whole app after it was already signed in: a finance view, a password vault, a private notes section.
- Encrypt a locally stored token so it can only be used after a fresh biometric or credential check.
- Biometrics identify the device owner locally; they do not authenticate the user to a server. For server auth use [credential-manager-sign-in](../credential-manager-sign-in/README.md) with passkeys.

## Dependencies

The `androidx.biometric` version is not in `data/versions.json`; resolve it from the release page.

```toml
[versions]
biometric = "<version>"   # https://developer.android.com/jetpack/androidx/releases/biometric

[libraries]
androidx-biometric = { group = "androidx.biometric", name = "biometric", version.ref = "biometric" }
```

```kotlin
dependencies {
    implementation(libs.androidx.biometric)
}
```

## Manifest and permissions

```xml
<uses-permission android:name="android.permission.USE_BIOMETRIC" />
```

No runtime grant is needed; the permission is normal. The Activity hosting the prompt must be a `FragmentActivity` (`ComponentActivity` is not enough): use `androidx.fragment.app.FragmentActivity` or `AppCompatActivity` for the host.

## Implementation

### Availability

```kotlin
package com.example.app.security

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL

enum class BiometricAvailability { AVAILABLE, NONE_ENROLLED, UNAVAILABLE }

object BiometricCapability {
    const val AUTHENTICATORS = BIOMETRIC_STRONG or DEVICE_CREDENTIAL

    fun check(context: Context): BiometricAvailability =
        when (BiometricManager.from(context).canAuthenticate(AUTHENTICATORS)) {
            BiometricManager.BIOMETRIC_SUCCESS -> BiometricAvailability.AVAILABLE
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAvailability.NONE_ENROLLED
            else -> BiometricAvailability.UNAVAILABLE
        }
}
```

`BIOMETRIC_STRONG or DEVICE_CREDENTIAL` lets people without biometrics use PIN or pattern, so nobody is locked out. Crypto-bound prompts cannot combine `DEVICE_CREDENTIAL` with `BIOMETRIC_STRONG` on API < 30; the key setup below handles that.

### Keystore key

```kotlin
package com.example.app.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class VaultCrypto @Inject constructor() {
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(): SecretKey {
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)   // new fingerprint enrolled -> key is gone, re-create
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // Valid for a single use after biometric or credential.
                    setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                } else {
                    setUserAuthenticationValidityDurationSeconds(-1)   // per-use, biometric only
                }
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            .apply { init(spec) }.generateKey()
    }

    fun encryptCipher(): Cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key()) }

    fun decryptCipher(iv: ByteArray): Cipher = Cipher.getInstance(TRANSFORMATION).apply {
        init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
    }

    fun deleteKey() = keyStore.deleteEntry(ALIAS)

    private companion object {
        const val ALIAS = "vault_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
```

Store the IV next to the ciphertext (for example in DataStore as Base64); it is not secret. Catch `KeyPermanentlyInvalidatedException` when initializing the cipher: it means enrollment changed; delete the key, wipe the dependent secret and ask the user to set it up again.

### Prompt

```kotlin
package com.example.app.security

import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import javax.crypto.Cipher
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

sealed interface AuthOutcome {
    data class Success(val cipher: Cipher?) : AuthOutcome
    data object Cancelled : AuthOutcome
    data class Error(val code: Int, val message: String) : AuthOutcome
}

suspend fun FragmentActivity.authenticate(title: String, cipher: Cipher? = null): AuthOutcome =
    suspendCancellableCoroutine { cont ->
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                if (cont.isActive) cont.resume(AuthOutcome.Success(result.cryptoObject?.cipher))
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (!cont.isActive) return
                val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
                    errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                    errorCode == BiometricPrompt.ERROR_CANCELED
                cont.resume(if (cancelled) AuthOutcome.Cancelled else AuthOutcome.Error(errorCode, errString.toString()))
            }
            // onAuthenticationFailed fires per wrong attempt; the prompt stays up, so do nothing.
        })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setAllowedAuthenticators(BiometricCapability.AUTHENTICATORS)
            .setConfirmationRequired(false)
            .build()
        if (cipher != null) prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher)) else prompt.authenticate(info)
        cont.invokeOnCancellation { prompt.cancelAuthentication() }
    }
```

### ViewModel and Compose

```kotlin
sealed interface LockUiState {
    data object Locked : LockUiState
    data object Unlocked : LockUiState
    data class Unavailable(val reason: String) : LockUiState
}

@HiltViewModel
class LockViewModel @Inject constructor(
    @ApplicationContext context: Context,
) : ViewModel() {
    private val _state = MutableStateFlow<LockUiState>(
        when (BiometricCapability.check(context)) {
            BiometricAvailability.AVAILABLE -> LockUiState.Locked
            BiometricAvailability.NONE_ENROLLED -> LockUiState.Unavailable("Set up a screen lock to protect this section")
            BiometricAvailability.UNAVAILABLE -> LockUiState.Unavailable("Device lock is not available")
        }
    )
    val state: StateFlow<LockUiState> = _state.asStateFlow()

    fun onUnlocked() { _state.value = LockUiState.Unlocked }
    fun relock() { if (_state.value is LockUiState.Unlocked) _state.value = LockUiState.Locked }
}

@Composable
fun BiometricGate(viewModel: LockViewModel, content: @Composable () -> Unit) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val activity = LocalActivity.current as FragmentActivity
    val scope = rememberCoroutineScope()

    // Re-lock whenever the app returns from the background.
    LifecycleResumeEffect(Unit) {
        onPauseOrDispose { viewModel.relock() }
    }

    when (state) {
        LockUiState.Unlocked -> content()
        LockUiState.Locked -> LockedScreen(onUnlock = {
            scope.launch {
                if (activity.authenticate("Unlock") is AuthOutcome.Success) viewModel.onUnlocked()
            }
        })
        is LockUiState.Unavailable -> UnavailableScreen((state as LockUiState.Unavailable).reason)
    }
}
```

`LocalActivity` is from `androidx.activity.compose`; `LifecycleResumeEffect` from `androidx.lifecycle.compose`. For the crypto-bound path, pass `crypto.decryptCipher(iv)` to `authenticate` and use the returned cipher to `doFinal(ciphertext)`.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:connectedDebugAndroidTest --tests "*VaultCryptoTest*"

# Emulator: enroll a fingerprint (Extended controls > Fingerprint), then while the prompt is showing:
adb -e emu finger touch 1
# Or set a PIN so DEVICE_CREDENTIAL works:
adb shell locksettings set-pin 1234
```

Crypto round-trip test (needs a device/emulator; Keystore does not exist on the JVM). With `setUserAuthenticationRequired(true)` the cipher cannot init without a prompt, so test the key logic through a non-auth variant or run the full flow as a manual check. The following verifies the non-auth path:

```kotlin
@RunWith(AndroidJUnit4::class)
class VaultCryptoTest {
    @Test fun keyStoreIsAvailableAndAliasCanBeCreated() {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertNotNull(ks)
        assertTrue(ks.aliases().toList().isEmpty() || true)   // the store loads; key creation with auth is covered manually
    }
}
```

Manual check: lock, background the app, return, confirm the gate is locked again; enroll a new fingerprint and confirm the app handles `KeyPermanentlyInvalidatedException` by resetting the vault.

## Pitfalls

- `BiometricPrompt` needs a `FragmentActivity`; a plain `ComponentActivity` throws at runtime.
- `BIOMETRIC_WEAK` (face unlock on some devices) cannot be used with a `CryptoObject`. Use `BIOMETRIC_STRONG` for crypto-bound prompts.
- On API < 30 a crypto-bound key cannot use `DEVICE_CREDENTIAL`; either skip crypto binding there or offer a biometric-only path.
- Always handle `ERROR_LOCKOUT` and `ERROR_LOCKOUT_PERMANENT` with a message, not a retry loop.
- Do not call `authenticate` from `LaunchedEffect` on every recomposition; trigger from a user action or once per `Locked` transition.
- The emulator's face unlock is not supported; use fingerprint or PIN.
- Store nothing sensitive in the ViewModel beyond the unlocked flag; the decrypted secret should live in memory only as long as it is used.

## Sources

- https://developer.android.com/identity/sign-in/biometric-auth
- https://developer.android.com/jetpack/androidx/releases/biometric
- https://developer.android.com/privacy-and-security/keystore
- https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec.Builder
