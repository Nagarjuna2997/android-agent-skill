# Settings screen

A Material 3 settings screen in Compose backed by Preferences DataStore 1.2.1: grouped preference rows (switch, radio dialog, navigation, action), a single `SettingsUiState` from the ViewModel, theme selection applied at the app root, accessible touch targets and semantics, previews with fake data and a Compose UI test.

## When to use

- Any app with user-adjustable behavior: theme, notifications, language, data usage, account actions.
- The data layer is [datastore-preferences](../datastore-preferences/README.md); this recipe is the UI and wiring on top of its `SettingsRepository`. Language rows come from [localization](../localization/README.md); notification rows from [notifications](../notifications/README.md).

## Dependencies

```toml
[versions]
datastore = "1.2.1"
lifecycle = "2.11.0"

[libraries]
datastore-preferences = { group = "androidx.datastore", name = "datastore-preferences", version.ref = "datastore" }
lifecycle-runtime-compose = { group = "androidx.lifecycle", name = "lifecycle-runtime-compose", version.ref = "lifecycle" }
compose-material3 = { group = "androidx.compose.material3", name = "material3" }   # version from the Compose BOM
```

```kotlin
dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.datastore.preferences)
}
```

## Manifest and permissions

None.

## Implementation

### ViewModel

```kotlin
package com.example.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.app.data.settings.SettingsRepository
import com.example.app.data.settings.ThemeMode
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class SettingsUiState(
    val loaded: Boolean = false,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val notificationsEnabled: Boolean = true,
    val wifiOnlySync: Boolean = false,
    val appVersion: String = "",
)

sealed interface SettingsEvent {
    data class ThemeChanged(val mode: ThemeMode) : SettingsEvent
    data class NotificationsToggled(val enabled: Boolean) : SettingsEvent
    data class WifiOnlyToggled(val enabled: Boolean) : SettingsEvent
    data object ClearCache : SettingsEvent
}

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val repository: SettingsRepository,
    private val cache: CacheRepository,
    appInfo: AppInfo,
) : ViewModel() {
    val uiState: StateFlow<SettingsUiState> = repository.settings
        .map { s ->
            SettingsUiState(
                loaded = true,
                themeMode = s.themeMode,
                notificationsEnabled = s.notificationsEnabled,
                wifiOnlySync = s.wifiOnlySync,
                appVersion = appInfo.versionName,
            )
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SettingsUiState(appVersion = appInfo.versionName))

    fun onEvent(event: SettingsEvent) {
        viewModelScope.launch {
            when (event) {
                is SettingsEvent.ThemeChanged -> repository.setThemeMode(event.mode)
                is SettingsEvent.NotificationsToggled -> repository.setNotificationsEnabled(event.enabled)
                is SettingsEvent.WifiOnlyToggled -> repository.setWifiOnlySync(event.enabled)
                SettingsEvent.ClearCache -> cache.clear()
            }
        }
    }
}
```

`AppInfo` is a small injected class exposing `BuildConfig.VERSION_NAME`; keep `BuildConfig` out of the ViewModel so it is testable from a pure JVM module.

### Reusable rows

```kotlin
package com.example.app.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp

@Composable
fun SettingsSectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, top = 24.dp, bottom = 8.dp),
    )
}

@Composable
fun SwitchRow(title: String, subtitle: String?, checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)   // whole row is the target
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Spacer(Modifier.width(16.dp))
        Switch(checked = checked, onCheckedChange = null)   // null: the row handles the click, one semantics node
    }
}

@Composable
fun NavigationRow(title: String, value: String?, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).clickable(onClick = onClick, role = Role.Button)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        value?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}
```

### Screen

