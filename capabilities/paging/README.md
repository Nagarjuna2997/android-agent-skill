# Paging

Infinite lists with Paging 3.5.1 backed by Room 2.8.5 and a `RemoteMediator`: the database as the single source of truth, a remote-keys table, `Pager` exposed from a repository, `cachedIn(viewModelScope)`, `collectAsLazyPagingItems()` with load-state UI for refresh, append errors and empty results, and a `RemoteMediator` test.

## When to use

- Lists longer than a few screens that come from a paged API: feeds, search results, transaction history.
- Offline-first: the UI reads from Room, the mediator fills Room from the network. For a purely in-memory list from the network use a `PagingSource` directly and skip Room.
- For small lists (under a few hundred items) a plain `Flow<List<T>>` from Room is simpler; see [room-database](../room-database/README.md).

## Dependencies

```toml
[versions]
paging = "3.5.1"
room = "2.8.5"

[libraries]
paging-runtime = { group = "androidx.paging", name = "paging-runtime", version.ref = "paging" }
paging-compose = { group = "androidx.paging", name = "paging-compose", version.ref = "paging" }
paging-testing = { group = "androidx.paging", name = "paging-testing", version.ref = "paging" }
room-paging = { group = "androidx.room", name = "room-paging", version.ref = "room" }
```

```kotlin
dependencies {
    implementation(libs.paging.runtime)
    implementation(libs.paging.compose)
    implementation(libs.room.paging)
    testImplementation(libs.paging.testing)
}
```

Room, KSP and the network client are set up as in [room-database](../room-database/README.md) and [retrofit-networking](../retrofit-networking/README.md).

## Manifest and permissions

`INTERNET` only.

## Implementation

### Entities, DAOs and remote keys

```kotlin
package com.example.app.data.local

import androidx.paging.PagingSource
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Upsert

@Entity(tableName = "articles")
data class ArticleEntity(
    @PrimaryKey val id: String,
    val title: String,
    val publishedAt: Long,
    val indexInResponse: Int,   // preserves server order across pages
)

@Entity(tableName = "article_remote_keys")
data class ArticleRemoteKey(@PrimaryKey val articleId: String, val prevPage: Int?, val nextPage: Int?)

@Dao
interface ArticleDao {
    @Query("SELECT * FROM articles ORDER BY indexInResponse ASC")
    fun pagingSource(): PagingSource<Int, ArticleEntity>

    @Upsert suspend fun upsertAll(items: List<ArticleEntity>)
    @Query("DELETE FROM articles") suspend fun clear()
}

@Dao
interface ArticleRemoteKeyDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAll(keys: List<ArticleRemoteKey>)
    @Query("SELECT * FROM article_remote_keys WHERE articleId = :id") suspend fun byId(id: String): ArticleRemoteKey?
    @Query("DELETE FROM article_remote_keys") suspend fun clear()
    @Query("SELECT MAX(updatedAt) FROM article_remote_keys") suspend fun lastUpdated(): Long?
}
```

Add `val updatedAt: Long` to `ArticleRemoteKey` if you use the `lastUpdated()` freshness check; omit both otherwise. Add both entities to `AppDatabase`.

### RemoteMediator

```kotlin
package com.example.app.data

import androidx.paging.ExperimentalPagingApi
import androidx.paging.LoadType
import androidx.paging.PagingState
import androidx.paging.RemoteMediator
import androidx.room.withTransaction
import com.example.app.data.local.AppDatabase
import com.example.app.data.local.ArticleEntity
import com.example.app.data.local.ArticleRemoteKey
import com.example.app.data.remote.ArticleApi
import kotlinx.coroutines.CancellationException
import retrofit2.HttpException
import java.io.IOException

@OptIn(ExperimentalPagingApi::class)
class ArticleRemoteMediator(
    private val api: ArticleApi,
    private val db: AppDatabase,
    private val pageSize: Int,
) : RemoteMediator<Int, ArticleEntity>() {

    private val articleDao = db.articleDao()
    private val keyDao = db.articleRemoteKeyDao()

    override suspend fun initialize(): InitializeAction = InitializeAction.LAUNCH_INITIAL_REFRESH

    override suspend fun load(loadType: LoadType, state: PagingState<Int, ArticleEntity>): MediatorResult {
        val page = when (loadType) {
            LoadType.REFRESH -> 1
            LoadType.PREPEND -> return MediatorResult.Success(endOfPaginationReached = true)
            LoadType.APPEND -> {
                val last = state.lastItemOrNull() ?: return MediatorResult.Success(endOfPaginationReached = true)
                keyDao.byId(last.id)?.nextPage ?: return MediatorResult.Success(endOfPaginationReached = true)
            }
        }
        return try {
            val response = api.list(page = page, size = pageSize)
            val end = response.size < pageSize
            db.withTransaction {
                if (loadType == LoadType.REFRESH) { keyDao.clear(); articleDao.clear() }
                val offset = (page - 1) * pageSize
                articleDao.upsertAll(response.mapIndexed { i, dto ->
                    ArticleEntity(dto.id, dto.title, dto.publishedAtEpoch, indexInResponse = offset + i)
                })
                keyDao.insertAll(response.map {
                    ArticleRemoteKey(it.id, prevPage = if (page == 1) null else page - 1, nextPage = if (end) null else page + 1)
                })
            }
            MediatorResult.Success(endOfPaginationReached = end)
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            MediatorResult.Error(e)
        } catch (e: HttpException) {
            MediatorResult.Error(e)
        }
    }
}
```

