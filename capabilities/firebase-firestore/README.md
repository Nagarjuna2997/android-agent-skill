# Firebase Firestore

Cloud Firestore through the Firebase BoM 34.18.0: offline persistence configured once, a repository that wraps `addSnapshotListener` in a `callbackFlow`, typed documents with `toObject`, writes with server timestamps, pagination with `startAfter`, a security-rules reminder and tests against the Firestore emulator.

## When to use

- Document data shared across users or devices with realtime updates and built-in offline cache: chats, shared lists, user profiles.
- Pair with [firebase-auth](../firebase-auth/README.md); every rule below assumes `request.auth.uid`.
- For local-only data use [room-database](../room-database/README.md). For large result sets with complex joins Firestore's query model is limiting; design collections around screens.

## Dependencies

```toml
[versions]
firebase-bom = "34.18.0"
google-services = "<version>"   # https://firebase.google.com/docs/android/setup

[libraries]
firebase-bom = { group = "com.google.firebase", name = "firebase-bom", version.ref = "firebase-bom" }
firebase-firestore = { group = "com.google.firebase", name = "firebase-firestore" }
kotlinx-coroutines-play-services = { group = "org.jetbrains.kotlinx", name = "kotlinx-coroutines-play-services", version = "<version>" }

[plugins]
google-services = { id = "com.google.gms.google-services", version.ref = "google-services" }
```

```kotlin
plugins { alias(libs.plugins.google.services) }
dependencies {
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.firestore)
    implementation(libs.kotlinx.coroutines.play.services)
}
```

## Manifest and permissions

`INTERNET`. `google-services.json` in `app/`. No other permissions.

### Security rules reminder

The default test-mode rules expire and the default locked rules deny everything. Ship rules that scope every read and write to the signed-in user and validate shapes. Deploy with `firebase deploy --only firestore:rules` and keep `firestore.rules` in the repository:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/notes/{noteId} {
      allow read, write: if request.auth != null && request.auth.uid == uid
        && (request.method == 'delete' || (
          request.resource.data.title is string && request.resource.data.title.size() <= 200
        ));
    }
  }
}
```

Client code cannot be trusted; the rules are the real authorization layer.

## Implementation

### Firestore setup

```kotlin
package com.example.app.di

import com.google.firebase.Firebase
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.firestore
import com.google.firebase.firestore.FirebaseFirestoreSettings
import com.google.firebase.firestore.PersistentCacheSettings
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object FirestoreModule {
    @Provides @Singleton
    fun firestore(): FirebaseFirestore = Firebase.firestore.apply {
        firestoreSettings = FirebaseFirestoreSettings.Builder()
            .setLocalCacheSettings(
                PersistentCacheSettings.newBuilder()
                    .setSizeBytes(100L * 1024 * 1024)   // 100 MB; default is 100 MB, minimum 1 MB
                    .build()
            )
            .build()
    }
}
```

Settings must be set before the first Firestore call; providing the instance as a singleton guarantees it. Persistent cache is on by default on Android; setting it explicitly documents the size and lets you switch to `MemoryCacheSettings` for tests.

### Documents

```kotlin
package com.example.app.data.notes

import com.google.firebase.firestore.DocumentId
import com.google.firebase.firestore.ServerTimestamp
import java.util.Date

data class NoteDocument(
    @DocumentId val id: String = "",
    val title: String = "",
    val body: String = "",
    val archived: Boolean = false,
    @ServerTimestamp val updatedAt: Date? = null,
)
```

Firestore's mapper needs a no-arg constructor, so every field has a default. `@ServerTimestamp` fills the field on the server when you write `null`; the local cache shows `null` until the write is acknowledged, so treat it as "pending".

### Repository

```kotlin
package com.example.app.data.notes

import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.Source
import com.google.firebase.firestore.toObjects
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await
import javax.inject.Inject

data class Note(val id: String, val title: String, val body: String, val pendingWrite: Boolean)

sealed interface NotesSnapshot {
    data class Data(val notes: List<Note>, val fromCache: Boolean) : NotesSnapshot
    data class Error(val cause: Throwable) : NotesSnapshot
}

interface NoteRepository {
    fun observeNotes(uid: String): Flow<NotesSnapshot>
    suspend fun upsert(uid: String, id: String?, title: String, body: String): Result<String>
    suspend fun archive(uid: String, id: String): Result<Unit>
    suspend fun page(uid: String, after: DocumentSnapshot?, size: Int): Result<Pair<List<Note>, DocumentSnapshot?>>
}

class FirestoreNoteRepository @Inject constructor(private val db: FirebaseFirestore) : NoteRepository {

    private fun notes(uid: String) = db.collection("users").document(uid).collection("notes")

    override fun observeNotes(uid: String): Flow<NotesSnapshot> = callbackFlow {
        val registration = notes(uid)
            .whereEqualTo("archived", false)
            .orderBy("updatedAt", Query.Direction.DESCENDING)
            .addSnapshotListener { snapshot, error ->
                if (error != null) { trySend(NotesSnapshot.Error(error)); return@addSnapshotListener }
                if (snapshot == null) return@addSnapshotListener
                val items = snapshot.documents.map { doc ->
                    val d = doc.toObject(NoteDocument::class.java) ?: return@map null
                    Note(d.id, d.title, d.body, pendingWrite = doc.metadata.hasPendingWrites())
                }.filterNotNull()
                trySend(NotesSnapshot.Data(items, fromCache = snapshot.metadata.isFromCache))
            }
        awaitClose { registration.remove() }
    }

