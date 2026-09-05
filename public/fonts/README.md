# Self-hosted fonts

The design uses two web fonts. They are **not** loaded from the Google
Fonts CDN — the app is offline-first (`specs/roadmap.md`: no cloud calls),
so the font files are served from here instead.

Drop these `.woff2` files into this folder:

| File | Family | Weights used |
|---|---|---|
| `newsreader-400.woff2` | Newsreader | 400 (headings, blockquotes) |
| `newsreader-500.woff2` | Newsreader | 500 (headings) |
| `ibm-plex-mono-400.woff2` | IBM Plex Mono | 400 (meta line, tag chips) |
| `ibm-plex-mono-500.woff2` | IBM Plex Mono | 500 |

Then add to `src/styles.css` (top of the file):

```css
@font-face {
  font-family: 'Newsreader';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/newsreader-400.woff2') format('woff2');
}
@font-face {
  font-family: 'Newsreader';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/newsreader-500.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url('/fonts/ibm-plex-mono-400.woff2') format('woff2');
}
@font-face {
  font-family: 'IBM Plex Mono';
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url('/fonts/ibm-plex-mono-500.woff2') format('woff2');
}
```

`public/**/*` is copied to the build output root (see `angular.json`
assets), so `/fonts/...` resolves in both `ng serve` and the packaged
app. Until the files are present the token fallbacks (`Georgia`,
platform monospace) apply — the layout is designed to tolerate that.
