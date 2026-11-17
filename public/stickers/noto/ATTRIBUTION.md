# Animated Noto Emoji

The sticker images in this folder are adapted from Google's [Animated Noto Emoji](https://googlefonts.github.io/noto-emoji-animation/), licensed under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).

AI WebChat resizes and recompresses the official WebP files for web display. The `-still.webp` files are single frames for reduced-motion preferences. The original image locations and SHA-256 digests are recorded in `src/lib/noto-stickers.json`. From the project root, `node scripts/sync-noto-stickers.mjs` can rebuild this pack after dependencies are installed.
