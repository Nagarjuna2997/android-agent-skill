# Home screen widget

A home-screen widget built with Jetpack Glance: a `GlanceAppWidget` that renders Compose-like UI into `RemoteViews`, a receiver declared in the manifest with provider metadata, responsive sizes, data loaded through a Hilt entry point, click actions that open the app or run a callback, and updating the widget from WorkManager or after a data change.

## When to use

- Surfacing a small piece of app state on the home screen: next event, unread count, a quick action, a progress ring.
- Glance supports a subset of Compose (`Column`, `Row`, `Box`, `Text`, `Image`, `Button`, `LazyColumn`, `Spacer`) and its own modifiers (`GlanceModifier`). Material 3 composables and arbitrary drawing are not available.
- For a lock-screen or Wear tile the API differs; this recipe is home screen only.

## Dependencies

Glance's version is not in `data/versions.json`; resolve it from the release page.

```toml
[versions]
glance = "<version>"   # https://developer.android.com/jetpack/androidx/releases/glance

[libraries]
glance-appwidget = { group = "androidx.glance", name = "glance-appwidget", version.ref = "glance" }
glance-material3 = { group = "androidx.glance", name = "glance-material3", version.ref = "glance" }
glance-testing = { group = "androidx.glance", name = "glance-testing", version.ref = "glance" }
glance-appwidget-testing = { group = "androidx.glance", name = "glance-appwidget-testing", version.ref = "glance" }
```

```kotlin
dependencies {
    implementation(libs.glance.appwidget)
    implementation(libs.glance.material3)
    testImplementation(libs.glance.testing)
    testImplementation(libs.glance.appwidget.testing)
}
```

## Manifest and permissions

```xml
<receiver
    android:name=".widget.NextEventWidgetReceiver"
    android:exported="true"
    android:label="@string/widget_next_event">
    <intent-filter>
        <action android:name="android.appwidget.action.APPWIDGET_UPDATE" />
    </intent-filter>
    <meta-data
        android:name="android.appwidget.provider"
        android:resource="@xml/next_event_widget_info" />
</receiver>
```

`res/xml/next_event_widget_info.xml`:

```xml
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
    android:minWidth="110dp"
    android:minHeight="40dp"
    android:targetCellWidth="2"
    android:targetCellHeight="1"
    android:maxResizeWidth="250dp"
    android:maxResizeHeight="110dp"
    android:resizeMode="horizontal|vertical"
    android:updatePeriodMillis="1800000"
    android:previewLayout="@layout/next_event_widget_preview"
    android:description="@string/widget_next_event_desc"
    android:widgetCategory="home_screen" />
```

`exported="true"` is required for the launcher to send updates. `updatePeriodMillis` minimum is 30 minutes; use WorkManager for anything smarter.

## Implementation

### Widget

```kotlin
package com.example.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalSize
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.padding
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.example.app.MainActivity
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.flow.first

@EntryPoint
@InstallIn(SingletonComponent::class)
interface WidgetEntryPoint {
    fun eventRepository(): EventRepository
}

class NextEventWidget : GlanceAppWidget() {

    override val sizeMode = SizeMode.Responsive(setOf(SMALL, WIDE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repo = EntryPointAccessors.fromApplication(context.applicationContext, WidgetEntryPoint::class.java).eventRepository()
        val next = repo.nextEvent().first()   // suspend load before content; keep it fast
        provideContent {
            GlanceTheme {
                WidgetContent(next)
            }
        }
    }

    @Composable
    private fun WidgetContent(event: Event?) {
        val size = LocalSize.current
        Column(
            modifier = GlanceModifier.fillMaxSize()
                .background(GlanceTheme.colors.widgetBackground)
                .padding(12.dp)
                .clickable(actionStartActivity<MainActivity>()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (event == null) {
                Text("No upcoming events", style = TextStyle(color = GlanceTheme.colors.onSurface))
            } else {
                Text(event.title, style = TextStyle(fontWeight = FontWeight.Bold, fontSize = 14.sp, color = GlanceTheme.colors.onSurface), maxLines = 1)
                Text(event.startFormatted, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
                if (size.width >= WIDE.width) {
                    Text("Mark done", modifier = GlanceModifier.padding(top = 8.dp)
                        .clickable(actionRunCallback<MarkDoneAction>(actionParametersOf(EventIdKey to event.id))),
                        style = TextStyle(color = GlanceTheme.colors.primary))
                }
            }
        }
    }

    companion object {
        private val SMALL = DpSize(110.dp, 40.dp)
        private val WIDE = DpSize(250.dp, 40.dp)
    }
}

class NextEventWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NextEventWidget()
}
```

