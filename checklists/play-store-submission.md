# Play Store Submission Checklist

Preparation for a Google Play release. Passing every item here means the build is ready to upload and the listing is complete; it does not mean Google will approve it. Policy review, app review and the pre-launch report happen after upload, and the targeting requirements below change yearly (`data/versions.json` carries the current policy, verified 2026-09-29).

## Target SDK and build

- [ ] `targetSdk = 36` for phone, tablet and foldable (required for new apps and updates from 2026-08-31). Wear and Automotive: 35. TV and XR: 34. Play rejects uploads below the floor.
- [ ] `compileSdk = 37` (Android 17) so the latest APIs and lint checks are available; compileSdk may be higher than targetSdk, never lower.
- [ ] Build with AGP 9.4.0 / Gradle 9.6.0 / JDK 17; older AGP versions cannot emit the required bundle metadata for the current Play requirements.
- [ ] Upload an Android App Bundle (`.aab`), not an APK. Play has required bundles for new apps since 2021.

```sh
./gradlew :app:bundleRelease
# output: app/build/outputs/bundle/release/app-release.aab
```

- [ ] 16 KB page size support: every native library (`.so`) in the bundle, including those pulled in by SDKs, is aligned for 16 KB pages. Required for apps targeting Android 15+ on 64-bit devices since 2025-11-01. Check with the alignment script or `zipalign -c -P 16 -v 4 app.apk` on a universal APK extracted from the bundle; the Play Console also flags unaligned libraries at upload.
- [ ] `versionCode` is higher than every previously uploaded build on every track; the Console rejects a reused code.
- [ ] R8 enabled with `isMinifyEnabled = true` and `isShrinkResources = true` for release; mapping file uploaded for readable crash reports (the Gradle Play publisher or manual upload under App bundle explorer).
- [ ] `android:debuggable` is not set on the release manifest; `BuildConfig.DEBUG` is false; no debug logging interceptor in the release classpath.

## Signing

- [ ] Enrolled in Play App Signing. Google holds the app signing key; you keep the upload key. Losing the upload key is recoverable through the Console; losing a self-managed app signing key is not.
- [ ] Upload keystore stored outside version control; CI reads it from a secret and writes it to a temp file. See [release.md](release.md).
- [ ] The uploaded bundle is signed with the registered upload key, otherwise the Console rejects it with a certificate fingerprint mismatch.

```kotlin
// app/build.gradle.kts
signingConfigs {
    create("upload") {
        storeFile = file(System.getenv("UPLOAD_KEYSTORE_PATH") ?: "none")
        storePassword = System.getenv("UPLOAD_KEYSTORE_PASSWORD")
        keyAlias = System.getenv("UPLOAD_KEY_ALIAS")
        keyPassword = System.getenv("UPLOAD_KEY_PASSWORD")
    }
}
buildTypes { release { signingConfig = signingConfigs.getByName("upload") } }
```

## Permissions and declarations

- [ ] Every `<uses-permission>` in the merged manifest is used by a feature the user can see; run `./gradlew :app:assembleRelease` and inspect `app/build/intermediates/merged_manifests/release/AndroidManifest.xml`, because SDKs add permissions you did not write.
- [ ] Foreground services declare a type in the manifest (`android:foregroundServiceType`) and the matching `FOREGROUND_SERVICE_<TYPE>` permission; the Console asks for a video demonstrating the use case for several types.
- [ ] No `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` unless the app is a gallery, editor or similar with broad media needs; otherwise use the Photo Picker (`PickVisualMedia`) which needs no permission. Play's photo and video permissions policy requires a declaration and rejects incidental use.
- [ ] `MANAGE_EXTERNAL_STORAGE`, `QUERY_ALL_PACKAGES`, accessibility services, SMS and call log permissions each have a policy declaration form in the Console; complete it or remove the permission.
- [ ] `android:exported` is explicit on every Activity, Service, Receiver and Provider; required since targetSdk 31 and the bundle fails to install otherwise.
- [ ] Location: if background location is requested, the in-app disclosure and the Console declaration are done; prefer foreground-only.
- [ ] `POST_NOTIFICATIONS` requested at runtime with a rationale, not at first launch.

## Data safety and privacy

- [ ] Data safety form completed in the Console: every data type collected or shared (including by SDKs such as crash reporting and analytics), its purpose, whether it is optional, and whether it is encrypted in transit. SDK vendors publish their data safety sections; copy from them.
- [ ] Privacy policy URL set in the Console and reachable without login; it names the data types from the Data safety form. Required for all apps.
- [ ] Account deletion: if the app lets users create an account, there is an in-app deletion path and a web URL for deletion requests, both entered in the Console.
- [ ] Ads: declared yes/no correctly; if yes, the ads SDK and the `AD_ID` permission are consistent with the declaration.
- [ ] Target audience and content: age groups declared; if the app may appeal to children, the Families policy applies (no behavioral ads, certified SDKs).
- [ ] Health, financial or government-ID data: the additional declarations are complete.

