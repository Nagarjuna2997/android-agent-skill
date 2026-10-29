package com.example.app.ui.home

import app.cash.turbine.test
import com.example.app.data.InMemoryItemRepository
import com.example.app.data.Item
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import java.io.IOException

/**
 * Replaces Dispatchers.Main with a test dispatcher so viewModelScope runs on the test
 * scheduler. runTest detects the Main test dispatcher and shares its scheduler, so
 * advanceUntilIdle() inside a test drives ViewModel coroutines too.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(
    val dispatcher: TestDispatcher = StandardTestDispatcher(),
) : TestWatcher() {
    override fun starting(description: Description) = Dispatchers.setMain(dispatcher)
    override fun finished(description: Description) = Dispatchers.resetMain()
}

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private val repository = InMemoryItemRepository(ioDispatcher = mainDispatcherRule.dispatcher)

    @Test
    fun `starts loading then shows content after refresh`() = runTest {
        val viewModel = HomeViewModel(repository)

        viewModel.uiState.test {
            assertEquals(HomeUiState.Loading, awaitItem())

            advanceUntilIdle()
            val content = expectMostRecentItem()

            assertTrue("expected Content, got $content", content is HomeUiState.Content)
            content as HomeUiState.Content
            assertEquals(2, content.items.size)
            assertEquals(false, content.isRefreshing)
        }
    }

    @Test
    fun `shows error state when initial refresh fails`() = runTest {
        repository.failNextCall(IOException("offline"))
        val viewModel = HomeViewModel(repository)

        viewModel.uiState.test {
            assertEquals(HomeUiState.Loading, awaitItem())

            advanceUntilIdle()
            val error = expectMostRecentItem()

            assertTrue("expected Error, got $error", error is HomeUiState.Error)
        }
    }

    @Test
    fun `retry after failure loads content`() = runTest {
        repository.failNextCall(IOException("offline"))
        val viewModel = HomeViewModel(repository)

        viewModel.uiState.test {
            skipItems(1)
            advanceUntilIdle()
            assertTrue(expectMostRecentItem() is HomeUiState.Error)

            viewModel.onEvent(HomeEvent.Refresh)
            advanceUntilIdle()

            assertTrue(expectMostRecentItem() is HomeUiState.Content)
        }
    }

    @Test
    fun `adding an item appends it to content`() = runTest {
        val viewModel = HomeViewModel(repository)

        viewModel.uiState.test {
            skipItems(1)
            advanceUntilIdle()
            assertTrue(expectMostRecentItem() is HomeUiState.Content)

            viewModel.onEvent(HomeEvent.AddItem("  Third item  "))
            advanceUntilIdle()

            val updated = expectMostRecentItem() as HomeUiState.Content
            assertEquals(listOf("First item", "Second item", "Third item"), updated.items.map(Item::title))
        }
    }

    @Test
    fun `blank titles are ignored`() = runTest {
        val viewModel = HomeViewModel(repository)

        viewModel.uiState.test {
            skipItems(1)
            advanceUntilIdle()
            val before = expectMostRecentItem() as HomeUiState.Content

            viewModel.onEvent(HomeEvent.AddItem("   "))
            advanceUntilIdle()
            expectNoEvents()

            assertEquals(2, before.items.size)
        }
    }

    @Test
    fun `add failure surfaces a transient error that clears when shown`() = runTest {
        val viewModel = HomeViewModel(repository)

        viewModel.uiState.test {
            skipItems(1)
            advanceUntilIdle()
            assertTrue(expectMostRecentItem() is HomeUiState.Content)

            repository.failNextCall(IOException("offline"))
            viewModel.onEvent(HomeEvent.AddItem("Will fail"))
            advanceUntilIdle()

            val withError = expectMostRecentItem() as HomeUiState.Content
            assertNotNull(withError.transientError)
            assertEquals(2, withError.items.size)

            viewModel.onEvent(HomeEvent.ErrorShown)
            advanceUntilIdle()

            val cleared = expectMostRecentItem() as HomeUiState.Content
            assertNull(cleared.transientError)
        }
    }
}
