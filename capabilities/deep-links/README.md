# Deep links and App Links

Verified Android App Links (`https://` URLs that open the app without a chooser) plus a custom scheme fallback, routed through Navigation Compose 2.10.2 typed routes with `deepLink<T>`, a parser that treats URLs as untrusted input, the `assetlinks.json` file and the `adb` commands that prove verification.

## When to use

- Links from email, web, notifications or other apps should land on a specific screen.
- Android App Links are the default: they need a domain you control and an `assetlinks.json` file. A custom scheme (`exampleapp://`) is a fallback for environments that cannot host the file; it is not unique to your app and must not carry anything sensitive.
- For Navigation 3 projects the parsing layer below is the same; only the `NavHost` wiring differs.

## Dependencies

```toml
[versions]
navigation = "2.10.2"
kotlinx-serialization = "<version>"   # https://github.com/Kotlin/kotlinx.serialization/releases

[libraries]
navigation-compose = { group = "androidx.navigation", name = "navigation-compose", version.ref = "navigation" }
kotlinx-serialization-json = { group = "org.jetbrains.kotlinx", name = "kotlinx-serialization-json", version.ref = "kotlinx-serialization" }

[plugins]
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version = "2.4.20" }
```

```kotlin
plugins { alias(libs.plugins.kotlin.serialization) }
dependencies {
    implementation(libs.navigation.compose)
    implementation(libs.kotlinx.serialization.json)
}
```

## Manifest and permissions

```xml
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:launchMode="singleTask">

    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>

    <!-- Verified App Links -->
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="example.com" />
        <data android:pathPrefix="/notes" />
        <data android:pathPrefix="/chat" />
    </intent-filter>

    <!-- Custom scheme fallback -->
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="exampleapp" android:host="open" />
    </intent-filter>
</activity>
```

`singleTask` makes a link to a running app deliver `onNewIntent` instead of a second Activity. `exported="true"` is required for any Activity with an intent filter.

### assetlinks.json

Host at `https://example.com/.well-known/assetlinks.json`, served as `application/json` over HTTPS with no redirects:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.example.app",
    "sha256_cert_fingerprints": [
      "AA:BB:...:ZZ"
    ]
  }
}]
```

Include the fingerprint of every signing key: the upload key for local builds and the Play App Signing key (shown in Play Console > App integrity). Get a local fingerprint with `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android | grep SHA256`.

## Implementation

### Routes

```kotlin
package com.example.app.navigation

import kotlinx.serialization.Serializable

@Serializable data object HomeRoute
@Serializable data class NoteRoute(val id: String)
@Serializable data class ChatRoute(val conversationId: String, val messageId: String? = null)
```

### Parser (one place, untrusted input)

```kotlin
package com.example.app.navigation

import android.net.Uri

sealed interface DeepLink {
    data class Note(val id: String) : DeepLink
    data class Chat(val conversationId: String, val messageId: String?) : DeepLink
}

object DeepLinkParser {
    private val idPattern = Regex("^[A-Za-z0-9_-]{1,64}$")

    fun parse(uri: Uri?): DeepLink? {
        uri ?: return null
        val isAppLink = uri.scheme == "https" && uri.host == "example.com"
        val isScheme = uri.scheme == "exampleapp" && uri.host == "open"
        if (!isAppLink && !isScheme) return null

        val segments = uri.pathSegments
        return when (segments.firstOrNull()) {
            "notes" -> segments.getOrNull(1)?.takeIf(idPattern::matches)?.let(DeepLink::Note)
            "chat" -> segments.getOrNull(1)?.takeIf(idPattern::matches)?.let { conversation ->
                DeepLink.Chat(conversation, uri.getQueryParameter("message")?.takeIf(idPattern::matches))
            }
            else -> null       // unknown paths are ignored, never crashed on
        }
    }
}
```

The parser is a pure function so it has a JVM unit test. Validate ids before they reach a database query or a network call.

### NavHost with deep links

```kotlin
package com.example.app.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navDeepLink
import androidx.navigation.toRoute

