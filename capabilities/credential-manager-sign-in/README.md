# Credential Manager sign-in

Sign in with Google, passkeys and saved passwords through one Credential Manager 1.6.0 flow: a repository that wraps `CredentialManager`, a Google ID token request with `googleid`, passkey registration and authentication against your relying-party server, `ClearCredentialStateRequest` on sign-out, and the Digital Asset Links the passkey flow needs.

## When to use

- Any app with accounts. Credential Manager is the platform API that unifies passkeys, passwords and federated sign-in in one bottom sheet; the legacy Google Sign-In SDK and Smart Lock are deprecated.
- Passkeys need a server that implements WebAuthn registration and assertion endpoints. Sign in with Google needs an OAuth web client id from Google Cloud and a server that verifies the ID token.
- Pair with [firebase-auth](../firebase-auth/README.md) when Firebase is the backend; the Google ID token from this recipe is exchanged for a Firebase credential there.

## Dependencies

```toml
[versions]
credentials = "1.6.0"
googleid = "<version>"   # https://developers.google.com/identity/android-credential-manager/releases

[libraries]
androidx-credentials = { group = "androidx.credentials", name = "credentials", version.ref = "credentials" }
androidx-credentials-play-services = { group = "androidx.credentials", name = "credentials-play-services-auth", version.ref = "credentials" }
googleid = { group = "com.google.android.libraries.identity.googleid", name = "googleid", version.ref = "googleid" }
```

```kotlin
dependencies {
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)   // needed below API 34 and for Google
    implementation(libs.googleid)
}
```

## Manifest and permissions

No permissions. For passkeys, host Digital Asset Links at `https://example.com/.well-known/assetlinks.json` declaring `delegate_permission/common.get_login_creds` for your package and signing fingerprints (same file format as [deep-links](../deep-links/README.md), different `relation`). Without it `createCredential` fails with `CreatePublicKeyCredentialDomException` (origin not allowed).

Put the web client id in `BuildConfig` from `local.properties` or CI; it is not a secret but should not be hard-coded across environments.

## Implementation

### Repository

```kotlin
package com.example.app.auth

import android.content.Context
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPasswordOption
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.example.app.BuildConfig
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import javax.inject.Inject

sealed interface SignInResult {
    data class GoogleIdToken(val idToken: String) : SignInResult
    data class Passkey(val authenticationResponseJson: String) : SignInResult
    data class Password(val username: String, val password: String) : SignInResult
    data object Cancelled : SignInResult
    data object NoCredentials : SignInResult
    data class Failed(val cause: Throwable) : SignInResult
}

interface AuthApi {
    suspend fun passkeyRegistrationOptions(): String      // WebAuthn PublicKeyCredentialCreationOptions JSON
    suspend fun passkeyAuthenticationOptions(): String    // PublicKeyCredentialRequestOptions JSON
}

class CredentialSignInRepository @Inject constructor(
    private val authApi: AuthApi,
) {
    private fun manager(context: Context) = CredentialManager.create(context)

    /** Shows passkeys, saved passwords and Google accounts in one sheet. Pass an Activity context. */
    suspend fun signIn(activityContext: Context, preferImmediate: Boolean): SignInResult {
        val googleOption = GetGoogleIdOption.Builder()
            .setServerClientId(BuildConfig.GOOGLE_WEB_CLIENT_ID)
            .setFilterByAuthorizedAccounts(preferImmediate)     // true: returning users only, no account picker
            .setAutoSelectEnabled(preferImmediate)
            .setNonce(authApi.nonce())
            .build()
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(GetPublicKeyCredentialOption(authApi.passkeyAuthenticationOptions()))
            .addCredentialOption(GetPasswordOption())
            .addCredentialOption(googleOption)
            .build()
        return try {
            handle(manager(activityContext).getCredential(activityContext, request).credential)
        } catch (e: GetCredentialCancellationException) {
            SignInResult.Cancelled
        } catch (e: NoCredentialException) {
            SignInResult.NoCredentials
        } catch (e: GetCredentialException) {
            SignInResult.Failed(e)
        }
    }

    private fun handle(credential: androidx.credentials.Credential): SignInResult = when (credential) {
        is PublicKeyCredential -> SignInResult.Passkey(credential.authenticationResponseJson)
        is PasswordCredential -> SignInResult.Password(credential.id, credential.password)
        is CustomCredential -> if (credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            try {
                SignInResult.GoogleIdToken(GoogleIdTokenCredential.createFrom(credential.data).idToken)
            } catch (e: GoogleIdTokenParsingException) {
                SignInResult.Failed(e)
            }
        } else SignInResult.Failed(IllegalStateException("Unknown credential type ${credential.type}"))
        else -> SignInResult.Failed(IllegalStateException("Unknown credential"))
    }

    /** Create a passkey for the signed-in user. Returns the registration JSON for your server to verify and store. */
    suspend fun registerPasskey(activityContext: Context): Result<String> = try {
        val options = authApi.passkeyRegistrationOptions()
        val response = manager(activityContext).createCredential(
            activityContext,
            CreatePublicKeyCredentialRequest(requestJson = options),
        ) as CreatePublicKeyCredentialResponse
        Result.success(response.registrationResponseJson)
    } catch (e: CreateCredentialCancellationException) {
        Result.failure(e)
    } catch (e: CreateCredentialException) {
        Result.failure(e)
    }

    suspend fun signOut(context: Context) {
        manager(context).clearCredentialState(ClearCredentialStateRequest())
    }
}
```

