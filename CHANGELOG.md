# Changelog

## [0.1.1](https://github.com/tunitz/healthvault/compare/v0.1.0...v0.1.1) (2026-11-26)


### Features

* **agent:** add nutrition target and supplement update tools ([6f39c52](https://github.com/tunitz/healthvault/commit/6f39c52ebe27211ca321044d633a7f08828ea610))
* **auth:** add password:set/verify scripts and make production docs bun-only ([5b9015e](https://github.com/tunitz/healthvault/commit/5b9015ef038e751419b13472a56d06f44240222a))
* **auth:** add single-user login, bearer tokens and route protection ([aedb7f8](https://github.com/tunitz/healthvault/commit/aedb7f8e9cf750bfbdd3d99d4b938969b0de6b74))
* **brand:** logo mark, favicon, apple/PWA icons, manifest; logo in nav ([adaca0d](https://github.com/tunitz/healthvault/commit/adaca0d2388097a0d45dc82653f66c628bcb5e91))
* complete UI/UX redesign, settings, MCP and data correctness ([c38819d](https://github.com/tunitz/healthvault/commit/c38819d52a2a781f0ac649123c7ec95d2e95ce5d))
* convert manual logging flows to shadcn dialogs ([36948ec](https://github.com/tunitz/healthvault/commit/36948ec2a693543b561a7a0a478d3c6a4850488e))
* default timezone to UTC with HEALTHVAULT_DEFAULT_TIMEZONE override ([2433bae](https://github.com/tunitz/healthvault/commit/2433bae3b5999f37852b0e0e940e4c5f6f0bd4e2))
* **docker:** add Alpine Docker deployment, GHCR CI, and Release Please ([#3](https://github.com/tunitz/healthvault/issues/3)) ([b3a5c56](https://github.com/tunitz/healthvault/commit/b3a5c563716a9e9e9628808695e5da978593b940))
* expand the agent surface to 27 tools with plugin parity ([18e7097](https://github.com/tunitz/healthvault/commit/18e70974898aaa8e176c5a5c6a5b983d557b121d))
* full audit fixes, performance optimizations, MCP parity, and fe… ([c1c229c](https://github.com/tunitz/healthvault/commit/c1c229c464c0d530e30b0bebc5afedce58ec9deb))
* full audit fixes, performance optimizations, MCP parity, and feature additions ([04b69f6](https://github.com/tunitz/healthvault/commit/04b69f6883e3d2d90d1e00ec6ac993dc95b3a444))
* land the UI/UX audit fixes and a working units preference ([861ed23](https://github.com/tunitz/healthvault/commit/861ed237d5913b2e4d88e6f47e46714c964b5dce))
* **mcp:** replace the OpenCode plugin with a multi-harness MCP server ([2142930](https://github.com/tunitz/healthvault/commit/2142930ec76b46e2f620cf799212a7496ce015aa))
* prepare public release with UTC default, README split, screenshots, and MIT release kit ([#5](https://github.com/tunitz/healthvault/issues/5)) ([529fca5](https://github.com/tunitz/healthvault/commit/529fca5e7dbfa95e3ae731464aaa0df4ebb0302b))
* profile, nutrition, supplements and agent API ([6b868e2](https://github.com/tunitz/healthvault/commit/6b868e272a2adab2077192c591472e7a7014ce48))
* **pwa:** service worker offline cache for all routes + offline pill ([f68e18d](https://github.com/tunitz/healthvault/commit/f68e18d4a1b3036b0c9c3ac1acd4ffa07609c626))
* Rust/GPUI Kit/WASM rewrite workspace with parity fixtures and gates ([93d3a48](https://github.com/tunitz/healthvault/commit/93d3a4826125b5ce8984e481c3f938d156e96678))
* training roadmap features and nutrition management UI ([7619bb5](https://github.com/tunitz/healthvault/commit/7619bb539931dc68b72c052110237d78a24c2775))
* **ui:** minimalist redesign with system/light/dark theme, mobile bottom nav, token-based charts ([9bde7d3](https://github.com/tunitz/healthvault/commit/9bde7d3ee73fdead68566b80521c03e6e9cc21d9))
* **ui:** round every number to 2dp, colour the dashboard, Sunday-start weeks with real hover ranges, clearer import flow ([6875042](https://github.com/tunitz/healthvault/commit/68750422701a73e8e21fdb1c54009a6a6ef2d8a3))


### Bug Fixes

* accept decimal values in manual weight logging ([b5b1833](https://github.com/tunitz/healthvault/commit/b5b1833d9fde00b3c9e1e92d2635947db697800d))
* **build:** run Next under Bun so host Node 20 cannot segfault ([32e8265](https://github.com/tunitz/healthvault/commit/32e8265aa9d24af28cd51aae751ad04d1268fe69))
* **data:** read WorkoutStatistics, honour durationUnit, stop summing steps across devices ([1d08363](https://github.com/tunitz/healthvault/commit/1d08363082caaf1d230697e996760efa8659edf8))
* **deploy:** allow loopback and LAN hosts in HealthVault unit ([335651d](https://github.com/tunitz/healthvault/commit/335651dadf8f9cafcc6c22dff6f827b6aa9a8b67))
* display weights to two decimal places without rounding ([3337f97](https://github.com/tunitz/healthvault/commit/3337f97878d46efcb2299c3df39b8bb5e47ae5c8))
* **dx:** fail fast with an actionable message when better-sqlite3 cannot load ([f286c1f](https://github.com/tunitz/healthvault/commit/f286c1f7f7a06ac17cff0d3761097b921ed05500))
* **ingest:** accept Apple's nested apple_health_export/export.xml layout ([94dacdf](https://github.com/tunitz/healthvault/commit/94dacdf2737e15f5188bc28c10545de8f10865b0))
* **nav:** taller bottom tabs, viewport-fit=cover so safe-area inset applies, 12px floor above home indicator ([7c62ae1](https://github.com/tunitz/healthvault/commit/7c62ae18bcfd34e19ac94f3ebfeaf4feeae833e1))
* require bun &gt;=1.4 (1.3.x panics on better-sqlite3), webpack dev fallback, isolate tests ([64973cb](https://github.com/tunitz/healthvault/commit/64973cbf744ae4f37e2893c9148413eeb0e451c5))
* **training:** unique device badges (duplicate React key), Sunday-start weeks with explicit range ([0099198](https://github.com/tunitz/healthvault/commit/00991982efe20e6b98d2ebdf139b2abef626aaed))
* **ui:** mobile workout tables fit 390px (short date, truncated activity) ([3dbfea7](https://github.com/tunitz/healthvault/commit/3dbfea7437908a8edaa2c1fb84e73882737c51f1))
* **ui:** mobile workout tables show 4 core columns, rest from md up (removes gap/overflow) ([4756e61](https://github.com/tunitz/healthvault/commit/4756e6159fd50569157e8014f649759f2036acfe))
* **upload:** stop the proxy body buffer truncating real exports ([9fe8904](https://github.com/tunitz/healthvault/commit/9fe8904708b69385be283266c158b50115e102d0))


### Performance Improvements

* **ingest:** move Export.zip ingest hot loop and XML parser to Rust ([0801270](https://github.com/tunitz/healthvault/commit/08012709b30d9bbcf3d859b6e1235ad53e1c1617))
* **ingest:** move Export.zip ingest hot loop and XML parser to Rust ([f07da38](https://github.com/tunitz/healthvault/commit/f07da38c1b9db8d418170625dd9d48f3e6fc910d))
* **ingest:** prepared statements + transactions (911k rows: 48s-&gt;35s, 1.4GB-&gt;830MB peak) ([643d4aa](https://github.com/tunitz/healthvault/commit/643d4aae4c7d785c59ed9b5805384e196e60a6dd))
