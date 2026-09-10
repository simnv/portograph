#!/bin/zsh
cd /tmp/elk-proto
for v in "$@"; do
  node build.mjs $v && node render.mjs $v && \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=2000,1400 --screenshot=/tmp/elk-proto/out-$v.png file:///tmp/elk-proto/out-$v.html 2>/dev/null | grep -v '^$' ; ls -la out-$v.png | awk '{print $5, $9}'
done
node metrics.mjs "$@"
