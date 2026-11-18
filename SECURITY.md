# Security policy

## Supported versions

Only the latest published minor version of the npm package `wallhammer-web` gets security fixes. While the engine is at 0.x, a fix ships as a new release of that minor version or of the next one. Older versions are not patched.

| Version | Supported |
| --- | --- |
| Latest published 0.x minor | Yes |
| Older versions | No |

## Reporting a vulnerability

Do not open a public issue for a vulnerability.

Report it privately through GitHub: open the repository, go to the **Security** tab and choose **Report a vulnerability**. The report is visible only to you and the maintainer until an advisory is published.

Please include:

- the version of `wallhammer-web` and the entry you import (for example `wallhammer-web/world`);
- what an attacker can do and under which conditions;
- steps or a minimal piece of code that reproduce it;
- the browser, operating system and GPU, or the Node version, if they matter;
- a suggested fix, if you have one.

## What to expect

The project has a single maintainer, and handling is best effort. There is no guaranteed response time.

- You should get an acknowledgement within a few days.
- If the report is confirmed, the fix is prepared in a private advisory and published together with a new release.
- You are credited in the advisory unless you ask not to be.
- If the report is not accepted, you get a short explanation.

## Scope

The engine runs in the browser, and parts of it in plain Node. It loads no images; all graphics come from code. It has one runtime dependency, `earcut`. It reads only data an app hands to it, for example cell files through `fetchBytes` and `FileCellProvider`, or worker scripts from a URL the app gives.

In scope: the published package, that is the code in `packages/wallhammer-web`.

Out of scope for advisories: the dev tooling (`tools/`, the Docker setup, the workflows) and the example pages (`examples/`). Reports about them are still welcome, through the same private form or, if the problem is not sensitive, a normal issue.