    override suspend fun upsert(uid: String, id: String?, title: String, body: String): Result<String> = call {
        val ref = if (id == null) notes(uid).document() else notes(uid).document(id)
        ref.set(
            mapOf("title" to title, "body" to body, "archived" to false, "updatedAt" to FieldValue.serverTimestamp()),
            com.google.firebase.firestore.SetOptions.merge(),
        ).await()
        ref.id
    }

    override suspend fun archive(uid: String, id: String): Result<Unit> = call {
        notes(uid).document(id).update("archived", true, "updatedAt", FieldValue.serverTimestamp()).await()
    }

    override suspend fun page(uid: String, after: DocumentSnapshot?, size: Int) = call {
        var q = notes(uid).orderBy("updatedAt", Query.Direction.DESCENDING).limit(size.toLong())
        if (after != null) q = q.startAfter(after)
        val snap = q.get(Source.DEFAULT).await()
        val items = snap.toObjects<NoteDocument>().map { Note(it.id, it.title, it.body, pendingWrite = false) }
        items to snap.documents.lastOrNull()
    }

    private inline fun <T> call(block: () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: FirebaseFirestoreException) {
        Result.failure(e)      // e.code: PERMISSION_DENIED, UNAVAILABLE, ...
    }
}
```

A write while offline resolves `await()` only when the server acknowledges; the snapshot listener shows the local change immediately with `hasPendingWrites() == true`. Do not block the UI on `await()` for offline-first screens; fire the write and rely on the listener.

### ViewModel

```kotlin
sealed interface NotesUiState {
    data object Loading : NotesUiState
    data object Empty : NotesUiState
    data class Content(val notes: List<Note>, val offline: Boolean) : NotesUiState
    data class Error(val message: String) : NotesUiState
}

@HiltViewModel
class NotesViewModel @Inject constructor(
    private val repo: NoteRepository,
    auth: AuthRepository,
) : ViewModel() {
    val uiState: StateFlow<NotesUiState> = auth.currentUser
        .filterNotNull()
        .flatMapLatest { user -> repo.observeNotes(user.uid) }
        .map { snap ->
            when (snap) {
                is NotesSnapshot.Error -> NotesUiState.Error(
                    if ((snap.cause as? FirebaseFirestoreException)?.code == FirebaseFirestoreException.Code.PERMISSION_DENIED)
                        "You do not have access" else "Could not load notes"
                )
                is NotesSnapshot.Data -> if (snap.notes.isEmpty()) NotesUiState.Empty
                    else NotesUiState.Content(snap.notes, offline = snap.fromCache)
            }
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), NotesUiState.Loading)
}
```

Show an "offline, showing cached data" banner when `offline` is true, and a subtle pending indicator per note with `pendingWrite`.

## Verify

```sh
./gradlew :app:assembleDebug
firebase emulators:start --only firestore,auth
adb reverse tcp:8080 tcp:8080
./gradlew :app:connectedDebugAndroidTest --tests "*FirestoreNoteRepositoryTest*"
firebase emulators:exec --only firestore "npm test"    # rules unit tests with @firebase/rules-unit-testing
```

Instrumented test against the emulator:

```kotlin
@RunWith(AndroidJUnit4::class)
class FirestoreNoteRepositoryTest {
    private val db = Firebase.firestore.apply {
        useEmulator("10.0.2.2", 8080)
        firestoreSettings = FirebaseFirestoreSettings.Builder().setLocalCacheSettings(MemoryCacheSettings.newBuilder().build()).build()
    }
    private val repo = FirestoreNoteRepository(db)

    @Test fun writtenNoteAppearsInStream() = runTest {
        repo.upsert("u1", null, "Hello", "body").getOrThrow()
        repo.observeNotes("u1").test {
            val data = awaitItem() as NotesSnapshot.Data
            assertEquals("Hello", data.notes.single().title)
            cancelAndIgnoreRemainingEvents()
        }
    }
}
```

Run the emulator with permissive rules for repository tests and separately test the real rules with the rules test library; both belong in CI.

## Pitfalls

- A composite query (`whereEqualTo` + `orderBy` on different fields) needs an index; the first run logs a console link to create it. Commit `firestore.indexes.json`.
- Listeners are not removed when a `callbackFlow` is collected without a lifecycle-aware scope; keep collection in `viewModelScope` or `collectAsStateWithLifecycle()`.
- `toObject` silently drops fields with no matching property and fails on type mismatches; keep documents versioned and defaults set.
- Server timestamps are `null` in the local snapshot; sorting by `updatedAt` places pending writes last until acknowledged. Fall back to a client timestamp for display.
- Reads are billed per document; a snapshot listener on 1,000 documents is 1,000 reads on first attach. Paginate and scope queries.
- Changing settings after first use throws `IllegalStateException`. Configure in the DI provider.
- Never put admin logic (counters, moderation) in the client; use Cloud Functions with the Admin SDK.

## Sources

- https://firebase.google.com/docs/firestore/quickstart
- https://firebase.google.com/docs/firestore/manage-data/enable-offline
- https://firebase.google.com/docs/firestore/query-data/listen
- https://firebase.google.com/docs/firestore/security/get-started
- https://firebase.google.com/docs/emulator-suite/connect_firestore
