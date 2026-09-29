# CLI and MCP inventory

Generated from the shared operation registry. Each CLI parameter is a named flag; camelCase becomes kebab-case. Common flags appear in `android-agent --help`. The MCP name is the same operation with the listed schema. MCP excludes confirmation issuance, model configuration writes and init.

| CLI | MCP | Parameters | Changes state |
|---|---|---|---|
| `inspect` | `android_project_inspect` | — | no |
| `doctor` | `android_doctor` | — | no |
| `capabilities` | `android_capabilities` | — | no |
| `build` | `android_project_build` | variant, module | yes |
| `clean` | `android_project_clean` | variant, module | yes (confirmation) |
| `lint` | `android_project_lint` | variant, module | yes |
| `test` | `android_project_test` | variant, module | yes |
| `test unit` | `android_test_unit` | variant, module | yes |
| `test instrumented` | `android_test_instrumented` | variant, module | yes |
| `test compose` | `android_test_compose` | variant, module | yes |
| `gradle inspect` | `android_gradle_inspect` | — | no |
| `gradle diagnose` | `android_gradle_diagnose` | module | yes |
| `gradle dependencies` | `android_gradle_dependencies` | module | yes |
| `gradle versions` | `android_gradle_versions` | — | no |
| `compose audit` | `android_compose_audit` | platform | no |
| `firebase audit` | `android_firebase_audit` | platform | no |
| `play validate` | `android_play_validate` | platform | no |
| `accessibility audit` | `android_accessibility_audit` | platform | no |
| `performance analyze` | `android_performance_analyze` | platform | no |
| `security audit` | `android_security_audit` | platform | no |
| `privacy audit` | `android_privacy_audit` | platform | no |
| `permissions audit` | `android_permissions_audit` | platform | no |
| `analyze` | `android_analyze` | platform | no |
| `firebase inspect` | `android_firebase_inspect` | — | no |
| `google-cloud inspect` | `android_google-cloud_inspect` | — | no |
| `devices list` | `android_device_list` | — | no |
| `devices info` | `android_devices_info` | — | no |
| `device install` | `android_app_install` | file | yes |
| `device uninstall` | `android_device_uninstall` | package | yes (confirmation) |
| `device launch` | `android_app_launch` | package | yes |
| `device stop` | `android_device_stop` | package | yes |
| `device tap` | `android_device_tap` | x, y | yes |
| `device swipe` | `android_device_swipe` | x, y, x2, y2, duration | yes |
| `device type` | `android_device_type` | text | yes |
| `device back` | `android_device_back` | — | yes |
| `device home` | `android_device_home` | — | yes |
| `device rotate` | `android_device_rotate` | rotation | yes |
| `device screenshot` | `android_device_screenshot` | output | yes |
| `device record` | `android_device_record` | output, duration | yes |
| `device logs` | `android_device_logs` | lines | no |
| `screenshot` | `android_screenshot` | output | yes |
| `logs` | `android_logs` | lines | no |
| `run` | `android_run` | package | yes |
| `ui inspect` | `android_ui_inspect` | — | yes |
| `ui tap` | `android_ui_tap` | text, resourceId | yes |
| `ui type` | `android_ui_type` | text | yes |
| `ui swipe` | `android_ui_swipe` | x, y, x2, y2, duration | yes |
| `ui activity` | `android_ui_activity` | — | no |
| `emulator list` | `android_emulator_list` | — | no |
| `emulator profiles` | `android_emulator_profiles` | — | no |
| `emulator stop` | `android_emulator_stop` | — | yes |
| `emulator boot-wait` | `android_emulator_boot-wait` | — | no |
| `emulator launch` | `android_emulator_launch` | name, headless | yes |
| `emulator wipe` | `android_emulator_wipe` | name, headless | yes (confirmation) |
| `emulator create` | `android_emulator_create` | name, image, profile | yes |
| `emulator snapshot` | `android_emulator_snapshot` | operation, name | yes (confirmation) |
| `crash analyze` | `android_crash_analyze` | file | no |
| `performance capture` | `android_performance_capture` | package | no |
| `accessibility runtime` | `android_accessibility_runtime` | — | yes |
| `docs search` | `android_docs_search` | query, refresh | no |
| `screenshots capture` | `android_screenshots_capture` | output | yes |
| `screenshots generate` | `android_screenshots_generate` | file, template, output | yes |
| `screenshots frame` | `android_screenshots_frame` | file, template, output | yes |
| `screenshots validate` | `android_screenshots_validate` | file | no |
| `screenshots export` | `android_screenshots_export` | files, output | yes |
| `screenshots localize` | `android_screenshots_localize` | file, template, output | yes |
| `init` | `android_init` | — | yes |
| `config show` | `android_config_show` | — | no |
| `models list` | `android_models_list` | — | no |
| `models current` | `android_models_current` | — | no |
| `models set` | `android_models_set` | provider, model | yes |
| `agent analyze` | `android_agent_analyze` | prompt, provider, model | yes |
| `confirm` | `android_confirm` | fingerprint | yes |
| `confirmations list` | `android_confirmations_list` | — | no |
| `confirmations reset` | `android_confirmations_reset` | — | yes |
| `dependencies sbom` | `android_dependencies_sbom` | — | no |

Additional CLI-only commands: `mcp [--allow-mutations]`, `runs create --file PLAN`, `runs list`, `runs show --id UUID`, `runs resume --id UUID`. Provider streaming, multimodal and tool-call request support is available through the programmatic adapter; the CLI analysis command sends a project summary.