```kotlin
@Composable
fun SettingsScreen(
    onOpenLanguage: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
    viewModel: SettingsViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    SettingsContent(state, viewModel::onEvent, onOpenLanguage, onOpenNotificationSettings)
}

@Composable
fun SettingsContent(
    state: SettingsUiState,
    onEvent: (SettingsEvent) -> Unit,
    onOpenLanguage: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
) {
    var showTheme by rememberSaveable { mutableStateOf(false) }
    Scaffold(topBar = { TopAppBar(title = { Text(stringResource(R.string.settings)) }) }) { padding ->
        Column(Modifier.padding(padding).verticalScroll(rememberScrollState())) {
            SettingsSectionTitle(stringResource(R.string.appearance))
            NavigationRow(stringResource(R.string.theme), value = state.themeMode.label(), onClick = { showTheme = true })
            NavigationRow(stringResource(R.string.language), value = null, onClick = onOpenLanguage)

            SettingsSectionTitle(stringResource(R.string.notifications))
            SwitchRow(stringResource(R.string.notifications_enabled), stringResource(R.string.notifications_enabled_desc),
                state.notificationsEnabled) { onEvent(SettingsEvent.NotificationsToggled(it)) }
            NavigationRow(stringResource(R.string.system_notification_settings), null, onOpenNotificationSettings)

            SettingsSectionTitle(stringResource(R.string.data))
            SwitchRow(stringResource(R.string.wifi_only), null, state.wifiOnlySync) { onEvent(SettingsEvent.WifiOnlyToggled(it)) }
            NavigationRow(stringResource(R.string.clear_cache), null, onClick = { onEvent(SettingsEvent.ClearCache) })

            SettingsSectionTitle(stringResource(R.string.about))
            NavigationRow(stringResource(R.string.version), state.appVersion, onClick = {})
        }
    }
    if (showTheme) {
        ThemeDialog(current = state.themeMode, onSelect = { onEvent(SettingsEvent.ThemeChanged(it)); showTheme = false }, onDismiss = { showTheme = false })
    }
}

@Composable
private fun ThemeDialog(current: ThemeMode, onSelect: (ThemeMode) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.theme)) },
        text = {
            Column(Modifier.selectableGroup()) {
                ThemeMode.entries.forEach { mode ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                        .selectable(selected = mode == current, onClick = { onSelect(mode) }, role = Role.RadioButton),
                        verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(selected = mode == current, onClick = null)
                        Spacer(Modifier.width(12.dp))
                        Text(mode.label())
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(android.R.string.cancel)) } },
    )
}

@Composable
private fun ThemeMode.label() = stringResource(when (this) {
    ThemeMode.SYSTEM -> R.string.theme_system
    ThemeMode.LIGHT -> R.string.theme_light
    ThemeMode.DARK -> R.string.theme_dark
})
```

### Applying the theme at the root

```kotlin
@Composable
fun AppRoot(settings: SettingsRepository) {
    val mode by settings.settings.map { it.themeMode }.collectAsStateWithLifecycle(ThemeMode.SYSTEM)
    val dark = when (mode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }
    AppTheme(darkTheme = dark) { AppNavHost() }
}
```

Inject `SettingsRepository` into the Activity with `@Inject lateinit var` (Hilt) and pass it in, or expose it from a root ViewModel.

### Preview

```kotlin
@Preview(showBackground = true)
@Composable
private fun SettingsPreview() {
    AppTheme { SettingsContent(SettingsUiState(loaded = true, appVersion = "1.0"), onEvent = {}, onOpenLanguage = {}, onOpenNotificationSettings = {}) }
}
```

## Verify

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest --tests "*SettingsViewModelTest*"
./gradlew :app:connectedDebugAndroidTest --tests "*SettingsScreenTest*"
```

Compose UI test:

```kotlin
@get:Rule val compose = createComposeRule()

@Test fun togglingNotificationsSendsEvent() {
    val events = mutableListOf<SettingsEvent>()
    compose.setContent {
        SettingsContent(SettingsUiState(loaded = true), onEvent = events::add, onOpenLanguage = {}, onOpenNotificationSettings = {})
    }
    compose.onNode(isToggleable() and hasText("Notifications")).performClick()
    assertEquals(listOf(SettingsEvent.NotificationsToggled(false)), events)
}
```

ViewModel test uses a `FakeSettingsRepository` with a `MutableStateFlow<UserSettings>` and Turbine to assert the mapped `uiState`.

## Pitfalls

- A `Switch` with its own `onCheckedChange` inside a clickable row creates two targets and double toggles; pass `null` and let the row own the semantics.
- Emitting the initial `SettingsUiState()` with defaults can flash the wrong theme on launch; keep `loaded = false` and hold a splash until the first real value arrives, or read the theme synchronously from a cached value.
- Rows under 48 dp fail touch-target checks; `heightIn(min = 56.dp)` matches Material list items.
- Writing settings directly from composables bypasses the ViewModel and makes previews impossible.
- Clearing the cache or signing out from a `viewModelScope` coroutine is cancelled if the screen closes mid-way; use an application scope for destructive multi-step work.

## Sources

- https://developer.android.com/topic/libraries/architecture/datastore
- https://developer.android.com/develop/ui/compose/components/switch
- https://developer.android.com/develop/ui/compose/accessibility
- https://m3.material.io/components/lists/guidelines
- https://developer.android.com/develop/ui/compose/testing
