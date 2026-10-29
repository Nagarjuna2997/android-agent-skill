package com.example.app.ui.home

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.example.app.R
import com.example.app.data.Item
import com.example.app.ui.theme.AppTheme

/** Route-level composable: owns the ViewModel and nothing else. */
@Composable
fun HomeRoute(
    onItemClick: (Item) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: HomeViewModel = hiltViewModel(),
) {
    val uiState by viewModel.uiState.collectAsStateWithLifecycle()
    HomeScreen(
        uiState = uiState,
        onEvent = viewModel::onEvent,
        onItemClick = onItemClick,
        modifier = modifier,
    )
}

/** Stateless screen: renders [uiState], reports user intent through [onEvent]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    uiState: HomeUiState,
    onEvent: (HomeEvent) -> Unit,
    onItemClick: (Item) -> Unit,
    modifier: Modifier = Modifier,
) {
    val snackbarHostState = remember { SnackbarHostState() }
    val transientError = (uiState as? HomeUiState.Content)?.transientError

    LaunchedEffect(transientError) {
        if (transientError != null) {
            snackbarHostState.showSnackbar(transientError)
            onEvent(HomeEvent.ErrorShown)
        }
    }

    Scaffold(
        modifier = modifier,
        topBar = { TopAppBar(title = { Text(stringResource(R.string.home_title)) }) },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { innerPadding ->
        when (uiState) {
            HomeUiState.Loading -> LoadingContent(innerPadding)
            HomeUiState.Empty -> EmptyContent(innerPadding, onAdd = { onEvent(HomeEvent.AddItem(it)) })
            is HomeUiState.Content -> ItemsContent(
                state = uiState,
                innerPadding = innerPadding,
                onItemClick = onItemClick,
                onAdd = { onEvent(HomeEvent.AddItem(it)) },
            )
            is HomeUiState.Error -> ErrorContent(
                message = uiState.message,
                innerPadding = innerPadding,
                onRetry = { onEvent(HomeEvent.Refresh) },
            )
        }
    }
}

@Composable
private fun LoadingContent(innerPadding: PaddingValues) {
    Box(
        modifier = Modifier.fillMaxSize().padding(innerPadding).testTag("home_loading"),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

@Composable
private fun EmptyContent(innerPadding: PaddingValues, onAdd: (String) -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(innerPadding).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.home_empty),
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.testTag("home_empty"),
        )
        Spacer(Modifier.height(16.dp))
        AddItemRow(onAdd = onAdd)
    }
}

@Composable
private fun ItemsContent(
    state: HomeUiState.Content,
    innerPadding: PaddingValues,
    onItemClick: (Item) -> Unit,
    onAdd: (String) -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().padding(innerPadding)) {
        if (state.isRefreshing) {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        LazyColumn(
            modifier = Modifier.weight(1f).testTag("home_list"),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            items(items = state.items, key = { it.id }, contentType = { "item" }) { item ->
                ItemCard(item = item, onClick = { onItemClick(item) })
            }
        }
        AddItemRow(onAdd = onAdd, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
    }
}

@Composable
private fun ItemCard(item: Item, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Card(onClick = onClick, modifier = modifier.fillMaxWidth()) {
        Text(
            text = item.title,
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(16.dp),
        )
    }
}

@Composable
private fun AddItemRow(onAdd: (String) -> Unit, modifier: Modifier = Modifier) {
    var title by rememberSaveable { mutableStateOf("") }
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            label = { Text(stringResource(R.string.home_new_item_label)) },
            singleLine = true,
            modifier = Modifier.weight(1f).testTag("home_new_item_field"),
        )
        Button(
            onClick = {
                onAdd(title)
                title = ""
            },
            enabled = title.isNotBlank(),
            modifier = Modifier.testTag("home_add_button"),
        ) {
            Text(stringResource(R.string.home_add))
        }
    }
}

@Composable
private fun ErrorContent(message: String, innerPadding: PaddingValues, onRetry: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(innerPadding).padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.testTag("home_error"),
        )
        Spacer(Modifier.height(16.dp))
        Button(onClick = onRetry) { Text(stringResource(R.string.retry)) }
    }
}

private val previewItems = listOf(Item(1, "First item"), Item(2, "Second item"))

@Preview(showBackground = true)
@Composable
private fun HomeScreenContentPreview() {
    AppTheme { HomeScreen(HomeUiState.Content(previewItems), onEvent = {}, onItemClick = {}) }
}

@Preview(showBackground = true)
@Composable
private fun HomeScreenEmptyPreview() {
    AppTheme { HomeScreen(HomeUiState.Empty, onEvent = {}, onItemClick = {}) }
}

@Preview(showBackground = true)
@Composable
private fun HomeScreenErrorPreview() {
    AppTheme { HomeScreen(HomeUiState.Error("Could not reach the server."), onEvent = {}, onItemClick = {}) }
}
