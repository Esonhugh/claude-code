# sshlab:1 — throwaway sshd box for the ssh-s / ssh-l tasks. Faults are planted at start by ssh_lab_init.sh.
# Build: docker build -t sshlab:1 bench/labs/ssh
FROM mirror.gcr.io/library/ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server sudo && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
