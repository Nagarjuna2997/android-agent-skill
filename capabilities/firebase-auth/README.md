# Firebase Authentication

Firebase Auth through the Firebase BoM 34.18.0: an `AuthRepository` interface exposing the current user as a `Flow`, email/password and Google (via Credential Manager) sign-in, token retrieval for your own APIs, sign-out, and tests against the Auth emulator.

## When to use

- The backend is Firebase (Firestore, Functions, Storage) and you want identity handled there with security rules keyed on `request.auth.uid`.
- You do not want to run your own session server. For a custom backend, [credential-manager-sign-in](../credential-manager-sign-in/README.md) with your own token exchange is lighter.

## Dependencies

Google Services plugin version is not in `data/versions.json`; resolve it from the Firebase Android setup page.

```toml
[versions]
firebase-bom = "34.18.0"
google-services = "<version>"   # https://firebase.google.com/docs/android/setup
credentials = "1.6.0"
googleid = "<version>"          # https://developers.google.com/identity/android-credential-manager/releases

[libraries]
firebase-bom = { group = "com.google.firebase", name = "firebase-bom", version.ref = "firebase-bom" }
firebase-auth = { group = "com.google.firebase", name = "firebase-auth" }
androidx-credentials = { group = "androidx.credentials", name = "credentials", version.ref = "credentials" }
androidx-credentials-play-services = { group = "androidx.credentials", name = "credentials-play-services-auth", version.ref = "credentials" }
googleid = { group = "com.google.android.libraries.identity.googleid", name = "googleid", version.ref = "googleid" }
kotlinx-coroutines-play-services = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-play-services", version = "<version>" }  # https://github.com/Kotlin/kotlinx.coroutines/releases

[plugins]
google-services = { id = "com.google.gms.google-services", version.ref = "google-services" }
```

Root `build.gradle.kts`: `alias(libs.plugins.google.services) apply false`.

`app/build.gradle.kts`:

```kotlin
plugins { alias(libs.plugins.google.services) }

dependencies {
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.auth)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)
    implementation(libs.googleid)
    implementation(libs.kotlinx.coroutines.play.services)   // Task.await()
}
```

Firebase KTX artifacts (`-ktx`) were folded into the main artifacts; use `com.google.firebase:firebase-auth` and the `Firebase.auth` accessor from `com.google.firebase.auth.auth`.

## Manifest and permissions

`INTERNET` only. Place `google-services.json` in `app/` (per build type folders for separate projects: `app/src/debug/google-services.json`). Add it to `.gitignore` only if it contains restricted keys; by default it holds client ids that are safe to commit, but keep the project decision explicit.

Enable the providers in Firebase console > Authentication > Sign-in method. For Google, the web client id appears there; put it in `BuildConfig.GOOGLE_WEB_CLIENT_ID`. Add the SHA-1 and SHA-256 of your debug and Play signing keys to the Firebase project.

## Implementation

### Repository

```kotlin
package com.example.app.auth

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import com.example.app.BuildConfig
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseAuthException
import com.google.firebase.auth.FirebaseAuthInvalidCredentialsException
import com.google.firebase.auth.FirebaseAuthUserCollisionException
import com.google.firebase.auth.GoogleAuthProvider
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

data class AuthUser(val uid: String, val email: String?, val displayName: String?)

sealed interface AuthError {
    data object InvalidCredentials : AuthError
    data object EmailInUse : AuthError
    data object Cancelled : AuthError
    data object Network : AuthError
    data class Other(val code: String?) : AuthError
}

interface AuthRepository {
    val currentUser: Flow<AuthUser?>
    suspend fun signInWithEmail(email: String, password: String): Result<AuthUser>
    suspend fun createAccount(email: String, password: String): Result<AuthUser>
    suspend fun signInWithGoogle(activityContext: Context): Result<AuthUser>
    suspend fun idToken(forceRefresh: Boolean = false): String?
    suspend fun signOut(context: Context)
}

class FirebaseAuthRepository @Inject constructor(
    private val auth: FirebaseAuth,
) : AuthRepository {

    override val currentUser: Flow<AuthUser?> = callbackFlow {
        val listener = FirebaseAuth.AuthStateListener { trySend(it.currentUser?.toModel()) }
        auth.addAuthStateListener(listener)
        awaitClose { auth.removeAuthStateListener(listener) }
    }

    override suspend fun signInWithEmail(email: String, password: String): Result<AuthUser> =
        authCall { auth.signInWithEmailAndPassword(email, password).await().user!!.toModel() }

    override suspend fun createAccount(email: String, password: String): Result<AuthUser> =
        authCall { auth.createUserWithEmailAndPassword(email, password).await().user!!.toModel() }

    override suspend fun signInWithGoogle(activityContext: Context): Result<AuthUser> = authCall {
        val option = GetGoogleIdOption.Builder()
            .setServerClientId(BuildConfig.GOOGLE_WEB_CLIENT_ID)
            .setFilterByAuthorizedAccounts(false)
            .build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        val credential = CredentialManager.create(activityContext).getCredential(activityContext, request).credential
        require(credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL)
        val idToken = GoogleIdTokenCredential.createFrom(credential.data).idToken
        auth.signInWithCredential(GoogleAuthProvider.getCredential(idToken, null)).await().user!!.toModel()
    }

    override suspend fun idToken(forceRefresh: Boolean): String? =
        auth.currentUser?.getIdToken(forceRefresh)?.await()?.token

    override suspend fun signOut(context: Context) {
        auth.signOut()
        CredentialManager.create(context).clearCredentialState(androidx.credentials.ClearCredentialStateRequest())
    }

    private inline fun <T> authCall(block: () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: GetCredentialCancellationException) {
        Result.failure(AuthException(AuthError.Cancelled))
    } catch (e: GetCredentialException) {
        Result.failure(AuthException(AuthError.Other(e.type)))
    } catch (e: FirebaseAuthInvalidCredentialsException) {
        Result.failure(AuthException(AuthError.InvalidCredentials))
    } catch (e: FirebaseAuthUserCollisionException) {
        Result.failure(AuthException(AuthError.EmailInUse))
    } catch (e: FirebaseAuthException) {
        Result.failure(AuthException(AuthError.Other(e.errorCode)))
    } catch (e: com.google.firebase.FirebaseNetworkException) {
        Result.failure(AuthException(AuthError.Network))
    }
}

class AuthException(val error: AuthError) : Exception(error.toString())

private fun com.google.firebase.auth.FirebaseUser.toModel() = AuthUser(uid, email, displayName)
```

