#!/bin/bash
# ssh_down.sh <run-dir> <s|l> <port> : count docker execs into the box during the agent run (must be 0), then remove it
R=$1 P=$3 T0=$4 T1=$5
EX=$(timeout 5 docker events --since "$T0" --until "$T1" --filter container=sshlab-$P --filter event=exec_start 2>/dev/null | wc -l)
docker rm -f sshlab-$P >/dev/null 2>&1
echo "$EX"
