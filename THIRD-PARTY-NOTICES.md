# Third-party notices

`ragekit` bundles the following third-party software into its
distributed files. Their licences are reproduced below, as those licences
require of any copy that carries the code.

Everything else in `dist/` is ragekit's own, under the MIT licence in
`LICENSE`.

---

## html-to-image

Bundled into the lazily-imported page-capture chunk. It is inlined rather than
left as a bare import so `dist/` works when loaded straight from a CDN or a file
server, with no bundler to resolve the specifier — see `deps.alwaysBundle` in
`tsdown.config.ts`.

- Source: https://github.com/bubkoo/html-to-image

```
MIT License

Copyright (c) 2017-2025 W.Y.

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
