# Legacy console

`swing_terminal_4-1.html` is the original single-file console, **preserved
untouched** as a backup. It is shipped in the GitHub Pages bundle and reachable
at:

  https://goofyclub.github.io/swing-stocks/legacy/swing_terminal_4-1.html

This file is **not** edited by the new SPA. The strategy engine that the SPA
uses is an exact (line-for-line) copy of the engine block in this file, lifted
out to `/src/strategy/engine.js`. The parity self-test
(`npm run test:engine`) confirms the extraction was zero-impact.

Do not modify this file. If a strategy needs to evolve, edit
`/src/strategy/engine.js` and update the test snapshot.
