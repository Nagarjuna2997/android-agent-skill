# Code Quality Checklist

The automated checks that keep a codebase consistent without a reviewer repeating the same comments: formatting with Spotless and ktlint, optional detekt, a custom lint module that enforces the project's own rules, Dependency Guard for the release classpath, and API-surface checks for library modules. The tooling here is what Now in Android runs in CI (see [../references/nowinandroid.md](../references/nowinandroid.md)); versions are not in `data/versions.json`, so every tool is marked `<version>` with its release page. The style rules themselves are in [../docs/kotlin/kotlin-style.md](../docs/kotlin/kotlin-style.md); the CI wiring is in [../templates/ci-cd/github-actions-android.yml](../templates/ci-cd/github-actions-android.yml).

## Ordering

Run checks from cheapest to most expensive so a formatting slip fails in seconds, not after a twenty-minute build:

1. `spotlessCheck` (seconds, no compilation)
2. `:build-logic:convention:check` when there is an included build
3. `dependencyGuard`
4. `lint` (compiles)
5. unit tests, screenshot tests
6. instrumented tests

## Formatting: Spotless with ktlint

- [ ] `com.diffplug.spotless` (`<version>`, https://github.com/diffplug/spotless/releases) applied through a convention plugin to every module and to the root for `build-logic` and `*.kts` files, never copied per module.
- [ ] ktlint (`<version>`, https://github.com/pinterest/ktlint/releases) as the Kotlin formatter with `android = true` in `.editorconfig` overrides; one `.editorconfig` at the root is the source of truth for indent, max line length and trailing commas.
- [ ] License or copyright header enforced from one file (`spotless/copyright.kt`, `.kts`, `.xml`) if the project needs one; otherwise skip `licenseHeaderFile` entirely rather than committing a placeholder header.
- [ ] `spotlessCheck` in the pre-commit hook next to `templates/hooks/check-android-style.sh` (the hook only greps for forbidden patterns; add `./gradlew spotlessCheck -q` to the same hook script), and in CI before anything that compiles.
- [ ] Generated sources excluded (`targetExclude("**/build/**")`); protobuf and Room schemas are not formatted.

```kotlin
// build-logic/convention/src/main/kotlin/com/example/app/buildlogic/Spotless.kt
package com.example.app.buildlogic

import com.diffplug.gradle.spotless.SpotlessExtension
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure

/** Applied by the application and library convention plugins. */
internal fun Project.configureSpotless() {
    pluginManager.apply("com.diffplug.spotless")
    extensions.configure<SpotlessExtension> {
        kotlin {
            target("src/**/*.kt")
            targetExclude("**/build/**")
            ktlint(libs.findVersion("ktlint").get().requiredVersion)
                .editorConfigOverride(mapOf("android" to "true"))
            endWithNewline()
        }
        format("kts") {
            target("*.kts")
            endWithNewline()
        }
        format("xml") {
            target("src/**/*.xml")
            endWithNewline()
        }
    }
}

/** Applied by RootPlugin: covers the build logic itself and the root scripts. */
internal fun Project.configureSpotlessForRoot() {
    pluginManager.apply("com.diffplug.spotless")
    extensions.configure<SpotlessExtension> {
        kotlin {
            target("build-logic/convention/src/**/*.kt")
            ktlint(libs.findVersion("ktlint").get().requiredVersion)
                .editorConfigOverride(mapOf("android" to "true"))
            endWithNewline()
        }
        format("kts") {
            target("*.kts", "build-logic/*.kts", "build-logic/convention/*.kts")
            endWithNewline()
        }
    }
}
```

```toml
# gradle/libs.versions.toml
[versions]
spotless = "<version>"   # https://github.com/diffplug/spotless/releases
ktlint = "<version>"     # https://github.com/pinterest/ktlint/releases (the formatter version, pinned separately from the plugin)

[libraries]
spotless-gradlePlugin = { module = "com.diffplug.spotless:spotless-plugin-gradle", version.ref = "spotless" }

[plugins]
spotless = { id = "com.diffplug.spotless", version.ref = "spotless" }
```

`build-logic/convention/build.gradle.kts` needs `compileOnly(libs.spotless.gradlePlugin)` for the extension type to resolve.

## detekt (optional)

- [ ] Add detekt (`io.gitlab.arturbosch.detekt`, `<version>`, https://github.com/detekt/detekt/releases) only when the team wants complexity and smell rules beyond formatting; ktlint already covers style.
- [ ] One `config/detekt/detekt.yml` generated with `detektGenerateConfig`, then trimmed: disable rules the team disagrees with instead of sprinkling `@Suppress`.
- [ ] `buildUponDefaultConfig = true` so a detekt upgrade adds new rules as warnings you can review, not errors that block the build.
- [ ] `detekt-formatting` not applied when Spotless already runs ktlint; two formatters disagree eventually.
- [ ] Baseline file (`detektBaseline`) committed once when adopting on an existing codebase, then shrunk over time; never regenerated to make a PR pass.

## Custom lint module

Android Lint is the one tool that sees Kotlin, resources, manifests and Gradle together, and it runs in Studio as you type. A `:lint` module with project-specific detectors is how a design system or a test-naming rule becomes a red squiggle instead of a review comment. The structure below mirrors Now in Android's `:lint` (`DesignSystemDetector`, `TestMethodNameDetector`); the detectors are original.

- [ ] `:lint` is a plain JVM module (`java-library` + `kotlin("jvm")`), compiled for JDK 17, with `compileOnly("com.android.tools.lint:lint-api:<version>")` where the lint version is AGP's major plus 23 (AGP 9.4.x pairs with `com.android.tools.lint:lint-api:32.4.x`; confirm on https://maven.google.com/web/index.html?q=lint-api).
- [ ] An `IssueRegistry` subclass registered in `src/main/resources/META-INF/services/com.android.tools.lint.client.api.IssueRegistry` with `api = CURRENT_API` and a `Vendor` so reports name the project.
- [ ] Consumers get the checks through the module that owns the rule: `lintPublish(project(":lint"))` in `:core:designsystem` ships the design-system check to every module that depends on the design system; `lintChecks(project(":lint"))` in `:app` for app-only rules.
- [ ] Each detector has a `TestLintTask` unit test with stubs for the Compose annotations it matches; `:lint:test` runs in CI.
- [ ] Severity `ERROR` for rules the build must enforce, `WARNING` with a quick fix for conventions.
- [ ] The lint convention plugin (`patterns/clean-architecture.md`) sets `xmlReport`, `sarifReport`, `checkDependencies = true` and disables `GradleDependency` so version bumps are not lint errors.

```kotlin
// lint/build.gradle.kts
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    `java-library`
    kotlin("jvm")
    id("com.example.android.lint")       // the convention plugin; applies com.android.lint for a JVM module
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }

dependencies {
    compileOnly(libs.kotlin.stdlib)
    compileOnly(libs.lint.api)             // com.android.tools.lint:lint-api:<version>
    testImplementation(libs.lint.checks)   // com.android.tools.lint:lint-checks:<version>
    testImplementation(libs.lint.tests)    // com.android.tools.lint:lint-tests:<version>
    testImplementation(libs.kotlin.test)
}
```

```kotlin
// lint/src/main/kotlin/com/example/app/lint/AppIssueRegistry.kt
package com.example.app.lint

import com.android.tools.lint.client.api.IssueRegistry
import com.android.tools.lint.client.api.Vendor
import com.android.tools.lint.detector.api.CURRENT_API

class AppIssueRegistry : IssueRegistry() {
    override val issues = listOf(
        DesignSystemDetector.ISSUE,
        TestMethodNameDetector.PREFIX,
    )
    override val api: Int = CURRENT_API
    override val minApi: Int = 14
    override val vendor = Vendor(vendorName = "App team", feedbackUrl = "https://example.com/lint-feedback")
}
```

```
# lint/src/main/resources/META-INF/services/com.android.tools.lint.client.api.IssueRegistry
com.example.app.lint.AppIssueRegistry
```

The design-system detector flags raw Material calls where a wrapper from [../capabilities/design-system-module/README.md](../capabilities/design-system-module/README.md) exists. It is a `UastScanner` matching call names, because a JVM lint module cannot depend on the Android design-system module to use function references:

```kotlin
// lint/src/main/kotlin/com/example/app/lint/DesignSystemDetector.kt
package com.example.app.lint

import com.android.tools.lint.client.api.UElementHandler
import com.android.tools.lint.detector.api.Category
import com.android.tools.lint.detector.api.Detector
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.JavaContext
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import org.jetbrains.uast.UCallExpression
import org.jetbrains.uast.UElement
import org.jetbrains.uast.UQualifiedReferenceExpression

/** Flags Material 3 composables and icon receivers that have an App* equivalent in :core:designsystem. */
class DesignSystemDetector : Detector(), Detector.UastScanner {

    override fun getApplicableUastTypes(): List<Class<out UElement>> =
        listOf(UCallExpression::class.java, UQualifiedReferenceExpression::class.java)

    override fun createUastHandler(context: JavaContext) = object : UElementHandler() {
        override fun visitCallExpression(node: UCallExpression) {
            val name = node.methodName ?: return
            val preferred = WRAPPED_COMPOSABLES[name] ?: return
            report(context, node, name, preferred)
        }

        override fun visitQualifiedReferenceExpression(node: UQualifiedReferenceExpression) {
            val receiver = node.receiver.asRenderString()
            val preferred = WRAPPED_RECEIVERS[receiver] ?: return
            report(context, node, receiver, preferred)
        }
    }

    private fun report(context: JavaContext, node: UElement, name: String, preferred: String) {
        context.report(
            issue = ISSUE,
            scope = node,
            location = context.getLocation(node),
            message = "Using $name instead of $preferred",
        )
    }

    companion object {
        @JvmField
        val ISSUE: Issue = Issue.create(
            id = "DesignSystem",
            briefDescription = "Use the design system wrapper",
            explanation = "Feature code must use the App* composables from :core:designsystem so colors, " +
                "paddings and icons stay consistent. Add a wrapper to the design system if one is missing.",
            category = Category.CUSTOM_LINT_CHECKS,
            priority = 7,
            severity = Severity.ERROR,
            implementation = Implementation(DesignSystemDetector::class.java, Scope.JAVA_FILE_SCOPE),
        )

        // Keep in sync with the wrappers that exist; a wrapper without an entry here is optional.
        val WRAPPED_COMPOSABLES: Map<String, String> = mapOf(
            "MaterialTheme" to "AppTheme",
            "Button" to "AppButton",
            "OutlinedButton" to "AppOutlinedButton",
            "TextButton" to "AppTextButton",
            "FilterChip" to "AppFilterChip",
            "TopAppBar" to "AppTopAppBar",
            "CenterAlignedTopAppBar" to "AppTopAppBar",
            "NavigationBar" to "AppNavigationBar",
            "NavigationBarItem" to "AppNavigationBarItem",
        )
        val WRAPPED_RECEIVERS: Map<String, String> = mapOf("Icons" to "AppIcons")
    }
}
```

A naming detector for tests, with a quick fix:

```kotlin
// lint/src/main/kotlin/com/example/app/lint/TestMethodNameDetector.kt
package com.example.app.lint

import com.android.tools.lint.detector.api.AnnotationInfo
import com.android.tools.lint.detector.api.AnnotationUsageInfo
import com.android.tools.lint.detector.api.Category
import com.android.tools.lint.detector.api.Detector
import com.android.tools.lint.detector.api.Implementation
import com.android.tools.lint.detector.api.Issue
import com.android.tools.lint.detector.api.JavaContext
import com.android.tools.lint.detector.api.LintFix
import com.android.tools.lint.detector.api.Scope
import com.android.tools.lint.detector.api.Severity
import com.android.tools.lint.detector.api.SourceCodeScanner
import com.intellij.psi.PsiMethod
import org.jetbrains.uast.UElement
import java.util.EnumSet

/** "testLoadsItems" says nothing "loadsItems" does not; the @Test annotation already marks it. */
class TestMethodNameDetector : Detector(), SourceCodeScanner {

    override fun applicableAnnotations() = listOf("org.junit.Test")

    override fun visitAnnotationUsage(
        context: JavaContext,
        element: UElement,
        annotationInfo: AnnotationInfo,
        usageInfo: AnnotationUsageInfo,
    ) {
        val method = usageInfo.referenced as? PsiMethod ?: return
        if (!method.name.startsWith("test")) return
        context.report(
            issue = PREFIX,
            scope = usageInfo.usage,
            location = context.getNameLocation(method),
            message = "Test method names should not start with `test`",
            quickfixData = LintFix.create().name("Remove prefix")
                .replace().pattern("""test[\s_]*""").with("").autoFix().build(),
        )
    }

    companion object {
        @JvmField
        val PREFIX: Issue = Issue.create(
            id = "TestMethodPrefix",
            briefDescription = "Redundant `test` prefix",
            explanation = "The @Test annotation marks the method; a `test` prefix repeats it and hides the behavior under test.",
            category = Category.TESTING,
            priority = 5,
            severity = Severity.WARNING,
            implementation = Implementation(
                TestMethodNameDetector::class.java,
                EnumSet.of(Scope.JAVA_FILE, Scope.TEST_SOURCES),
                EnumSet.of(Scope.JAVA_FILE),
                EnumSet.of(Scope.TEST_SOURCES),
            ),
        )
    }
}
```

The unit test that proves the detector fires and the quick fix is right:

```kotlin
// lint/src/test/kotlin/com/example/app/lint/DesignSystemDetectorTest.kt
package com.example.app.lint

import com.android.tools.lint.checks.infrastructure.TestFiles.kotlin
import com.android.tools.lint.checks.infrastructure.TestLintTask.lint
import org.junit.Test

class DesignSystemDetectorTest {
    private val composableStub = kotlin(
        """
        package androidx.compose.runtime
        annotation class Composable
        """,
    ).indented()

    private val materialStub = kotlin(
        """
        package androidx.compose.material3
        import androidx.compose.runtime.Composable
        @Composable fun Button(onClick: () -> Unit, content: () -> Unit) {}
        """,
    ).indented()

    @Test
    fun reportsRawMaterialButton() {
        lint()
            .issues(DesignSystemDetector.ISSUE)
            .allowMissingSdk()
            .files(
                composableStub, materialStub,
                kotlin(
                    """
                    import androidx.compose.material3.Button
                    import androidx.compose.runtime.Composable
                    @Composable fun Screen() { Button(onClick = {}) {} }
                    """,
                ).indented(),
            )
            .run()
            .expect(
                """
                src/test.kt:3: Error: Using Button instead of AppButton [DesignSystem]
                @Composable fun Screen() { Button(onClick = {}) {} }
                                           ~~~~~~~~~~~~~~~~~~~~~~~
                1 errors, 0 warnings
                """,
            )
    }
}
```

Expected-output strings are brittle across lint versions in whitespace only; regenerate with `.expect("")` and copy the failure output when upgrading AGP.

## Dependency Guard

The release runtime classpath is a security and size surface. `com.dropbox.dependency-guard` (`<version>`, https://github.com/dropbox/dependency-guard/releases) writes it to a committed text file and fails the build when it changes, so a transitive dependency that appears through an innocent bump is a visible diff in review.

- [ ] Plugin applied to `:app` (and any other application module such as a component catalog) through the application convention plugin.
- [ ] `dependencyGuard { configuration("releaseRuntimeClasspath") }`, or the flavor-specific `prodReleaseRuntimeClasspath` when flavors exist.
- [ ] `app/dependencies/releaseRuntimeClasspath.txt` committed; CI runs `./gradlew dependencyGuard`; a failure is fixed locally with `./gradlew dependencyGuardBaseline` and reviewed, never regenerated automatically on `main`.
- [ ] Review the diff for: debug-only artifacts leaking into release (`ui-tooling`, `leakcanary`), two versions of the same library, and anything with `-alpha` the team did not choose.
- [ ] With `modules = true` the baseline also lists project modules, which doubles as a dependency-direction check (a feature module appearing under another feature is a bug).

```kotlin
// app/build.gradle.kts
plugins { id("com.dropbox.dependency-guard") }      // or via the application convention plugin
dependencyGuard {
    configuration("releaseRuntimeClasspath") {
        modules = true          // list project modules, not only external artifacts
        tree = false            // flat list diffs better than a tree
    }
}
```

## API surface checks

For library modules whose public API other teams or apps compile against (`:core:designsystem`, a published SDK), track the Kotlin API surface so an accidental `public` or a signature change shows up in review.

- [ ] Binary Compatibility Validator (`org.jetbrains.kotlinx.binary-compatibility-validator`, `<version>`, https://github.com/Kotlin/binary-compatibility-validator/releases) applied to published library modules only; it is noise on `:app` and feature modules.
- [ ] `api/<module>.api` files committed; `./gradlew apiCheck` in CI, `./gradlew apiDump` locally after an intentional change, and the dump reviewed like code.
- [ ] `nonPublicMarkers` set to the project's `@InternalApi` opt-in annotation so internal-but-public types are excluded.
- [ ] Explicit API mode (`kotlin { explicitApi() }`) on the same modules, so every declaration states its visibility and return type and a `public` cannot slip in by omission.
- [ ] Lint's own `checkDependencies = true` in the application module, so library lint issues surface in the app's report.

```kotlin
// core/designsystem/build.gradle.kts additions
plugins { id("org.jetbrains.kotlinx.binary-compatibility-validator") }
kotlin { explicitApi() }
apiValidation {
    nonPublicMarkers.add("com.example.app.core.designsystem.InternalDesignSystemApi")
}
```

## Pre-commit hook

- [ ] `templates/hooks/check-android-style.sh` installed as `.git/hooks/pre-commit` or through the team's hook manager; it greps for forbidden patterns (`GlobalScope`, `LiveData`, `Thread.sleep`, missing `android:exported`) in seconds. Call `./gradlew spotlessCheck -q` from the same hook; leave lint and tests to CI.
- [ ] The hook never auto-commits formatting changes; it fails and tells the developer to run `./gradlew spotlessApply`.

## Verify

```sh
./gradlew spotlessCheck
./gradlew :build-logic:convention:check          # if present
./gradlew dependencyGuard
./gradlew :lint:test :lint:lint
./gradlew :app:lintRelease                       # includes the custom detectors via lintPublish/lintChecks
./gradlew apiCheck                               # modules with the compatibility validator
```

All green locally before opening the PR; CI runs the same list in the same order. A check that only runs in CI is a check developers learn to ignore.

## Sources

- https://developer.android.com/studio/write/lint
- https://googlesamples.github.io/android-custom-lint-rules/
- https://developer.android.com/reference/tools/gradle-api/current/com/android/build/api/dsl/Lint
- https://github.com/diffplug/spotless
- https://pinterest.github.io/ktlint/
- https://detekt.dev/
- https://github.com/dropbox/dependency-guard
- https://github.com/Kotlin/binary-compatibility-validator
- https://kotlinlang.org/docs/whatsnew14.html#explicit-api-mode-for-library-authors
