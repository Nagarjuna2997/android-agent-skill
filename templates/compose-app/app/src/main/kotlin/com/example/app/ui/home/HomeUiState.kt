package com.example.app.ui.home

import com.example.app.data.Item

/** Everything the home screen needs to render, modeled as one immutable value. */
sealed interface HomeUiState {
    data object Loading : HomeUiState
    data object Empty : HomeUiState
    data class Content(
        val items: List<Item>,
        val isRefreshing: Boolean = false,
        val transientError: String? = null,
    ) : HomeUiState
    data class Error(val message: String) : HomeUiState
}

/** User intents the home screen can send to its ViewModel. */
sealed interface HomeEvent {
    data object Refresh : HomeEvent
    data class AddItem(val title: String) : HomeEvent
    data object ErrorShown : HomeEvent
}
