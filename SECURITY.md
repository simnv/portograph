# Security policy

## Supported versions

Only the latest minor release gets security fixes. For example, when 0.2 is the latest, 0.2.x
gets fixes and 0.1.x does not.

## Report a vulnerability

Do not open a public issue for a vulnerability. Report it through GitHub private vulnerability
reporting:

1. Open the [Security tab](https://github.com/simnv/portograph/security) of the repository.
2. Click **Report a vulnerability**.
3. Give the portograph version, the input that causes the problem, the command or the library
   call, and what happens.

You get a reply in the advisory. When a fix is ready, a release contains it, and the advisory
names the fixed version.

portograph reads YAML and writes SVG and draw.io files. A problem in one of these areas is in
scope:

- An input file that makes the CLI or the library read or write a file that the command did not
  name.
- An input file that puts active content, for example a script, into the SVG or the draw.io
  file.
- A small input file that makes the CLI run past its 120-second deadline or use all the memory.
