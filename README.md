# Nexus backend

Backend for [Nexus Launcher](https://github.com/domsvoboda/nexus-launcher), based on [Xodus](https://github.com/xodus-gaming/xodus).
It provides Microsoft account integration, package downloads, content licensing and game launch services on Linux.

> [!CAUTION]
> Unofficial software, not affiliated with or endorsed by Microsoft or Xbox. Back up your game saves.

Install and manage the backend through Nexus Launcher. Linux x86_64 is supported; ARM64 is experimental.
The launcher supplies the sign-in interface. The backend's CLI and service keep their existing `xodus-cli` and `xodus-service` names and credential storage.

For source builds, tests, package contents and promotion, see [Building](docs/BUILD.md).
Backend interfaces and compatibility are documented in [API](docs/BACKEND.md).

Licensed under [GPL-3.0](LICENSE). Upstream and dependency notices are retained.
