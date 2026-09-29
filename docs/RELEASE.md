# Release procedure

1. Run `npm ci`, `npm run check`, `npm run benchmark`, `npm run package:test` and `npm audit --omit=dev --audit-level=high`.
2. Review `npm pack --dry-run` contents. No credentials, screenshots, run-state or source fixtures should be in the npm tarball.
3. Run SDK-backed acceptance tests and record actual device/environment evidence. Validate Node/platform CI.
4. Review version, README claims, CHANGELOG, repository URL and license.
5. Source publication to GitHub and npm publication are separate actions. The initial repository push does not publish npm.
6. With maintainer authorization/authentication, publish the reviewed tarball using npm, then create the corresponding GitHub tag/release. Do not claim either succeeded without registry/release evidence.

`release.yml` is manual and only produces reviewable package artifacts. It does not silently publish anything.

The documentation site can be served with `python3 -m http.server 8765 --directory site`. The source is static and deployable to GitHub Pages. No hosted URL is implied until a successful Pages deployment is verified.
