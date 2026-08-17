# Third-party notices

Runtime dependencies are installed from npm and are not vendored in this
source repository. `package-lock.json` pins the dependency graph and integrity
hashes used by the current release.

| Package | Version | License | Source |
| --- | ---: | --- | --- |
| `@resvg/resvg-js` and its platform-specific optional binary packages | 2.6.2 | MPL-2.0 | [yisibl/resvg-js](https://github.com/yisibl/resvg-js) |
| `mathjax` | 4.1.3 | Apache-2.0 | [mathjax/MathJax](https://github.com/mathjax/MathJax) |
| `@mathjax/mathjax-newcm-font` | 4.1.3 | Apache-2.0 | [mathjax/MathJax-fonts](https://github.com/mathjax/MathJax-fonts) |
| `nanum-gothic-coding` | 4.0.0 | OFL-1.1 | [emersion/nanum-gothic-coding](https://github.com/emersion/nanum-gothic-coding) |
| `ws` | 8.21.1 | MIT | [websockets/ws](https://github.com/websockets/ws) |

The resvg optional packages cover Android, macOS, Linux GNU/musl, and Windows
architectures listed in the lockfile; npm installs only the package applicable
to the target platform. Some platform and font packages rely on the parent or
upstream project for their license text rather than carrying a separate copy.

When redistributing a container, executable bundle, or copied dependency tree,
include the applicable parent/upstream license texts and notices and comply with the MPL-2.0,
Apache-2.0, OFL-1.1, and MIT terms. In particular, review MPL source-availability
obligations for modified covered files and preserve the font license notices.
This notice is an inventory, not a substitute for the license texts.
