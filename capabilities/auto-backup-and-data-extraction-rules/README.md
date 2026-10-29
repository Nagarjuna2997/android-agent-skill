# Auto Backup and data extraction rules

Control what Android backs up to the user's Google account and what survives device-to-device transfer: `android:fullBackupContent` for API 24 to 30 and `android:dataExtractionRules` for API 31+, excluding tokens, Keystore-dependent files, caches and device-bound ids, a `BackupAgent`-free approach using `BackupManager` hooks only when needed, and `bmgr` commands to test restore locally.

## When to use

- Every app. Auto Backup is on by default (`android:allowBackup` defaults to true) and backs up DataStore, Room databases and files up to 25 MB per app. Without rules you may back up encrypted blobs whose Keystore key does not exist on the new device, session tokens that should not transfer, or caches that bloat the quota.
- Decide per file: user content (notes, settings) is backed up; credentials, device-specific ids and anything encrypted with a non-transferable key are excluded.
- If the app has no user data worth restoring and stores secrets, set `allowBackup="false"` and skip the rules.

## Dependencies

None. These are manifest and XML resources.

## Manifest and permissions

```xml
<application
    android:allowBackup="true"
    android:fullBackupContent="@xml/backup_rules"
    android:dataExtractionRules="@xml/data_extraction_rules"
    ...>
```

`fullBackupContent` is used on API 24 to 30; `dataExtractionRules` replaces it on API 31+ and additionally governs device-to-device transfer. Ship both while minSdk is below 31.

## Implementation

### Files and their fate

| Location | Example | Backup | Reason |
|---|---|---|---|
| `datastore/user_settings.preferences_pb` | theme, flags | yes | user intent, portable |
| `databases/app.db` | notes, cache of remote | yes for user data; no for pure remote caches | size and freshness |
| `files/session.enc` | token encrypted with a Keystore key | no | key does not exist on the new device; restore would be garbage |
| `files/device_id` | installation id | no | must be regenerated per device |
| `cache/` | image cache | excluded automatically | disposable |
| `no_backup/` | anything written via `context.noBackupFilesDir` | excluded automatically | explicit opt-out |

The simplest rule for secrets: write them under `noBackupFilesDir` and never reference them in the rules at all.

### API 31+ rules

`res/xml/data_extraction_rules.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <!-- Cloud backup to the user's Google account -->
    <cloud-backup disableIfNoEncryptionCapabilities="true">
        <include domain="file" path="." />
        <include domain="database" path="app.db" />
        <include domain="sharedpref" path="." />
        <exclude domain="file" path="session.enc" />
        <exclude domain="file" path="device_id" />
        <exclude domain="file" path="imports/" />
        <exclude domain="database" path="remote_cache.db" />
    </cloud-backup>

    <!-- Direct device-to-device transfer during setup; no size cap, no encryption requirement -->
    <device-transfer>
        <include domain="file" path="." />
        <include domain="database" path="app.db" />
        <include domain="sharedpref" path="." />
        <exclude domain="file" path="session.enc" />
        <exclude domain="file" path="device_id" />
    </device-transfer>
</data-extraction-rules>
```

`disableIfNoEncryptionCapabilities="true"` refuses cloud backup on devices that cannot encrypt the backup client-side; set it whenever the data is personal. Domains: `root`, `file` (`filesDir`), `database`, `sharedpref`, `external` (app-specific external storage), `device_file` and friends for device-protected storage. DataStore files live under `file` domain at `datastore/<name>.preferences_pb`.

### API 24 to 30 rules

`res/xml/backup_rules.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
    <include domain="file" path="." />
    <include domain="database" path="app.db" />
    <include domain="sharedpref" path="." />
    <exclude domain="file" path="session.enc" />
    <exclude domain="file" path="device_id" />
    <exclude domain="file" path="imports/" />
    <exclude domain="database" path="remote_cache.db" />
</full-backup-content>
```

