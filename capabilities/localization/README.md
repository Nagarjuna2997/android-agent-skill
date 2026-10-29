# Localization

String resources, plurals, formatted arguments, per-app language preferences through `AppCompatDelegate`/`LocaleManager` on API 33+ with the AndroidX backport, locale-aware formatting of dates, numbers and currency, pseudolocales for layout testing, and a Compose language picker backed by a settings repository.

## When to use

- Every app that ships to more than one locale, and every app that wants users to pick its language independently of the system (required for a good experience on API 33+ where the system Settings exposes per-app language).
- Also use this for English-only apps: hard-coded strings in composables fail lint, break font scaling checks and make later translation expensive.

## Dependencies

AppCompat is needed for the per-app language backport below API 33. Its version is not in `data/versions.json`.

```toml
[versions]
appcompat = "<version>"   # https://developer.android.com/jetpack/androidx/releases/appcompat

[libraries]
androidx-appcompat = { group = "androidx.appcompat", name = "appcompat", version.ref = "appcompat" }
```

```kotlin
android {
    androidResources {
        generateLocaleConfig = true          // AGP writes res/xml/_generated_res_locale_config.xml from resConfigs
        localeFilters += listOf("en", "es", "de", "fr", "ja", "ar")
    }
}

dependencies {
    implementation(libs.androidx.appcompat)
}
```

`localeFilters` (formerly `resourceConfigurations`) lists the locales the app actually supports so unused translations from libraries are stripped and the generated locale config is accurate.

## Manifest and permissions

```xml
<application
    android:localeConfig="@xml/locales_config"
    ...>
    <service
        android:name="androidx.appcompat.app.AppLocalesMetadataHolderService"
        android:enabled="false"
        android:exported="false">
        <meta-data android:name="autoStoreLocales" android:value="true" />
    </service>
</application>
```

With `generateLocaleConfig = true` point `android:localeConfig` at `@xml/_generated_res_locale_config`. Otherwise write `res/xml/locales_config.xml` by hand:

```xml
<locale-config xmlns:android="http://schemas.android.com/apk/res/android">
    <locale android:name="en" />
    <locale android:name="es" />
    <locale android:name="de" />
    <locale android:name="fr" />
    <locale android:name="ja" />
    <locale android:name="ar" />
</locale-config>
```

The `AppLocalesMetadataHolderService` with `autoStoreLocales` makes AppCompat persist the chosen locale on API < 33; on 33+ the system stores it.

## Implementation

### Resources

`res/values/strings.xml`:

```xml
<resources>
    <string name="app_name">Example</string>
    <string name="greeting">Hello, %1$s</string>
    <string name="items_selected">%1$d of %2$d selected</string>
    <string name="last_synced">Last synced %1$s</string>
    <string name="language">Language</string>
    <string name="language_system">System default</string>
    <plurals name="unread_messages">
        <item quantity="one">%d unread message</item>
        <item quantity="other">%d unread messages</item>
    </plurals>
    <string name="cd_profile_photo">Profile photo of %1$s</string>
    <string name="terms_notice" translatable="false">v%1$s</string>
</resources>
```

Positional arguments (`%1$s`) are mandatory so translators can reorder. `translatable="false"` for version strings and URLs. Every locale folder (`values-es`, `values-de`, `values-ar`) carries the same keys; missing keys fall back to `values/`, and lint's `MissingTranslation` flags gaps.

### Compose usage

```kotlin
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource

@Composable
fun InboxHeader(name: String, unread: Int, selected: Int, total: Int) {
    Column {
        Text(stringResource(R.string.greeting, name))
        Text(pluralStringResource(R.plurals.unread_messages, unread, unread))
        Text(stringResource(R.string.items_selected, selected, total))
    }
}
```

Never concatenate translated fragments (`stringResource(R.string.hello) + name`); word order differs by language.

### Formatting

```kotlin
package com.example.app.util

import android.icu.text.NumberFormat
import android.icu.util.Currency
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

class Formatters(private val locale: Locale = Locale.getDefault()) {
    private val dateTime = DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM).withLocale(locale)
    fun dateTime(instant: Instant): String = dateTime.format(instant.atZone(ZoneId.systemDefault()))
    fun money(amountMinor: Long, currencyCode: String): String =
        NumberFormat.getCurrencyInstance(locale).apply { currency = Currency.getInstance(currencyCode) }
            .format(amountMinor / 100.0)
    fun count(n: Long): String = NumberFormat.getInstance(locale).format(n)
}
```

