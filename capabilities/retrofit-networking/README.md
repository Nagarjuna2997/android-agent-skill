# Retrofit networking

REST client with Retrofit, OkHttp and kotlinx.serialization: a typed API interface, an auth-header interceptor backed by a token provider, logging in debug builds, HTTP and parse errors mapped to a sealed result, and a MockWebServer test.

## When to use

- The app talks to a JSON REST API and you want declarative endpoints with suspend functions.
- You need interceptors (auth, retries, logging) and connection pooling that OkHttp provides.
- Pick [ktor-client](../ktor-client/README.md) instead when the project is Kotlin Multiplatform or already uses Ktor. Both recipes expose the same repository shape, so the UI layer does not care.

## Dependencies

Retrofit, OkHttp and kotlinx.serialization versions are not in `data/versions.json`; resolve them from the official release pages and pin them in the catalog.

`gradle/libs.versions.toml`:

```toml
[versions]
retrofit = "<version>"          # https://github.com/square/retrofit/releases
okhttp = "<version>"            # https://square.github.io/okhttp/changelogs/changelog/
kotlinx-serialization = "<version>"   # https://github.com/Kotlin/kotlinx.serialization/releases

[libraries]
retrofit = { group = "com.squareup.retrofit2", name = "retrofit", version.ref = "retrofit" }
retrofit-kotlinx-serialization = { group = "com.squareup.retrofit2", name = "converter-kotlinx-serialization", version.ref = "retrofit" }
okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version.ref = "okhttp" }
okhttp-logging = { group = "com.squareup.okhttp3", name = "logging-interceptor", version.ref = "okhttp" }
okhttp-mockwebserver = { group = "com.squareup.okhttp3", name = "mockwebserver", version.ref = "okhttp" }
kotlinx-serialization-json = { group = "org.jetbrains.kotlinx", name = "kotlinx-serialization-json", version.ref = "kotlinx-serialization" }

[plugins]
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version = "2.4.20" }
```

`app/build.gradle.kts`:

```kotlin
plugins {
    alias(libs.plugins.kotlin.serialization)
}

dependencies {
    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)
    testImplementation(libs.okhttp.mockwebserver)
}
```

The serialization plugin version follows the Kotlin version (2.4.20). Retrofit ships its own `converter-kotlinx-serialization` artifact; the old `jakewharton` converter is no longer needed.

## Manifest and permissions

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

Cleartext HTTP is blocked by default on API 28+. Keep it that way and pin or restrict domains in [network-security-config](../network-security-config/README.md).

## Implementation

### DTOs and API

```kotlin
package com.example.app.data.remote

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

@Serializable
data class ArticleDto(
    val id: String,
    val title: String,
    @SerialName("published_at") val publishedAt: String,
    val body: String? = null,
)

@Serializable
data class CreateArticleRequest(val title: String, val body: String)

interface ArticleApi {
    @GET("articles")
    suspend fun list(@Query("page") page: Int, @Query("size") size: Int = 20): List<ArticleDto>

    @GET("articles/{id}")
    suspend fun get(@Path("id") id: String): ArticleDto

    @POST("articles")
    suspend fun create(@Body request: CreateArticleRequest): ArticleDto
}
```

Make unknown fields tolerable (`ignoreUnknownKeys = true`) so a server adding a field does not break old clients. Give optional fields defaults.

### Interceptors

```kotlin
package com.example.app.data.remote

import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject

/** Supplies the current access token; backed by Keystore-protected storage in production. */
fun interface TokenProvider {
    fun currentToken(): String?
}

class AuthInterceptor @Inject constructor(private val tokenProvider: TokenProvider) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val token = tokenProvider.currentToken()
        val request = if (token == null) chain.request() else {
            chain.request().newBuilder().header("Authorization", "Bearer $token").build()
        }
        return chain.proceed(request)
    }
}
```

For token refresh use an OkHttp `Authenticator`: it is invoked on 401 and may return a new request with a refreshed token. Keep refresh single-flight with a `Mutex` so parallel 401s do not refresh twice.

### Error mapping

```kotlin
package com.example.app.data.remote

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.HttpException
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
    throw e                                  // never swallow cancellation
} catch (e: HttpException) {
    NetworkResult.HttpError(e.code(), e.response()?.errorBody()?.string())
} catch (e: IOException) {
    NetworkResult.Offline                    // DNS, timeout, no connectivity
} catch (e: SerializationException) {
    NetworkResult.Unexpected(e)
}
```

### Hilt module

```kotlin
package com.example.app.di

import com.example.app.BuildConfig
import com.example.app.data.remote.ArticleApi
import com.example.app.data.remote.AuthInterceptor
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {
    @Provides @Singleton
    fun provideJson(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
    }

    @Provides @Singleton
    fun provideOkHttp(auth: AuthInterceptor): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .addInterceptor(auth)
        .apply {
            if (BuildConfig.DEBUG) {
                addInterceptor(HttpLoggingInterceptor().apply {
                    level = HttpLoggingInterceptor.Level.BASIC   // BODY logs tokens and PII; never in release
                })
            }
        }
        .build()

    @Provides @Singleton
    fun provideRetrofit(client: OkHttpClient, json: Json): Retrofit = Retrofit.Builder()
        .baseUrl(BuildConfig.API_BASE_URL)              // from buildConfigField, not a literal
        .client(client)
        .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
        .build()

    @Provides @Singleton
    fun provideArticleApi(retrofit: Retrofit): ArticleApi = retrofit.create(ArticleApi::class.java)
}
```

