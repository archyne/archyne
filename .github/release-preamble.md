## Downloads

| Platform | File                                                                  |
| -------- | --------------------------------------------------------------------- |
| Windows  | `Archyne-Setup-<version>.exe`                                         |
| macOS    | `Archyne-<version>-arm64.dmg` (Apple Silicon) or `-x64.dmg` (Intel)   |
| Linux    | `Archyne-<version>-x86_64.AppImage`, or `Archyne-<version>-amd64.deb` |

Or run it without installing anything:

```sh
npx archyne
```

The web version needs no download at all: <https://archyne.github.io/archyne/>

### These installers are not code-signed

Stated up front rather than discovered at the download prompt:

- **Windows** — SmartScreen will warn that the publisher is unknown. Choose
  _More info → Run anyway_.
- **macOS** — macOS will say it cannot verify the developer. Drag the app to
  Applications, then right-click it and choose _Open_; on macOS 15 and newer,
  approve it under _System Settings → Privacy & Security → Open Anyway_.
- **Linux** — no signing is involved; AppImage and `.deb` install normally.

Windows signing is applied for through SignPath Foundation, and macOS needs
an Apple Developer membership; the
[code signing policy](https://github.com/archyne/archyne/blob/main/CODE_SIGNING.md)
has the status. Until then, the honest options are the web version, `npx
archyne`, or accepting the warnings above.

**Code signing policy:** free code signing provided by
[SignPath.io](https://about.signpath.io), certificate by
[SignPath Foundation](https://signpath.org) —
[what is signed, who approves it, and the privacy policy](https://github.com/archyne/archyne/blob/main/CODE_SIGNING.md).

Everything runs locally either way — no server, no accounts, and no network
requests of Archyne's own. See the
[security policy](https://github.com/archyne/archyne/blob/main/SECURITY.md)
for the threat model.

<!-- Absolute, not relative. This file is pasted into a GitHub Release body,
     where a relative link resolves against the release page rather than the
     repository root — `../blob/main/SECURITY.md` became a 404 under
     /releases/. Nothing here can assume it is being read from its own
     directory. -->

---
