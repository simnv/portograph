# Sweep fixtures

72 synthetic sheets (`v<switches>-<pattern>-<variant>.yaml`: five to seven access switches, six
link patterns, four transit variants each) from the ranked-groups work: two sources over an access
tier over two edge groups, with links that skip the access tier. `npm run sweep` lays each one out and reports how many lose a link to stage 8
(`removedLinks`); fewer is better. No test reads them; see `docs/agents/gates.md`.
