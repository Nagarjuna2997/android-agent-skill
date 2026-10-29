# Image loading

Remote and local images in Compose with Coil 3: a singleton `ImageLoader` wired to the app's OkHttp client and configured memory and disk caches, `AsyncImage` with placeholders, error and crossfade, `SubcomposeAsyncImage` for custom loading UI, preloading, previews with a fake loader, and a test with Coil's test artifact.

## When to use

- Any screen that shows network images, content URIs from the photo picker, or files on disk.
- Coil 3 is Kotlin-first, coroutine-based, and multiplatform; Glide and Picasso are fine in existing projects but do not add them to new Compose code.

## Dependencies

Coil's version is not in `data/versions.json`; resolve it from the release page. All Coil artifacts share one version through the BOM.

```toml
[versions]
coil = "<version>"   # https://github.com/coil-kt/coil/releases

[libraries]
coil-bom = { group = "io.coil-kt.coil3", name = "coil-bom", version.ref = "coil" }
coil-compose = { group = "io.coil-kt.coil3", name = "coil-compose" }
coil-network-okhttp = { group = "io.coil-kt.coil3", name = "coil-network-okhttp" }
coil-svg = { group = "io.coil-kt.coil3", name = "coil-svg" }        # optional
coil-gif = { group = "io.coil-kt.coil3", name = "coil-gif" }        # optional
coil-test = { group = "io.coil-kt.coil3", name = "coil-test" }
```

```kotlin
dependencies {
    implementation(platform(libs.coil.bom))
    implementation(libs.coil.compose)
    implementation(libs.coil.network.okhttp)
    testImplementation(libs.coil.test)
    androidTestImplementation(libs.coil.test)
}
```

Coil 3 has no built-in network stack; without `coil-network-okhttp` (or `-ktor`) remote URLs fail with an unsupported-data error.

## Manifest and permissions

`INTERNET` for remote images. Nothing else; content URIs from the photo picker carry their own grant.

## Implementation

### ImageLoader singleton

```kotlin
package com.example.app.di

import android.content.Context
import coil3.ImageLoader
import coil3.disk.DiskCache
import coil3.disk.directory
import coil3.memory.MemoryCache
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import coil3.util.DebugLogger
import com.example.app.BuildConfig
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import okhttp3.OkHttpClient
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object ImageModule {
    @Provides @Singleton
    fun imageLoader(@ApplicationContext context: Context, okHttp: OkHttpClient): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { okHttp })) }
            .memoryCache { MemoryCache.Builder().maxSizePercent(context, 0.25).build() }
            .diskCache {
                DiskCache.Builder()
                    .directory(context.cacheDir.resolve("image_cache"))
                    .maxSizeBytes(256L * 1024 * 1024)
                    .build()
            }
            .crossfade(true)
            .apply { if (BuildConfig.DEBUG) logger(DebugLogger()) }
            .build()
}
```

Reusing the app's `OkHttpClient` shares the connection pool and auth interceptor so authenticated image URLs work. Register the loader once so every `AsyncImage` uses it:

```kotlin
@HiltAndroidApp
class App : Application(), SingletonImageLoader.Factory {
    @Inject lateinit var imageLoader: ImageLoader
    override fun newImageLoader(context: PlatformContext): ImageLoader = imageLoader
}
```

(`coil3.SingletonImageLoader` and `coil3.PlatformContext`.) Alternatively wrap the UI in `setSingletonImageLoaderFactory { imageLoader }` in `setContent`.

### Composables

```kotlin
package com.example.app.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import coil3.compose.AsyncImage
import coil3.compose.SubcomposeAsyncImage
import coil3.compose.SubcomposeAsyncImageContent
import coil3.request.ImageRequest
import coil3.request.crossfade
import coil3.size.Size
import com.example.app.R

@Composable
fun Avatar(url: String?, name: String, modifier: Modifier = Modifier) {
    AsyncImage(
        model = ImageRequest.Builder(LocalContext.current)
            .data(url)
            .crossfade(200)
            .build(),
        contentDescription = "Profile photo of $name",
        placeholder = painterResource(R.drawable.avatar_placeholder),
        error = painterResource(R.drawable.avatar_placeholder),
        fallback = painterResource(R.drawable.avatar_placeholder),   // when model is null
        contentScale = ContentScale.Crop,
        modifier = modifier.clip(CircleShape),
    )
}

@Composable
fun ArticleHero(url: String, modifier: Modifier = Modifier) {
    SubcomposeAsyncImage(
        model = url,
        contentDescription = null,          // decorative; the title carries the meaning
        contentScale = ContentScale.Crop,
        modifier = modifier,
    ) {
        when (painter.state.collectAsState().value) {
            is coil3.compose.AsyncImagePainter.State.Loading -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
            is coil3.compose.AsyncImagePainter.State.Error -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                Icon(painterResource(R.drawable.ic_broken_image), contentDescription = "Image failed to load", tint = MaterialTheme.colorScheme.outline)
            }
            else -> SubcomposeAsyncImageContent()
        }
    }
}
```