@Composable
fun AppNavHost() {
    val navController = rememberNavController()
    NavHost(navController, startDestination = HomeRoute) {
        composable<HomeRoute> { HomeScreen(onOpenNote = { navController.navigate(NoteRoute(it)) }) }

        composable<NoteRoute>(
            deepLinks = listOf(
                navDeepLink<NoteRoute>(basePath = "https://example.com/notes"),
                navDeepLink<NoteRoute>(basePath = "exampleapp://open/notes"),
            ),
        ) { entry ->
            val route = entry.toRoute<NoteRoute>()
            NoteScreen(noteId = route.id)
        }

        composable<ChatRoute>(
            deepLinks = listOf(navDeepLink<ChatRoute>(basePath = "https://example.com/chat")),
        ) { entry ->
            val route = entry.toRoute<ChatRoute>()
            ChatScreen(route.conversationId, route.messageId)
        }
    }
}
```

`navDeepLink<T>(basePath)` generates the pattern from the route class: required fields become path segments (`/notes/{id}`), optional fields become query parameters (`?messageId=...`). Navigation Compose handles the launch intent automatically through `NavHost`; for `onNewIntent` on a `singleTask` Activity forward it:

```kotlin
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    private var navController: NavHostController? = null

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        navController?.handleDeepLink(intent)
    }
}
```

Expose the controller from `AppNavHost` through a callback or hoist `rememberNavController()` into the Activity's `setContent` block.

When you need the parsed `DeepLink` for analytics or to gate on auth, run `DeepLinkParser.parse(intent.data)` in the Activity and decide whether to let `handleDeepLink` proceed or to stash the link in a ViewModel until sign-in completes.

### Testing the parser

```kotlin
class DeepLinkParserTest {
    @Test fun parsesNoteAppLink() {
        assertEquals(DeepLink.Note("abc_1"), DeepLinkParser.parse(Uri.parse("https://example.com/notes/abc_1")))
    }
    @Test fun rejectsForeignHost() {
        assertNull(DeepLinkParser.parse(Uri.parse("https://evil.example.net/notes/abc")))
    }
    @Test fun rejectsInvalidId() {
        assertNull(DeepLinkParser.parse(Uri.parse("https://example.com/notes/../../etc")))
    }
}
```

`Uri` is an Android class; run this with Robolectric (`testOptions.unitTests.isIncludeAndroidResources = true` and `@RunWith(RobolectricTestRunner::class)`) or move parsing to `java.net.URI` for a plain JVM test.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*DeepLinkParserTest*"

# Open a link in the running app
adb shell am start -a android.intent.action.VIEW -d "https://example.com/notes/abc_1" com.example.app
adb shell am start -a android.intent.action.VIEW -d "exampleapp://open/notes/abc_1"

# App Link verification state (API 31+). Expect "verified" for example.com.
adb shell pm get-app-links com.example.app
# Force re-verification after fixing assetlinks.json
adb shell pm verify-app-links --re-verify com.example.app

# Check the hosted file
curl -sS https://example.com/.well-known/assetlinks.json | python3 -m json.tool
```

Android Studio's App Links Assistant (Tools > App Links Assistant) runs the same checks and can generate the JSON.

## Pitfalls

- `autoVerify` needs every `<data android:host>` in that filter to pass verification; one unverified host marks the whole filter as unverified and the system shows a chooser or opens the browser.
- Mixing the `https` and custom-scheme `<data>` elements in one filter creates cross-product matches (`exampleapp://example.com`). Keep them in separate filters.
- `assetlinks.json` behind a redirect, with the wrong content type, or missing the Play App Signing fingerprint fails verification only on real installs, not in debug.
- A route with a required field but a link missing that segment does not match; the app opens on the start destination. Make truly optional data nullable with a default.
- Navigating from raw strings in composables bypasses validation. All links go through `DeepLinkParser`.
- Custom-scheme links can be claimed by any app. Never pass tokens or auth codes through them; use App Links or the Credential Manager flows.
- `launchMode="singleTask"` without handling `onNewIntent` means a link while the app is open does nothing.

## Sources

- https://developer.android.com/training/app-links
- https://developer.android.com/training/app-links/verify-android-applinks
- https://developer.android.com/guide/navigation/design/deep-link
- https://developer.android.com/guide/navigation/design/type-safety
- https://developer.android.com/jetpack/androidx/releases/navigation
