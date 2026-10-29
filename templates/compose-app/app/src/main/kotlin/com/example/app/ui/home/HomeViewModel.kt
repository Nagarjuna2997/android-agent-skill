package com.example.app.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.app.data.Item
import com.example.app.data.ItemRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.IOException
import javax.inject.Inject

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repository: ItemRepository,
) : ViewModel() {

    private data class Transient(
        val isRefreshing: Boolean = false,
        val error: String? = null,
        val loadFailed: String? = null,
    )

    private val transient = MutableStateFlow(Transient())

    val uiState: StateFlow<HomeUiState> = combine(
        repository.observeItems().map<List<Item>, Result<List<Item>>> { Result.success(it) }
            .catch { emit(Result.failure(it)) },
        transient,
    ) { result, transient ->
        result.fold(
            onSuccess = { items -> items.toUiState(transient) },
            onFailure = { e -> HomeUiState.Error(e.toUserMessage()) },
        )
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS),
        initialValue = HomeUiState.Loading,
    )

    init {
        onEvent(HomeEvent.Refresh)
    }

    fun onEvent(event: HomeEvent) {
        when (event) {
            HomeEvent.Refresh -> refresh()
            is HomeEvent.AddItem -> add(event.title)
            HomeEvent.ErrorShown -> transient.update { it.copy(error = null) }
        }
    }

    private fun refresh() {
        viewModelScope.launch {
            transient.update { it.copy(isRefreshing = true, loadFailed = null) }
            try {
                repository.refresh()
                transient.update { it.copy(isRefreshing = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                transient.update { it.copy(isRefreshing = false, loadFailed = e.toUserMessage()) }
            }
        }
    }

    private fun add(title: String) {
        val trimmed = title.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            try {
                repository.add(trimmed)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                transient.update { it.copy(error = e.toUserMessage()) }
            }
        }
    }

    private fun List<Item>.toUiState(transient: Transient): HomeUiState = when {
        isEmpty() && transient.loadFailed != null -> HomeUiState.Error(transient.loadFailed)
        isEmpty() && transient.isRefreshing -> HomeUiState.Loading
        isEmpty() -> HomeUiState.Empty
        else -> HomeUiState.Content(
            items = this,
            isRefreshing = transient.isRefreshing,
            transientError = transient.error ?: transient.loadFailed,
        )
    }

    private fun Throwable.toUserMessage(): String = when (this) {
        is IOException -> "Could not reach the server. Check your connection and try again."
        else -> message ?: "Something went wrong."
    }

    private companion object {
        const val STOP_TIMEOUT_MS = 5_000L
    }
}
