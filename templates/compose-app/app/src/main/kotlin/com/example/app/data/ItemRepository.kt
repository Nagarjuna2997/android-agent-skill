package com.example.app.data

import com.example.app.di.IoDispatcher
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/** A domain model shown on the home screen. */
data class Item(
    val id: Long,
    val title: String,
)

/**
 * Source of truth for [Item]s. All functions are main-safe.
 *
 * [observeItems] emits the current list immediately and again on every change.
 * [refresh] and [add] throw [IOException] when the backing store is unavailable.
 */
interface ItemRepository {
    fun observeItems(): Flow<List<Item>>
    suspend fun refresh()
    suspend fun add(title: String): Item
}

/**
 * In-memory implementation used by the template, by previews and by tests.
 * Replace with a Room- or network-backed implementation and keep this one for tests.
 *
 * [failNextCall] makes the next [refresh] or [add] throw, so error states can be exercised.
 */
@Singleton
class InMemoryItemRepository @Inject constructor(
    @IoDispatcher private val ioDispatcher: CoroutineDispatcher,
) : ItemRepository {

    private val items = MutableStateFlow<List<Item>>(emptyList())
    private var nextId = 1L
    private var failNext: Throwable? = null

    override fun observeItems(): Flow<List<Item>> = items

    override suspend fun refresh() = withContext(ioDispatcher) {
        throwIfArmed()
        delay(REFRESH_LATENCY_MS)
        if (items.value.isEmpty()) {
            items.value = listOf(newItem("First item"), newItem("Second item"))
        }
    }

    override suspend fun add(title: String): Item = withContext(ioDispatcher) {
        throwIfArmed()
        newItem(title).also { item -> items.update { it + item } }
    }

    fun failNextCall(error: Throwable = IOException("Simulated failure")) {
        failNext = error
    }

    private fun throwIfArmed() {
        failNext?.let { error ->
            failNext = null
            throw error
        }
    }

    private fun newItem(title: String): Item = Item(id = nextId++, title = title)

    private companion object {
        const val REFRESH_LATENCY_MS = 300L
    }
}
