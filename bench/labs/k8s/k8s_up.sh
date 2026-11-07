#!/bin/bash
# k8s_up.sh <run-dir> <s|l> <namespace> : namespace + manifests + namespaced admin kubeconfig in $R/h/.kube/config
R=$1 V=$2 NS=$3 L=$(dirname $(readlink -f $0)) K="/opt/k3s/bin/kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml"
$K delete ns $NS --wait=true >/dev/null 2>&1
$K create ns $NS >/dev/null && $K -n $NS create sa oncall >/dev/null
$K -n $NS create rolebinding oncall-admin --clusterrole=admin --serviceaccount=$NS:oncall >/dev/null
$K get clusterrole node-reader >/dev/null 2>&1 || $K create clusterrole node-reader --verb=get,list,watch --resource=nodes >/dev/null
$K create clusterrolebinding node-reader-$NS --clusterrole=node-reader --serviceaccount=$NS:oncall >/dev/null 2>&1
$K -n $NS apply -f $L/k8s_$V.yaml >/dev/null
TOKEN=$($K -n $NS create token oncall --duration=3h)
mkdir -p $R/h/.kube
python3 - "$R/h/.kube/config" "$NS" "$TOKEN" <<'P'
import sys, yaml
p, ns, tok = sys.argv[1:]
c = yaml.safe_load(open('/etc/rancher/k3s/k3s.yaml'))
c['contexts'][0]['context']['namespace'] = ns; c['contexts'][0]['name'] = 'prod'; c['current-context'] = 'prod'
c['users'] = [{'name': 'oncall', 'user': {'token': tok}}]; c['contexts'][0]['context']['user'] = 'oncall'
c['clusters'][0]['name'] = 'prod'; c['contexts'][0]['context']['cluster'] = 'prod'
yaml.safe_dump(c, open(p, 'w'))
P
chmod 600 $R/h/.kube/config
