# Sisal brand assets

Logo variants derived from [`../sisal.png`](../sisal.png), for use on a website,
GitHub Pages, READMEs, and link previews.

The mark is the same agave + woven-mat in every file; only the wordmark colour
changes between light and dark. The mark's own colours read on both light and
dark surfaces, so only the `sisal` wordmark needs the two variants.

## Palette

| Token        | Hex       | Use                       |
| ------------ | --------- | ------------------------- |
| Ink          | `#0E0E0F` | background, dark wordmark |
| Sage         | `#90956A` | agave (light leaves)      |
| Olive        | `#5F6B49` | agave (deep leaves)       |
| Raffia       | `#B9A885` | woven mat, accents        |
| Raffia light | `#C2AA7E` | woven mat highlight       |
| Paper        | `#E8E7DC` | wordmark on dark          |

## Files

```text
mark.png                    Agave + woven mat, transparent (the icon/master)
wordmark-dark.png           "sisal" in paper white  — for dark backgrounds
wordmark-light.png          "sisal" in ink          — for light backgrounds
logo-horizontal-dark.png    Mark + wordmark, side by side, for dark backgrounds
logo-horizontal-light.png   Mark + wordmark, side by side, for light backgrounds
logo-stacked-dark.png       Mark over wordmark, for dark backgrounds
logo-stacked-light.png      Mark over wordmark, for light backgrounds
og-image.png                1280×640 social / Open Graph preview
favicon/                    Favicon, PWA, and apple-touch icons + manifest
```

## Usage

### README logo that follows the reader's theme

```html
<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="./assets/brand/logo-horizontal-dark.png"
  >
  <img alt="Sisal" src="./assets/brand/logo-horizontal-light.png" width="360">
</picture>
```

### Favicons and icons (`<head>`)

```html
<link rel="icon" href="/assets/brand/favicon/favicon.ico" sizes="any">
<link
  rel="icon"
  type="image/png"
  sizes="32x32"
  href="/assets/brand/favicon/icon-32.png"
>
<link
  rel="icon"
  type="image/png"
  sizes="16x16"
  href="/assets/brand/favicon/icon-16.png"
>
<link rel="apple-touch-icon" href="/assets/brand/favicon/apple-touch-icon.png">
<link rel="manifest" href="/assets/brand/favicon/site.webmanifest">
<meta name="theme-color" content="#0E0E0F">
```

### Social / link preview (`<head>`)

```html
<meta
  property="og:image"
  content="https://<your-pages-url>/assets/brand/og-image.png"
>
<meta name="twitter:card" content="summary_large_image">
```

For the GitHub repo's own link unfurl, upload `og-image.png` under **Settings →
General → Social preview**.