In a `LazyColumn`, `AsyncImage` with a fixed size modifier (`Modifier.size(...)` or `aspectRatio`) lets Coil request a downsampled bitmap; an unconstrained image decodes at full resolution.

### Preloading and cache control

```kotlin
class ImagePrefetcher @Inject constructor(
    @ApplicationContext private val context: Context,
    private val loader: ImageLoader,
) {
    fun prefetch(urls: List<String>) {
        urls.forEach { url ->
            loader.enqueue(ImageRequest.Builder(context).data(url).size(Size.ORIGINAL).build())
        }
    }

    suspend fun clear() {
        loader.memoryCache?.clear()
        loader.diskCache?.clear()
    }
}
```

To bust a cached image after the user changes their avatar, append a version query to the URL or set `.memoryCacheKey("avatar-$version")` and `.diskCacheKey(...)`.

### Previews

```kotlin
@Preview
@Composable
private fun AvatarPreview() {
    val previewHandler = AsyncImagePreviewHandler { ColorImage(Color.Gray.toArgb()) }
    CompositionLocalProvider(LocalAsyncImagePreviewHandler provides previewHandler) {
        Avatar(url = "https://example.com/a.jpg", name = "Ana", modifier = Modifier.size(48.dp))
    }
}
```

`AsyncImagePreviewHandler` and `LocalAsyncImagePreviewHandler` are in `coil3.compose`; previews never hit the network.

## Verify

```sh
./gradlew :app:assembleDebug
adb logcat -s RealImageLoader       # debug logger shows cache hits (MEMORY, DISK) and network fetches
adb shell run-as com.example.app du -sh cache/image_cache
./gradlew :app:connectedDebugAndroidTest --tests "*AvatarTest*"
```

Compose test with a fake engine:

```kotlin
@Test fun avatarRendersImage() {
    val engine = FakeImageLoaderEngine.Builder()
        .intercept("https://example.com/a.jpg", ColorImage(Color.Red.toArgb()))
        .default(ColorImage(Color.Blue.toArgb()))
        .build()
    val loader = ImageLoader.Builder(compose.activity).components { add(engine) }.build()
    compose.setContent {
        setSingletonImageLoaderFactory { loader }
        Avatar(url = "https://example.com/a.jpg", name = "Ana", Modifier.size(48.dp).testTag("avatar"))
    }
    compose.onNodeWithTag("avatar").assertIsDisplayed()
    compose.onNodeWithContentDescription("Profile photo of Ana").assertExists()
}
```

`FakeImageLoaderEngine` is in `coil3.test`.

## Pitfalls

- Missing `coil-network-okhttp` makes every `https` URL fail silently into the `error` painter.
- Creating `ImageLoader` per composable allocates caches repeatedly; one singleton for the app.
- `contentDescription = null` is correct for decorative images only; for photos that carry meaning, describe them.
- Setting `crossfade` on both the loader and the request is harmless; forgetting a `placeholder` in a list causes layout jumps if the size is not fixed.
- Coil 3 package is `coil3.*`; mixing `coil.*` (Coil 2) imports compiles with both artifacts present and then crashes at runtime. Remove Coil 2.
- Large images in a `LazyVerticalGrid` without `size` constraints exhaust memory; always bound the composable size.
- Disk cache in `cacheDir` can be cleared by the system; do not store originals there.

## Sources

- https://coil-kt.github.io/coil/
- https://coil-kt.github.io/coil/compose/
- https://coil-kt.github.io/coil/image_loaders/
- https://coil-kt.github.io/coil/testing/
- https://developer.android.com/develop/ui/compose/graphics/images/loading
