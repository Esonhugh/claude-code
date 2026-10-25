#!/usr/bin/env bash
# Synthesizes the music bed and sound effects with ffmpeg (no third-party samples).
set -euo pipefail
out="$(dirname "$0")/../public/audio"
mkdir -p "$out"
ff() { ffmpeg -v error -y "$@"; }

# Chord per 4 s bar group: Am F C G. k = chord index.
K='mod(floor(t/4),4)'
root="if(eq($K,0),55,if(eq($K,1),43.65,if(eq($K,2),65.41,49)))"
p1="if(eq($K,0),220,if(eq($K,1),174.61,if(eq($K,2),261.63,196)))"
p2="if(eq($K,0),261.63,if(eq($K,1),220,if(eq($K,2),329.63,246.94)))"
p3="if(eq($K,0),329.63,if(eq($K,1),261.63,if(eq($K,2),392,293.66)))"
DROP=2
LEN=58

ff -f lavfi -i "aevalsrc='gte(t,$DROP)*0.9*sin(2*PI*(45*mod(t,0.5)+4.8*(1-exp(-25*mod(t,0.5)))))*exp(-6*mod(t,0.5))':s=44100:d=$LEN" "$out/_kick.wav"
ff -f lavfi -i "aevalsrc='gte(t,$DROP)*0.35*sin(2*PI*$root*2*t)*exp(-7*mod(t,0.25))':s=44100:d=$LEN" "$out/_bass.wav"
ff -f lavfi -i "aevalsrc='(0.06+0.02*sin(2*PI*0.5*t))*(sin(2*PI*$p1*t)+sin(2*PI*$p2*t)+sin(2*PI*$p3*t)+0.5*sin(2*PI*$p1*1.003*t))':s=44100:d=$LEN" -af "lowpass=f=1800" "$out/_pad.wav"
ff -f lavfi -i "aevalsrc='gte(t,$DROP)*0.25*(random(0)*2-1)*exp(-60*mod(t-0.25,0.5))':s=44100:d=$LEN" -af "highpass=f=6000" "$out/_hat.wav"
ff -i "$out/_kick.wav" -i "$out/_bass.wav" -i "$out/_pad.wav" -i "$out/_hat.wav" \
  -filter_complex "amix=inputs=4:normalize=0,afade=t=in:d=1.5,afade=t=out:st=$((LEN-4)):d=4,loudnorm=I=-18:TP=-2" -ar 44100 "$out/music.wav"
rm "$out"/_*.wav

ff -f lavfi -i "aevalsrc='0.8*(random(0)*2-1)*pow(sin(PI*t/0.55),2)':s=44100:d=0.55" -af "highpass=f=400,lowpass=f=5000" "$out/whoosh.wav"
ff -f lavfi -i "aevalsrc='sin(2*PI*(40*t+3*(1-exp(-20*t))))*exp(-3*t)+0.4*(random(0)*2-1)*exp(-30*t)':s=44100:d=1.5" -af "lowpass=f=3000,aecho=0.8:0.6:60:0.3" "$out/impact.wav"
ff -f lavfi -i "aevalsrc='0.6*sin(2*PI*2200*t)*exp(-250*t)':s=44100:d=0.06" "$out/tick.wav"
ff -f lavfi -i "aevalsrc='0.5*(sin(2*PI*1318.5*t)+0.5*sin(2*PI*2637*t))*exp(-3*t)':s=44100:d=1.6" -af "aecho=0.8:0.5:120:0.3" "$out/ding.wav"
ff -f lavfi -i "aevalsrc='(t/2)*(0.3*(random(0)*2-1)+0.3*sin(2*PI*(200*t+250*t*t)))':s=44100:d=2" -af "highpass=f=300" "$out/riser.wav"
ls -la "$out"