`RemoteMediator` is still annotated `@ExperimentalPagingApi` in 3.5.1; the opt-in is required and the API has been stable in practice across the 3.x line. State that when reporting.

### Repository and ViewModel

```kotlin
interface ArticleRepository {
    fun pagedArticles(): Flow<PagingData<Article>>
}

class OfflineFirstArticleRepository @Inject constructor(
    private val api: ArticleApi,
    private val db: AppDatabase,
) : ArticleRepository {
    @OptIn(ExperimentalPagingApi::class)
    override fun pagedArticles(): Flow<PagingData<Article>> = Pager(
        config = PagingConfig(pageSize = 20, prefetchDistance = 10, enablePlaceholders = false),
        remoteMediator = ArticleRemoteMediator(api, db, pageSize = 20),
        pagingSourceFactory = { db.articleDao().pagingSource() },
    ).flow.map { data -> data.map { it.toDomain() } }
}

@HiltViewModel
class FeedViewModel @Inject constructor(repo: ArticleRepository) : ViewModel() {
    val articles: Flow<PagingData<Article>> = repo.pagedArticles().cachedIn(viewModelScope)
}
```

`cachedIn` must be applied once, in the ViewModel, and before any UI-specific transformation; without it, rotation restarts loading.

### Compose UI

```kotlin
@Composable
fun FeedScreen(viewModel: FeedViewModel = hiltViewModel()) {
    val items = viewModel.articles.collectAsLazyPagingItems()
    val refresh = items.loadState.refresh
    val append = items.loadState.append

    when {
        refresh is LoadState.Loading && items.itemCount == 0 -> FullScreenLoading()
        refresh is LoadState.Error && items.itemCount == 0 -> FullScreenError(onRetry = items::retry)
        refresh is LoadState.NotLoading && items.itemCount == 0 && append.endOfPaginationReached -> EmptyFeed()
        else -> LazyColumn {
            items(count = items.itemCount, key = items.itemKey { it.id }, contentType = items.itemContentType { "article" }) { index ->
                val article = items[index] ?: return@items
                ArticleRow(article)
            }
            when (append) {
                is LoadState.Loading -> item { RowLoading() }
                is LoadState.Error -> item { RowError(onRetry = items::retry) }
                else -> Unit
            }
        }
    }
}
```

Pull-to-refresh calls `items.refresh()`. `refresh` `LoadState` reflects the mediator when one is present; a mediator error with cached rows should show a snackbar, not replace the list.

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*ArticleRemoteMediatorTest*"
./gradlew :app:connectedDebugAndroidTest
adb shell settings put global airplane_mode_on 1 && adb shell am broadcast -a android.intent.action.AIRPLANE_MODE   # cached pages still render
```

Mediator test (Robolectric or instrumented, needs Room):

```kotlin
@OptIn(ExperimentalPagingApi::class)
@RunWith(AndroidJUnit4::class)
class ArticleRemoteMediatorTest {
    private val db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), AppDatabase::class.java).build()

    @Test fun refreshLoadsFirstPageAndSignalsMore() = runTest {
        val api = FakeArticleApi(totalItems = 45)
        val mediator = ArticleRemoteMediator(api, db, pageSize = 20)
        val state = PagingState<Int, ArticleEntity>(emptyList(), null, PagingConfig(20), 0)

        val result = mediator.load(LoadType.REFRESH, state)

        assertTrue(result is RemoteMediator.MediatorResult.Success && !result.endOfPaginationReached)
        assertEquals(20, db.articleDao().pagingSource().load(PagingSource.LoadParams.Refresh(null, 20, false)).let { (it as PagingSource.LoadResult.Page).data.size })
    }

    @Test fun networkFailureReturnsError() = runTest {
        val mediator = ArticleRemoteMediator(FakeArticleApi(fail = IOException("offline")), db, 20)
        val result = mediator.load(LoadType.REFRESH, PagingState(emptyList(), null, PagingConfig(20), 0))
        assertTrue(result is RemoteMediator.MediatorResult.Error)
    }
}
```

`paging-testing` also provides `asSnapshot()` to collect a `Flow<PagingData<T>>` into a `List` in ViewModel tests.

## Pitfalls

- Sorting by a server field that changes between pages (for example `publishedAt` with new posts arriving) causes duplicates or gaps; store `indexInResponse` and sort by it.
- Forgetting `cachedIn` leads to the whole list reloading on every recomposition that re-collects.
- `enablePlaceholders = true` with `itemKey` requires handling `null` items in the list; the recipe disables placeholders.
- `LoadType.PREPEND` must return `endOfPaginationReached = true` for lists that only grow downward, or the mediator keeps retrying at the top.
- Clearing tables outside `withTransaction` lets the UI flash empty between clear and insert.
- `MediatorResult.Error` for `HttpException` 401 should trigger the auth refresh path rather than infinite retry on scroll.
- A `PagingSource` from Room invalidates on any write to the table; frequent unrelated writes cause visible reloads. Keep paged tables focused.

## Sources

- https://developer.android.com/topic/libraries/architecture/paging/v3-overview
- https://developer.android.com/topic/libraries/architecture/paging/v3-network-db
- https://developer.android.com/develop/ui/compose/lists#paging
- https://developer.android.com/topic/libraries/architecture/paging/test
- https://developer.android.com/jetpack/androidx/releases/paging
