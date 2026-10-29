# Ktor client

HTTP client with Ktor and kotlinx.serialization as the alternative to Retrofit: OkHttp engine on Android, `ContentNegotiation`, bearer auth with refresh, logging, typed error mapping and a `MockEngine` test.

## When to use

- The project is Kotlin Multiplatform, or the team already uses Ktor on the server and wants one HTTP vocabulary.
- You want a client API built on suspend functions and plugins rather than annotated interfaces.
- Use [retrofit-networking](../retrofit-networking/README.md) when the project already has Retrofit or the team prefers declarative endpoints. Do not mix both in one module.

## Dependencies

Ktor and kotlinx.serialization versions are not in `data/versions.json`; resolve from the release pages. All Ktor artifacts share one version.

`gradle/libs.versions.toml`:

```toml
[versions]
ktor = "<version>"                     # https://ktor.io/docs/releases.html
kotlinx-serialization = "<version>"    # https://github.com/Kotlin/kotlinx.serialization/releases

[libraries]
ktor-client-core = { group = "io.ktor", name = "ktor-client-core", version.ref = "ktor" }
ktor-client-okhttp = { group = "io.ktor", name = "ktor-client-okhttp", version.ref = "ktor" }
ktor-client-content-negotiation = { group = "io.ktor", name = "ktor-client-content-negotiation", version.ref = "ktor" }
ktor-client-auth = { group = "io.ktor", name = "ktor-client-auth", version.ref = "ktor" }
ktor-client-logging = { group = "io.ktor", name = "ktor-client-logging", version.ref = "ktor" }
ktor-client-mock = { group = "io.ktor", name = "ktor-client-mock", version.ref = "ktor" }
ktor-serialization-kotlinx-json = { group = "io.ktor", name = "ktor-serialization-kotlinx-json", version.ref = "ktor" }

[plugins]
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version = "2.4.20" }
```

`app/build.gradle.kts`:

```kotlin
plugins { alias(libs.plugins.kotlin.serialization) }

dependencies {
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.content.negotiation)
    implementation(libs.ktor.client.auth)
    implementation(libs.ktor.client.logging)
    implementation(libs.ktor.serialization.kotlinx.json)
    testImplementation(libs.ktor.client.mock)
}
```

## Manifest and permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

## Implementation

### Client factory

```kotlin
package com.example.app.data.remote

import com.example.app.BuildConfig
import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.auth.Auth
import io.ktor.client.plugins.auth.providers.BearerTokens
import io.ktor.client.plugins.auth.providers.bearer
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

interface TokenStore {
    suspend fun tokens(): BearerTokens?
    suspend fun refresh(): BearerTokens?     // calls the refresh endpoint and persists the result
}

fun buildHttpClient(engine: HttpClientEngine, tokenStore: TokenStore, json: Json): HttpClient =
    HttpClient(engine) {
        expectSuccess = true                 // non-2xx throws ClientRequestException / ServerResponseException
        defaultRequest {
            url(BuildConfig.API_BASE_URL)    // trailing slash required
            contentType(ContentType.Application.Json)
        }
        install(ContentNegotiation) { json(json) }
        install(HttpTimeout) {
            connectTimeoutMillis = 15_000
            requestTimeoutMillis = 30_000
        }
        install(Auth) {
            bearer {
                loadTokens { tokenStore.tokens() }
                refreshTokens { tokenStore.refresh() }   // invoked once on 401, then the request is retried
                sendWithoutRequest { request -> request.url.host == BuildConfig.API_HOST }
            }
        }
        if (BuildConfig.DEBUG) {
            install(Logging) { level = LogLevel.HEADERS }   // never BODY in release
        }
    }
```

The `bearer` provider stores the loaded tokens in memory; call `client.authProvider<BearerAuthProvider>()?.clearToken()` on sign-out so the next request reloads from `TokenStore`.

### API wrapper

```kotlin
package com.example.app.data.remote

import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import javax.inject.Inject

@Serializable
data class ArticleDto(
    val id: String,
    val title: String,
    @SerialName("published_at") val publishedAt: String,
    val body: String? = null,
)

@Serializable
data class CreateArticleRequest(val title: String, val body: String)

class ArticleApi @Inject constructor(private val client: HttpClient) {
    suspend fun list(page: Int, size: Int = 20): List<ArticleDto> =
        client.get("articles") { parameter("page", page); parameter("size", size) }.body()

    suspend fun get(id: String): ArticleDto = client.get("articles/$id").body()

    suspend fun create(request: CreateArticleRequest): ArticleDto =
        client.post("articles") { setBody(request) }.body()
}
```

### Error mapping

