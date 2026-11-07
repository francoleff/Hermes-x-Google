#!/bin/sh
# usage: grid.sh out.png f1 ... f9 (3x3 at 960x540)
out=$1; shift; args=""; n=0; fil=""
for f in "$@"; do args="$args -i $f"; fil="$fil[$n]scale=960:540[v$n];"; n=$((n+1)); done
lay="0_0|w0_0|w0+w1_0|0_h0|w0_h0|w0+w1_h0|0_h0+h1|w0_h0+h1|w0+w1_h0+h1"
ins=""; i=0; while [ $i -lt $n ]; do ins="$ins[v$i]"; i=$((i+1)); done
lay=$(echo $lay | cut -d'|' -f1-$n)
ffmpeg -hide_banner -loglevel error -y $args -filter_complex "${fil}${ins}xstack=inputs=$n:layout=$lay:fill=black" $out