In Compose, read the current locale with `LocalConfiguration.current.locales[0]` and `remember(locale) { Formatters(locale) }` so formatting updates when the language changes. Use `android.icu.*` (API 24+) rather than `java.text` for correct CLDR data.

### Per-app language

```kotlin
package com.example.app.data.settings

import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import javax.inject.Inject

data class LanguageOption(val tag: String?, val displayName: String)   // null tag = system default

class LanguageRepository @Inject constructor() {
    val supported: List<LanguageOption> = listOf(
        LanguageOption(null, ""),   // label resolved in UI as R.string.language_system
        LanguageOption("en", "English"),
        LanguageOption("es", "Español"),
        LanguageOption("de", "Deutsch"),
        LanguageOption("fr", "Français"),
        LanguageOption("ja", "日本語"),
        LanguageOption("ar", "العربية"),
    )

    fun current(): String? = AppCompatDelegate.getApplicationLocales().toLanguageTags().ifEmpty { null }

    fun set(tag: String?) {
        AppCompatDelegate.setApplicationLocales(
            if (tag == null) LocaleListCompat.getEmptyLocaleList() else LocaleListCompat.forLanguageTags(tag)
        )
    }
}
```

`setApplicationLocales` recreates the Activity on API < 33 and applies system-wide per-app settings on 33+. The Activity must extend `AppCompatActivity` for the backport to work; with a plain `ComponentActivity` only API 33+ honors it. Display names are written in their own language so users who cannot read the current UI language can still find theirs.

### Picker

```kotlin
@Composable
fun LanguagePicker(viewModel: LanguageViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    Column(Modifier.selectableGroup()) {
        state.options.forEach { option ->
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .selectable(selected = option.tag == state.selectedTag, onClick = { viewModel.select(option.tag) }, role = Role.RadioButton)
                    .padding(horizontal = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = option.tag == state.selectedTag, onClick = null)
                Spacer(Modifier.width(16.dp))
                Text(option.tag?.let { option.displayName } ?: stringResource(R.string.language_system))
            }
        }
    }
}
```

The ViewModel reads `LanguageRepository.current()` into `selectedTag` and calls `set` on selection. Also offer a shortcut to the system page on API 33+: `Intent(Settings.ACTION_APP_LOCALE_SETTINGS, Uri.parse("package:$packageName"))`.

### RTL

Set `android:supportsRtl="true"` on `<application>`. In Compose use `start`/`end` padding and `Arrangement.Start`, not `left`/`right`; icons with direction (back arrows) use `Icons.AutoMirrored.*`.

## Verify

```sh
./gradlew :app:lintDebug                               # MissingTranslation, HardcodedText, ImpliedQuantity
./gradlew :app:assembleDebug
adb shell settings put system system_locales "ar-EG"   # emulator: switch system language (needs reboot or Settings)
adb shell am start -n com.example.app/.MainActivity --es locale es   # or use the in-app picker
adb shell cmd locale set-app-locales com.example.app --locales "ja"  # API 33+: set per-app language directly
```

Enable pseudolocales in debug builds to catch truncation and RTL issues: `android.buildTypes.debug.isPseudoLocalesEnabled = true`, then set the device language to `en-XA` (long strings) or `ar-XB` (RTL).

Compose test for plurals and arguments:

```kotlin
@Test fun pluralsRenderInSpanish() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val es = context.createConfigurationContext(Configuration(context.resources.configuration).apply { setLocale(Locale("es")) })
    assertEquals("3 mensajes sin leer", es.resources.getQuantityString(R.plurals.unread_messages, 3, 3))
}
```

## Pitfalls

- `Locale.getDefault()` in a cached singleton does not follow per-app language changes; read the locale at call time or key `remember` on the configuration.
- Using `%d` without position in plurals works until a translation needs to reorder; always `%1$d`.
- Languages with more plural forms (Russian, Arabic) need `few`, `many`, `zero` items; lint warns only if the translation exists.
- Date formatting with hard-coded patterns (`"MM/dd/yyyy"`) ignores locale; use `ofLocalizedDate`.
- `generateLocaleConfig` only lists locales in `localeFilters`; forgetting to add a new translation there hides it from the system picker.
- Without `AppLocalesMetadataHolderService` the chosen language is lost on process death on API < 33.
- Hard-coded strings in previews are fine; in production composables they fail `HardcodedText` lint.

## Sources

- https://developer.android.com/guide/topics/resources/localization
- https://developer.android.com/guide/topics/resources/app-languages
- https://developer.android.com/guide/topics/resources/string-resource
- https://developer.android.com/develop/ui/compose/resources
- https://developer.android.com/guide/topics/resources/pseudolocales
