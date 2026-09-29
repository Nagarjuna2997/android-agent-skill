# Benchmark protocol

`npm run benchmark` validates five synthetic broken/repaired analyzer fixture pairs and records timing and hashes. This is not a scored agent comparison and cannot establish that an agent is better with this package.

A future WITH/WITHOUT trial must pin agent client, model, toolchain, fixture hashes, worker count and cache policy. Give each arm an isolated workspace with identical tool access, expose this package only to the WITH arm, keep evaluator assertions outside both workspaces, and evaluate after each agent has stopped. Record success/failure, duration, tool calls, build/test results and hashed evidence. Record unavailable devices/providers as unavailable, never successful or zero-duration results.

Pending end-to-end scenarios: Gradle diagnosis, Compose build repair, emulator launch, app install, UI navigation, capture, accessibility, Firebase configuration, unsafe rules, startup crash, Play report, dependency resolution, recomposition, unit tests and instrumentation. Actual device trials and paid model comparisons have not been run.