`getCredential` must receive an Activity context so the system sheet can attach; the `ApplicationContext` throws. The nonce is generated per request and verified server-side to prevent replay. Send `idToken`, `authenticationResponseJson` or `registrationResponseJson` to your backend and never trust them on the client.

### ViewModel

```kotlin
sealed interface SignInUiState {
    data object Idle : SignInUiState
    data object InProgress : SignInUiState
    data class Error(val message: String) : SignInUiState
    data object SignedIn : SignInUiState
}

@HiltViewModel
class SignInViewModel @Inject constructor(
    private val credentials: CredentialSignInRepository,
    private val session: SessionRepository,     // exchanges tokens with your server, persists the session
) : ViewModel() {
    private val _state = MutableStateFlow<SignInUiState>(SignInUiState.Idle)
    val state: StateFlow<SignInUiState> = _state.asStateFlow()

    fun signIn(activityContext: Context, preferImmediate: Boolean) {
        viewModelScope.launch {
            _state.value = SignInUiState.InProgress
            _state.value = when (val r = credentials.signIn(activityContext, preferImmediate)) {
                is SignInResult.GoogleIdToken -> session.exchangeGoogle(r.idToken).toUi()
                is SignInResult.Passkey -> session.exchangePasskey(r.authenticationResponseJson).toUi()
                is SignInResult.Password -> session.exchangePassword(r.username, r.password).toUi()
                SignInResult.Cancelled -> SignInUiState.Idle
                SignInResult.NoCredentials -> if (preferImmediate) SignInUiState.Idle
                    else SignInUiState.Error("No accounts found on this device")
                is SignInResult.Failed -> SignInUiState.Error("Sign-in failed")
            }
        }
    }
}
```

Call `signIn(ctx, preferImmediate = true)` once when the sign-in screen opens (silent return for existing users) and `preferImmediate = false` from the button.

### Compose

```kotlin
@Composable
fun SignInScreen(viewModel: SignInViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val activity = LocalActivity.current ?: return

    LaunchedEffect(Unit) { viewModel.signIn(activity, preferImmediate = true) }

    when (state) {
        SignInUiState.InProgress -> CircularProgressIndicator()
        else -> Button(onClick = { viewModel.signIn(activity, preferImmediate = false) }) { Text("Continue") }
    }
    if (state is SignInUiState.Error) Text((state as SignInUiState.Error).message)
}
```

Add a "Sign in with Google" branded button per Google's branding guidelines if you surface Google separately; the unified sheet above is acceptable on its own.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*SignInViewModelTest*"
adb shell settings get secure credential_service          # should list a provider (Google Password Manager)
curl -sS https://example.com/.well-known/assetlinks.json  # relation get_login_creds present
```

ViewModel test with a fake repository:

```kotlin
@Test fun googleTokenIsExchangedForSession() = runTest {
    val fakeCredentials = FakeCredentialRepository(result = SignInResult.GoogleIdToken("id.token"))
    val fakeSession = FakeSessionRepository()
    val vm = SignInViewModel(fakeCredentials, fakeSession)
    vm.signIn(activityContext = mockk(), preferImmediate = false)
    advanceUntilIdle()
    assertEquals(SignInUiState.SignedIn, vm.state.value)
    assertEquals("id.token", fakeSession.lastGoogleToken)
}
```

Make `CredentialSignInRepository` an interface with the real class as one implementation so the fake compiles without `CredentialManager`. On a device: sign in with a Google account on the emulator (Play image), register a passkey, uninstall and reinstall, and confirm the passkey signs in without a password.

## Pitfalls

- Passing `applicationContext` to `getCredential` fails; use the Activity.
- `setFilterByAuthorizedAccounts(true)` returns `NoCredentialException` for new users; fall back to `false` on the explicit button instead of showing an error.
- Verify the Google ID token server-side (audience equals your web client id, issuer is accounts.google.com, nonce matches). Never grant a session from the client-side parse alone.
- Passkeys fail with a DOM error when the relying-party id in the server JSON does not match a verified domain in `assetlinks.json`.
- Emulators without Google Play services have no credential provider; test on a Play system image or a device.
- Sign-out must call `clearCredentialState` or the next `preferImmediate` call auto-selects the old account.
- Do not store the Google ID token; it is short-lived. Store your own session token, Keystore-wrapped.

## Sources

- https://developer.android.com/identity/sign-in/credential-manager
- https://developer.android.com/identity/sign-in/credential-manager-siwg
- https://developer.android.com/identity/passkeys
- https://developer.android.com/jetpack/androidx/releases/credentials
- https://developers.google.com/identity/android-credential-manager