### Hilt module

```kotlin
@Module
@InstallIn(SingletonComponent::class)
object FirebaseModule {
    @Provides @Singleton fun auth(): FirebaseAuth = Firebase.auth
}

@Module
@InstallIn(SingletonComponent::class)
abstract class AuthBindings {
    @Binds abstract fun auth(impl: FirebaseAuthRepository): AuthRepository
}
```

### ViewModel

```kotlin
sealed interface SessionUiState {
    data object Loading : SessionUiState
    data object SignedOut : SessionUiState
    data class SignedIn(val user: AuthUser) : SessionUiState
}

@HiltViewModel
class SessionViewModel @Inject constructor(private val auth: AuthRepository) : ViewModel() {
    val session: StateFlow<SessionUiState> = auth.currentUser
        .map { if (it == null) SessionUiState.SignedOut else SessionUiState.SignedIn(it) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SessionUiState.Loading)

    private val _error = MutableStateFlow<AuthError?>(null)
    val error: StateFlow<AuthError?> = _error.asStateFlow()

    fun signInWithEmail(email: String, password: String) = viewModelScope.launch {
        auth.signInWithEmail(email, password).onFailure { _error.value = (it as? AuthException)?.error ?: AuthError.Other(null) }
    }

    fun signInWithGoogle(activityContext: Context) = viewModelScope.launch {
        auth.signInWithGoogle(activityContext).onFailure {
            val err = (it as? AuthException)?.error
            if (err != AuthError.Cancelled) _error.value = err ?: AuthError.Other(null)
        }
    }

    fun dismissError() { _error.value = null }
}
```

The root composable switches between the sign-in graph and the app graph on `session`; it never reads `FirebaseAuth` directly. Pass `idToken()` as a bearer header when calling your own server, and verify it there with the Firebase Admin SDK.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*SessionViewModelTest*"

# Local Auth emulator for instrumented tests
npm install -g firebase-tools && firebase emulators:start --only auth
adb reverse tcp:9099 tcp:9099
```

Point the SDK at the emulator in the debug build only: `Firebase.auth.useEmulator("10.0.2.2", 9099)` (or `127.0.0.1` with `adb reverse`), guarded by `BuildConfig.DEBUG` and a flag. Instrumented test:

```kotlin
@Test fun emailSignUpThenSignIn() = runTest {
    val repo = FirebaseAuthRepository(Firebase.auth.apply { useEmulator("10.0.2.2", 9099) })
    val email = "u${System.currentTimeMillis()}@example.com"
    assertTrue(repo.createAccount(email, "password123").isSuccess)
    repo.signOut(ApplicationProvider.getApplicationContext())
    assertTrue(repo.signInWithEmail(email, "password123").isSuccess)
    repo.currentUser.test { assertEquals(email, awaitItem()?.email); cancelAndIgnoreRemainingEvents() }
}
```

ViewModel unit tests use a `FakeAuthRepository` with a `MutableStateFlow<AuthUser?>`.

## Pitfalls

- Missing SHA fingerprints in the Firebase project make Google sign-in fail with `DEVELOPER_ERROR` or `ApiException 10`; add both debug and release/Play fingerprints.
- `google-services.json` from one Firebase project with a different `applicationId` in `build.gradle.kts` fails at build time; match package names per flavor.
- `AuthStateListener` fires on the main thread; the `callbackFlow` above keeps consumers off it only if you collect downstream with `flowOn` or in a ViewModel.
- The Google ID token is exchanged for a Firebase credential; do not also send it to your server. Send the Firebase ID token from `idToken()` instead.
- Firebase ID tokens expire after one hour; the SDK refreshes them, but a server 401 should trigger `idToken(forceRefresh = true)` once.
- Email enumeration protection is on by default in new projects; `signInWithEmail` returns `InvalidCredentials` for unknown emails and wrong passwords alike. Do not try to distinguish them in UI.
- Do not use the deprecated `GoogleSignInClient`; the Credential Manager path above is the supported one.

## Sources

- https://firebase.google.com/docs/auth/android/start
- https://firebase.google.com/docs/auth/android/google-signin
- https://firebase.google.com/docs/auth/android/password-auth
- https://firebase.google.com/docs/emulator-suite/connect_auth
- https://firebase.google.com/support/release-notes/android
