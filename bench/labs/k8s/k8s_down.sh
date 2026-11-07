#!/bin/bash
# k8s_down.sh <run-dir> <s|l> <namespace> : keep the final state for the record, then delete the namespace
R=$1 NS=$3 K="/opt/k3s/bin/kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml"
$K get all,ep,cm -n $NS -o yaml > $R/final-state.yaml 2>/dev/null
$K delete ns $NS --wait=false >/dev/null 2>&1; $K delete clusterrolebinding node-reader-$NS >/dev/null 2>&1
echo 0
