# Noto Emoji reactions

Google's [Noto Emoji 2D illustrations](https://github.com/googlefonts/noto-emoji/tree/99701e07d3d1fe1bdbcdb14964547f0fd592966f/2D/svg) are used under the [Apache License 2.0](LICENSE.txt). Copyright Google LLC and the Noto Emoji contributors.

AI WebChat selects and labels the images and converts the source SVG artwork to compact 112-pixel WebP files. The [reaction manifest](../../../src/lib/noto-reactions.json) records the source Unicode code point for each local image. Run `node scripts/sync-noto-reactions.mjs` from the project root after installing project dependencies to rebuild the assets from the pinned upstream revision.
