# Chromium sandbox seccomp profile

`chromium-seccomp.json` is copied from Microsoft Playwright:
https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json

Retrieved 2026-10-12. Playwright is licensed under Apache License 2.0; see `LICENSE.playwright`.
This profile is used with non-root Chromium and no-new-privileges. It permits the namespace operations needed by the browser sandbox; it is not a replacement for a per-session VM security boundary.

Local modification: allow the `chroot` syscall independently of the host capability filter. Chromium needs it inside its own user namespace after the container drops all host capabilities. Linux still checks the capability in the applicable user namespace; this does not grant a host capability or disable the browser sandbox.