Keep the two files in sync; lint has no check for drift, so a comment at the top of each pointing at the other helps.

### Writing secrets to the no-backup directory

```kotlin
package com.example.app.security

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import javax.inject.Inject

class SecretFiles @Inject constructor(@ApplicationContext private val context: Context) {
    val sessionFile: File get() = File(context.noBackupFilesDir, "session.enc")
    val deviceIdFile: File get() = File(context.noBackupFilesDir, "device_id")
}
```

With this, the explicit `exclude` lines for those two files are belt and braces; the directory is never backed up.

### Reacting to a restore

After a restore the app starts with user data but without secrets, so it must treat the state as signed-out and regenerate device ids. Detect it by comparing a stored installation marker against one in `noBackupFilesDir`:

```kotlin
class RestoreDetector @Inject constructor(
    @ApplicationContext private val context: Context,
    private val settings: SettingsRepository,
) {
    /** True on the first launch after a restore or transfer: backed-up marker exists, device-local one does not. */
    suspend fun wasRestored(): Boolean {
        val local = File(context.noBackupFilesDir, "install_marker")
        val backedUp = settings.settings.first().installMarker
        val restored = backedUp != null && !local.exists()
        if (!local.exists()) local.writeText(backedUp ?: java.util.UUID.randomUUID().toString().also { settings.setInstallMarker(it) })
        return restored
    }
}
```

On `true`, clear any cached session state in the database (rows referencing the old user are fine to keep if they are the user's own content) and route to sign-in. Use this instead of a `BackupAgent`; Auto Backup does not call agent hooks unless you implement one, and the detector covers the common need.

### Room databases with WAL

Room uses write-ahead logging; the `-wal` and `-shm` files are backed up with the `database` domain automatically when you include the database by name. Do not exclude them selectively.

## Verify

```sh
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
# Populate some data in the app, then:
adb shell bmgr enable true
adb shell bmgr transport com.android.localtransport/.LocalTransport     # API 31+: com.android.localtransport/.LocalTransport
adb shell bmgr backupnow com.example.app
adb shell bmgr list sets
adb shell pm clear com.example.app                                         # wipe app data
adb shell bmgr restore <token> com.example.app
adb shell run-as com.example.app ls -R files/ no_backup/ databases/ 2>/dev/null
```

After restore: `files/datastore/user_settings.preferences_pb` and `databases/app.db` exist; `no_backup/session.enc` does not. Launch the app and confirm `RestoreDetector.wasRestored()` returns true and the app asks to sign in while showing restored notes. Device-to-device transfer rules are tested the same way with `bmgr` on API 31+ using `--d2d` style flags where supported; otherwise record it as covered by the cloud-backup check only.

Unit test the detector with a fake settings repository and a temporary folder passed as `noBackupFilesDir` (wrap `File` access in an interface to inject it).

## Pitfalls

- Backing up a file encrypted with a Keystore key produces unreadable data after restore and often a crash on first read; keep such files in `noBackupFilesDir`.
- `allowBackup="false"` disables backup entirely, including device-to-device transfer on API 31+; users lose their data when switching phones. Prefer rules over the global switch.
- Only one of `fullBackupContent` and `dataExtractionRules` applies per OS version; a rule in one file but not the other silently changes behavior across devices.
- The 25 MB cloud quota is per app; a Room cache of remote images or large imports exceeds it and makes the whole backup fail. Exclude caches.
- Backups happen during idle charging on Wi-Fi roughly daily; a freshly written setting may not be in the last backup. Do not rely on backup for sync.
- `sharedpref` domain paths use the file name without `.xml` for includes but the system handles the extension; test rather than assume when excluding a single preferences file.
- Install-time restore runs before the app's first launch; code that assumes an empty data directory on first run must check for restored files.

## Sources

- https://developer.android.com/identity/data/autobackup
- https://developer.android.com/identity/data/backup
- https://developer.android.com/identity/data/testingbackup
- https://developer.android.com/guide/topics/data/keyvaluebackup