Define `API_BASE_URL` per build type: `buildConfigField("String", "API_BASE_URL", "\"https://api.example.com/v1/\"")` with `buildFeatures { buildConfig = true }`. The base URL must end with `/`.

### Repository and ViewModel

```kotlin
interface ArticleRepository {
    suspend fun articles(page: Int): NetworkResult<List<Article>>
}

class RemoteArticleRepository @Inject constructor(
    private val api: ArticleApi,
    @IoDispatcher private val io: CoroutineDispatcher,
) : ArticleRepository {
    override suspend fun articles(page: Int): NetworkResult<List<Article>> = withContext(io) {
        safeCall { api.list(page).map { it.toDomain() } }
    }
}

sealed interface ArticlesUiState {
    data object Loading : ArticlesUiState
    data class Content(val articles: List<Article>) : ArticlesUiState
    data object Empty : ArticlesUiState
    data class Error(val message: String, val retryable: Boolean) : ArticlesUiState
}

@HiltViewModel
class ArticlesViewModel @Inject constructor(private val repo: ArticleRepository) : ViewModel() {
    private val _uiState = MutableStateFlow<ArticlesUiState>(ArticlesUiState.Loading)
    val uiState: StateFlow<ArticlesUiState> = _uiState.asStateFlow()

    init { refresh() }

    fun refresh() {
        viewModelScope.launch {
            _uiState.value = ArticlesUiState.Loading
            _uiState.value = when (val r = repo.articles(page = 1)) {
                is NetworkResult.Success -> if (r.data.isEmpty()) ArticlesUiState.Empty else ArticlesUiState.Content(r.data)
                is NetworkResult.Offline -> ArticlesUiState.Error("You are offline", retryable = true)
                is NetworkResult.HttpError -> ArticlesUiState.Error("Server error ${r.code}", retryable = r.code >= 500)
                is NetworkResult.Unexpected -> ArticlesUiState.Error("Something went wrong", retryable = true)
            }
        }
    }
}
```

Retrofit's suspend calls already hop off the main thread; the `withContext(io)` is there so the mapping and any disk work stay off main and the dispatcher is replaceable in tests.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*ArticleApiTest*"
adb logcat -s OkHttp     # debug build shows request lines with the Authorization header present
```

MockWebServer test:

```kotlin
class ArticleApiTest {
    private val server = MockWebServer()
    private lateinit var api: ArticleApi

    @Before fun setUp() {
        server.start()
        val json = Json { ignoreUnknownKeys = true }
        api = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .client(OkHttpClient.Builder().addInterceptor(AuthInterceptor { "t0k3n" }).build())
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(ArticleApi::class.java)
    }

    @After fun tearDown() = server.shutdown()

    @Test fun listSendsAuthHeaderAndParses() = runTest {
        server.enqueue(MockResponse().setBody("""[{"id":"1","title":"Hi","published_at":"2026-01-01","extra":1}]"""))
        val result = api.list(page = 1)
        assertEquals("Hi", result.single().title)
        assertEquals("Bearer t0k3n", server.takeRequest().getHeader("Authorization"))
    }

    @Test fun serverErrorMapsToHttpError() = runTest {
        server.enqueue(MockResponse().setResponseCode(503))
        val r = safeCall { api.list(1) }
        assertTrue(r is NetworkResult.HttpError && r.code == 503)
    }
}
```

## Pitfalls

- `HttpLoggingInterceptor.Level.BODY` in a release build leaks tokens and user data into logcat. Gate on `BuildConfig.DEBUG`.
- Catching `Exception` in `safeCall` without rethrowing `CancellationException` keeps cancelled coroutines alive and reports phantom errors.
- A base URL without a trailing slash makes relative endpoint paths replace the last segment.
- `Retrofit.create` is reflective and cheap, but build `Retrofit` and `OkHttpClient` once; each `OkHttpClient` owns a thread pool and connection pool.
- Missing `ignoreUnknownKeys` turns every server-side field addition into a client crash.
- Do not put the base URL or API keys in source. Use `buildConfigField` fed from `local.properties` or CI secrets, and remember that anything in the APK is extractable; real secrets stay on your server.
- Retrofit returns `HttpException` for non-2xx responses only when the return type is the body directly. If you declare `Response<T>` you must check `isSuccessful` yourself.

## Sources

- https://square.github.io/retrofit/
- https://square.github.io/okhttp/
- https://github.com/Kotlin/kotlinx.serialization
- https://developer.android.com/training/basics/network-ops/connecting
- https://developer.android.com/privacy-and-security/security-config
