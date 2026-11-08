# runs inside the task container as root before the agent: trust the egress proxy CA, send apt/apk over https through the proxy
mkdir -p /etc/ssl/certs
cat /etc/ccr-ca.crt > /etc/ssl/certs/ca-certificates.crt
[ -d /etc/pki/tls/certs ] && cat /etc/ccr-ca.crt > /etc/pki/tls/certs/ca-bundle.crt
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do [ -f "$f" ] && sed -i 's#http://#https://#g' "$f"; done
[ -d /etc/apt/apt.conf.d ] && printf 'Acquire::https::Proxy "%s";\nAcquire::https::CaInfo "/etc/ccr-ca.crt";\n' "$HTTPS_PROXY" > /etc/apt/apt.conf.d/99proxy
[ -f /etc/apk/repositories ] && sed -i 's#http://#https://#g' /etc/apk/repositories
mkdir -p /logs/verifier /logs/agent
true
