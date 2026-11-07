# runs inside the task container as root before the agent: trust the egress proxy CA, send apt/apk over https through the proxy
for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt; do [ -d $(dirname $f) ] && cat /etc/ccr-ca.crt > $f; done
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do [ -f "$f" ] && sed -i 's#http://#https://#g' "$f"; done
[ -d /etc/apt/apt.conf.d ] && printf 'Acquire::https::Proxy "%s";\n' "$HTTPS_PROXY" > /etc/apt/apt.conf.d/99proxy
[ -f /etc/apk/repositories ] && sed -i 's#http://#https://#g' /etc/apk/repositories
mkdir -p /logs/verifier /logs/agent
true