`GlanceTheme` with `glance-material3` picks up dynamic colors on API 31+ and falls back to a Material 3 scheme you supply via `GlanceTheme(colors = ...)` elsewhere.

### Action callback

```kotlin
package com.example.app.widget

import android.content.Context
import androidx.glance.GlanceId
import androidx.glance.action.ActionParameters
import androidx.glance.appwidget.action.ActionCallback
import dagger.hilt.android.EntryPointAccessors

val EventIdKey = ActionParameters.Key<String>("eventId")

class MarkDoneAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[EventIdKey] ?: return
        val repo = EntryPointAccessors.fromApplication(context.applicationContext, WidgetEntryPoint::class.java).eventRepository()
        repo.markDone(id)
        NextEventWidget().update(context, glanceId)
    }
}
```

### Updating from the app

```kotlin
class WidgetUpdater @Inject constructor(@ApplicationContext private val context: Context) {
    suspend fun refreshAll() = NextEventWidget().updateAll(context)
}
```

Call `refreshAll()` from the repository after a write that changes the next event, and from the periodic sync worker in [work-manager](../work-manager/README.md). `updateAll` is a suspend function in `androidx.glance.appwidget`.

## Verify

```sh
./gradlew :app:assembleDebug
adb shell appwidget grantbind --package com.example.app --user 0      # allow test binding on the emulator
./gradlew :app:testDebugUnitTest --tests "*NextEventWidgetTest*"
adb shell dumpsys appwidget | grep -A4 com.example.app              # provider registered, instances listed
```

Then on the emulator long-press the home screen, add the widget, and resize it to confirm the wide layout shows "Mark done". Record the result as a manual device check.

Unit test with `glance-appwidget-testing` (JVM, no device):

```kotlin
@OptIn(ExperimentalGlanceApi::class)
class NextEventWidgetTest {
    @Test fun showsEventTitle() = runGlanceAppWidgetUnitTest {
        setAppWidgetSize(DpSize(250.dp, 40.dp))
        provideComposable {
            GlanceTheme { NextEventWidget.WidgetContentForTest(Event("1", "Dentist", "Tue 9:00")) }
        }
        onNode(hasText("Dentist")).assertExists()
        onNode(hasText("Mark done")).assertExists()
    }
}
```

Expose the content composable as `internal` for the test (`WidgetContentForTest`). The testing APIs are annotated `@ExperimentalGlanceApi`; say so when reporting.

## Pitfalls

- Glance composables run in a special composition; using `androidx.compose.material3` or `Modifier` (instead of `GlanceModifier`) does not compile or throws at runtime.
- `provideGlance` has a strict time budget; a slow network call there times out the widget. Read from the local cache and refresh in the background.
- Forgetting `exported="true"` on the receiver means the launcher cannot bind the widget.
- `LazyColumn` in Glance has no scroll position state and limited item count; keep lists short.
- `actionRunCallback` classes need a public no-arg constructor; Hilt cannot inject them, hence the entry point.
- Widget previews (`previewLayout`) are XML on older launchers; on API 35+ you can also provide a Glance preview with `setWidgetPreview` from `AppWidgetManager`.
- Testing APIs and `SizeMode.Exact` behave differently across launchers; do not report "verified" without adding the widget on a device.

## Sources

- https://developer.android.com/develop/ui/compose/glance
- https://developer.android.com/develop/ui/compose/glance/create-app-widget
- https://developer.android.com/develop/ui/compose/glance/user-interaction
- https://developer.android.com/develop/ui/compose/glance/testing
- https://developer.android.com/jetpack/androidx/releases/glance
