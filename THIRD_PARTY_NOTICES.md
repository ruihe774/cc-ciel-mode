# Third-party notices

This project's own code is released under the [Unlicense](LICENSE). It bundles the following third-party software, which is licensed separately.

## cel-js

- Source: https://github.com/marcbachmann/cel-js (npm `@marcbachmann/cel-js`)
- Version: 8.0.0
- Location: `hooks/vendor/cel/`
- License: MIT

`cel.js` is a build output, not a copy of the source: the package's 18 modules bundled into one file, because the mod loader rejects their circular imports. It was built with

```
bun build node_modules/@marcbachmann/cel-js/lib/index.js --format=esm --target=browser --outfile=hooks/vendor/cel/cel.js
```

The `.d.ts` files are the package's own type declarations, copied as they are, with `cel.d.ts` re-exporting `index.d.ts`.

```
MIT License

Copyright (c) 2025 Marc Bachmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