## Listing

- [ ] App name (30 characters), short description (80), full description (4000); no keyword stuffing, no "best" or "#1" claims, no mention of other platforms' brands.
- [ ] Icon 512 x 512 PNG, 32-bit with alpha, matching the adaptive icon in the app.
- [ ] Feature graphic 1024 x 500 PNG or JPEG.
- [ ] Phone screenshots: at least 2, 16:9 or 9:16, each side between 320 and 3840 px. Tablet screenshots (7 inch and 10 inch) if the app targets tablets; Play shows a quality warning and lowers large-screen ranking without them.
- [ ] Screenshots show the actual app UI; no device frames that misrepresent the device, no text that promises features the app lacks.
- [ ] Content rating questionnaire completed (IARC); an unrated app is removed.
- [ ] Category, tags, contact email and (optionally) website set.
- [ ] Store listing in every language the app ships; untranslated listings default to the primary language.

## Testing and pre-launch

- [ ] Internal testing track used first: upload, install from the Play link on a real device, sign in, exercise the main flows. This catches signing, bundle splitting and config-split issues that a local APK never shows.
- [ ] Pre-launch report reviewed (Console > Testing > Pre-launch report): crashes, ANRs, accessibility findings, security warnings (such as insecure TrustManager or WebView usage) and screenshots across devices. Fix crashes and security warnings before production; the report is advisory but reviewers read it.
- [ ] Android vitals thresholds: crash rate under 1.09 percent of daily users and ANR rate under 0.47 percent, or the app loses visibility.
- [ ] New developer accounts: Play requires a closed test with at least 12 testers for 14 continuous days before production access for personal accounts created after late 2023.
- [ ] Tested on the smallest supported `minSdk` device or emulator and on the newest; tested with the release build (R8 can break reflection-based SDKs that worked in debug).

## Release tracks and rollout

- [ ] Track chosen deliberately: internal (up to 100 testers, instant), closed (invited groups), open (anyone, listed), production.
- [ ] Release notes written for the production release (500 characters per language); they appear in the store listing.
- [ ] Staged rollout for production starting at 5 to 20 percent, with a rule for when to expand and when to halt (see [release.md](release.md)).
- [ ] Countries and regions selected; pricing and in-app products (Play Billing 9.0.0) are active in those regions.
- [ ] The app is set to the correct distribution options: Wear OS, Android TV, Automotive and ChromeOS each need their own form factor review if you opt in.
- [ ] Managed publishing enabled if the release must go live at a specific time; otherwise a reviewed release publishes immediately.

## Common rejection causes

- [ ] Login credentials for reviewers provided under App access if any content is behind a sign-in; "the reviewer could not get past login" is a routine rejection.
- [ ] No references to competing stores, sideloading or payment methods that bypass Play Billing for digital goods.
- [ ] Deceptive behavior: the app does what the listing says, permission prompts explain their purpose, no hidden background data collection.
- [ ] Intellectual property: no third-party trademarks or copyrighted assets without rights.
- [ ] Metadata matches the app: the content rating questionnaire answers, the Data safety form and the actual behavior all agree.

## Verify

```sh
./gradlew :app:bundleRelease
./gradlew :app:lintRelease                  # catches exported, permissions and targetSdk issues
# Inspect merged manifest permissions:
grep -o 'uses-permission[^/]*' app/build/intermediates/merged_manifests/release/AndroidManifest.xml
# Install the bundle as the Play Store would, on a connected device:
bundletool build-apks --bundle=app/build/outputs/bundle/release/app-release.aab --output=/tmp/app.apks --connected-device
bundletool install-apks --apks=/tmp/app.apks
```

These checks prepare the submission. Approval is decided by Google Play review after upload.

## Sources

- https://developer.android.com/google/play/requirements/target-sdk
- https://developer.android.com/guide/app-bundle
- https://developer.android.com/guide/practices/page-sizes
- https://support.google.com/googleplay/android-developer/answer/9842756 (Play App Signing)
- https://support.google.com/googleplay/android-developer/answer/10787469 (Data safety)
- https://support.google.com/googleplay/android-developer/answer/9888170 (Permissions declarations)
- https://support.google.com/googleplay/android-developer/answer/9859455 (Pre-launch report)
- https://support.google.com/googleplay/android-developer/answer/9866151 (Store listing assets)
- https://developer.android.com/distribute/best-practices/launch/launch-checklist
- https://developer.android.com/about/versions/17
