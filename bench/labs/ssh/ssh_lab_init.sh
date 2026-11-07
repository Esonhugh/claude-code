#!/bin/bash
# runs inside the sshlab container as PID 1: build the box, plant faults, exec sshd.  args: <variant s|l> <port>
set -e
V=$1 PORT=$2
cp /lab/ssh_host_ed25519_key /lab/ssh_host_ed25519_key.pub /etc/ssh/ && chmod 600 /etc/ssh/ssh_host_ed25519_key
cat > /etc/ssh/sshd_config.d/00-lab.conf <<C
Port $PORT
ListenAddress 127.0.0.1
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
StrictModes yes
LogLevel VERBOSE
C
useradd -m -s /bin/bash ops; usermod -p '*' ops; echo 'ops ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ops; chmod 440 /etc/sudoers.d/ops
mkdir -p /home/ops/.ssh; cp /lab/ops_key.pub /home/ops/.ssh/authorized_keys; chown -R ops:ops /home/ops/.ssh; chmod 700 /home/ops/.ssh; chmod 600 /home/ops/.ssh/authorized_keys
useradd -m -s /bin/bash deploy; usermod -p '*' deploy
mkdir -p /home/deploy/.ssh; chown deploy:deploy /home/deploy/.ssh; chmod 700 /home/deploy/.ssh
touch /var/log/sshd.log; chmod 640 /var/log/sshd.log; chgrp adm /var/log/sshd.log
if [ "$V" = s ]; then
  cp /lab/deploy_key.pub /home/deploy/.ssh/authorized_keys; chown deploy:deploy /home/deploy/.ssh/authorized_keys; chmod 600 /home/deploy/.ssh/authorized_keys
  chmod 0777 /home/deploy/.ssh                                   # fault: StrictModes rejects world-writable .ssh
else
  echo "from=\"10.0.0.0/8\" $(cat /lab/deploy_key.pub)" > /home/deploy/.ssh/authorized_keys   # fault: key only allowed from 10/8
  chown deploy:deploy /home/deploy/.ssh/authorized_keys; chmod 600 /home/deploy/.ssh/authorized_keys
  printf '# CIS hardening 2026-11-06 (change CHG-4411)\nAllowUsers ops deplyo\nMaxAuthTries 3\nX11Forwarding no\n' > /etc/ssh/sshd_config.d/50-hardening.conf   # fault: typo
  chmod 0775 /home/deploy                                        # fault: group-writable home
  usermod -s /usr/sbin/nologin deploy                            # fault: no shell
  mkdir -p /opt/app/bin /var/log/app; chmod 755 /var/log/app      # fault: log dir owned by root
  cat > /opt/app/bin/healthcheck <<'H'
#!/bin/sh
# deploy pipeline health gate: must print OK when run as the deploy user
echo "$(date -u +%FT%TZ) health ok" >> /var/log/app/health.log || { echo "FAIL: cannot write /var/log/app/health.log" >&2; exit 1; }
echo OK
H
  chmod 755 /opt/app/bin/healthcheck
  printf 'Deploy access runbook\n- The CI pipeline logs in as deploy@this-host with its ed25519 key and runs /opt/app/bin/healthcheck.\n- Only ops and deploy may log in over ssh. Password logins stay disabled.\n' > /home/ops/RUNBOOK.txt; chown ops:ops /home/ops/RUNBOOK.txt
fi
exec /usr/sbin/sshd -D -E /var/log/sshd.log
