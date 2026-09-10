#!/bin/zsh
cd /tmp/elk-proto
for v in "$@"; do
  node build.mjs $v && node avoid.mjs $v all && node render.mjs $v-av && node render.mjs $v && \
  for w in $v $v-av; do "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=2000,1400 --screenshot=/tmp/elk-proto/out-$w.png file:///tmp/elk-proto/out-$w.html 2>/dev/null; done
done
node metrics.mjs $(for v in "$@"; do echo $v $v-av; done)
