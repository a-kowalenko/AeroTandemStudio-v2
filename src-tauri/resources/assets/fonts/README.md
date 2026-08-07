# Bundled fonts (Linux Intro)

`DejaVuSans.ttf` is used on Linux for FFmpeg `drawtext` via `fontfile=` so Intro
text (including umlauts) works without relying on fontconfig font names.

License: [Bitstream Vera / DejaVu](https://dejavu-fonts.github.io/) (free for
redistribution). Windows and macOS keep system font names (`font=`).
