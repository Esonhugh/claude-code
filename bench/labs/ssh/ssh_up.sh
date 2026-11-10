#!/bin/bash
# ssh_up.sh <run-dir> <s|l> <port> : start a fresh sshlab box for this run (container name = sshlab-<port>)
R=$1 V=$2 P=$3 L=$(dirname $(readlink -f $0))
mkdir -p $R/lab $R/w/keys $R/h/.ssh
ssh-keygen -q -t ed25519 -N '' -C lab-host -f $R/lab/ssh_host_ed25519_key
ssh-keygen -q -t ed25519 -N '' -C ops@laptop -f $R/w/keys/ops_key
ssh-keygen -q -t ed25519 -N '' -C ci-deploy -f $R/w/keys/deploy_key
cp $R/w/keys/*.pub $R/lab/; cp $L/ssh_lab_init.sh $R/lab/init.sh
echo "[127.0.0.1]:$P $(cut -d' ' -f1-2 $R/lab/ssh_host_ed25519_key.pub)" > $R/h/.ssh/known_hosts
# OpenSSH reads ~/.ssh from the passwd entry (/root), not $HOME: replace this port's entry there too, so no run sees a stale key from an earlier run
mkdir -p /root/.ssh; touch /root/.ssh/known_hosts
( flock 9; ssh-keygen -q -R "[127.0.0.1]:$P" -f /root/.ssh/known_hosts >/dev/null 2>&1; cat $R/h/.ssh/known_hosts >> /root/.ssh/known_hosts ) 9>/root/.ssh/.lab.lock
docker rm -f sshlab-$P >/dev/null 2>&1
docker run -d --name sshlab-$P --network host -v $R/lab:/lab:ro sshlab:1 /bin/bash /lab/init.sh $V $P >/dev/null
for i in $(seq 50); do ssh -o BatchMode=yes -o UserKnownHostsFile=$R/h/.ssh/known_hosts -i $R/w/keys/ops_key -p $P ops@127.0.0.1 true 2>/dev/null && exit 0; sleep 0.2; done
echo "sshlab-$P did not come up" >&2; docker logs sshlab-$P >&2; exit 1