```kotlin
package com.example.app.data.remote

import io.ktor.client.plugins.ClientRequestException
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.ServerResponseException
import io.ktor.serialization.JsonConvertException
import kotlinx.coroutines.CancellationException
import java.io.IOException

sealed interface NetworkResult<out T> {
    data class Success<T>(val data: T) : NetworkResult<T>
    data class HttpError(val code: Int, val message: String?) : NetworkResult<Nothing>
    data object Offline : NetworkResult<Nothing>
    data class Unexpected(val cause: Throwable) : NetworkResult<Nothing>
}

suspend inline fun <T> safeCall(crossinline block: suspend () -> T): NetworkResult<T> = try {
    NetworkResult.Success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: ClientRequestException) {           // 4xx
    NetworkResult.HttpError(e.response.status.value, e.message)
} catch (e: ServerResponseException) {          // 5xx
    NetworkResult.HttpError(e.response.status.value, e.message)
} catch (e: HttpRequestTimeoutException) {
    NetworkResult.Offline
} catch (e: IOException) {
    NetworkResult.Offline
} catch (e: JsonConvertException) {
    NetworkResult.Unexpected(e)
}
```

### Hilt module

```kotlin
@Module
@InstallIn(SingletonComponent::class)
object KtorModule {
    @Provides @Singleton
    fun provideJson(): Json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true }

    @Provides @Singleton
    fun provideEngine(): HttpClientEngine = OkHttp.create {
        config { retryOnConnectionFailure(true) }
    }

    @Provides @Singleton
    fun provideHttpClient(engine: HttpClientEngine, tokenStore: TokenStore, json: Json): HttpClient =
        buildHttpClient(engine, tokenStore, json)
}
```

With Koin the same factory becomes `single { buildHttpClient(OkHttp.create(), get(), get()) }`. The `HttpClient` must be a singleton; it owns an engine and a coroutine scope. Call `client.close()` only when the whole process is done with networking, which in an app means never.

### Repository and ViewModel

Identical to the Retrofit recipe: the repository wraps `safeCall { api.list(page).map { it.toDomain() } }` under an injected `CoroutineDispatcher`, and the ViewModel maps `NetworkResult` to `Loading`, `Content`, `Empty` or `Error` states. See [retrofit-networking](../retrofit-networking/README.md#repository-and-viewmodel).

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*ArticleApiTest*"
```

`MockEngine` test (JVM, no device):

```kotlin
class ArticleApiTest {
    private fun client(handler: MockRequestHandler): HttpClient {
        val store = object : TokenStore {
            override suspend fun tokens() = BearerTokens("t0k3n", "r")
            override suspend fun refresh() = null
        }
        return buildHttpClient(MockEngine(handler), store, Json { ignoreUnknownKeys = true })
    }

    @Test fun listSendsBearerAndParses() = runTest {
        val api = ArticleApi(client { request ->
            assertEquals("Bearer t0k3n", request.headers[HttpHeaders.Authorization])
            respond(
                content = """[{"id":"1","title":"Hi","published_at":"2026-01-01","extra":true}]""",
                headers = headersOf(HttpHeaders.ContentType, "application/json"),
            )
        })
        assertEquals("Hi", api.list(1).single().title)
    }

    @Test fun fiveHundredMapsToHttpError() = runTest {
        val api = ArticleApi(client { respondError(HttpStatusCode.ServiceUnavailable) })
        val r = safeCall { api.list(1) }
        assertTrue(r is NetworkResult.HttpError && r.code == 503)
    }
}
```

`sendWithoutRequest` must return true for the mock host in tests, or simply omit it in the test client; otherwise the first request goes out without the header and the test fails on the assertion rather than on logic.

## Pitfalls

- Without `expectSuccess = true`, `body()` on a 404 tries to deserialize the error page and fails with a confusing `JsonConvertException`.
- `Logging` at `LogLevel.ALL` prints request bodies including credentials. Keep `HEADERS` and only in debug.
- `refreshTokens` runs for every 401, including the refresh endpoint itself if it returns 401. Mark the refresh call with `markAsRefreshTokenRequest()` or exclude it in `sendWithoutRequest`.
- A `defaultRequest` URL without a trailing slash drops the last path segment when relative paths are appended.
- `HttpClient` is not a value type; creating one per request leaks engine threads.
- Ktor coroutines respect cancellation; still rethrow `CancellationException` in any catch block you write.

## Sources

- https://ktor.io/docs/client-create-and-configure.html
- https://ktor.io/docs/client-bearer-auth.html
- https://ktor.io/docs/client-serialization.html
- https://ktor.io/docs/client-testing.html
- https://github.com/Kotlin/kotlinx.serialization
