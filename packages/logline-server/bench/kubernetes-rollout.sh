#!/usr/bin/env bash
# Destructive only to the named disposable benchmark deployment: restart both ingress pods.
# Run from repository root. Needs kubectl, a two-replica deployment and its Secret in this namespace.
set -euo pipefail
: "${KUBE_CONTEXT:?}" "${BENCH_NAMESPACE:?}"
[[ "${BENCH_DISPOSABLE:-}" == yes && "$BENCH_NAMESPACE" == logline-bench-* ]]
k(){ kubectl --context "$KUBE_CONTEXT" -n "$BENCH_NAMESPACE" "$@"; }
k rollout status deployment/logline-server --timeout=180s
probe=rollout-probe-$$
image=$(k get deployment logline-server -o 'jsonpath={.spec.template.spec.containers[0].image}')
# Capture immutable UIDs with the IPs: addresses may be reused during replacement.
pods(){ k get pod -l app=logline-server -o 'go-template={{range .items}}{{if and (eq .status.phase "Running") (not .metadata.deletionTimestamp)}}{{.metadata.uid}} {{.status.podIP}}{{"\n"}}{{end}}{{end}}'; }
old_rows=$(pods); [[ $(wc -w <<< "$old_rows") -eq 4 ]]
old=$(awk '{print $2}' <<< "$old_rows")
k create -f - <<YAML
apiVersion: v1
kind: Pod
metadata: { name: $probe }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext: {runAsNonRoot: true, runAsUser: 1000, seccompProfile: {type: RuntimeDefault}}
  containers:
  - name: probe
    image: $image
    command: [node, -e, 'setInterval(()=>{},60000)']
    securityContext: {allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}}
    env: [{name: LOGLINE_ADMIN_TOKEN, valueFrom: {secretKeyRef: {name: logline-server-secrets, key: LOGLINE_ADMIN_TOKEN}}}]
    volumeMounts: [{name: tmp, mountPath: /tmp}]
  volumes: [{name: tmp, emptyDir: {}}]
YAML
trap 'k delete pod "$probe" --ignore-not-found --wait=false >/dev/null' EXIT
k wait --for=condition=Ready pod/"$probe" --timeout=120s
k exec -i "$probe" -- env PODS="$old" node --input-type=module < packages/logline-server/bench/rolling.mjs &
worker=$!
for ((i=0; i<45; i++)); do
  if k exec "$probe" -- test -f /tmp/rolling-ready 2>/dev/null; then break; fi
  kill -0 "$worker" 2>/dev/null || { wait "$worker"; exit 1; }
  sleep 1
done
k exec "$probe" -- test -f /tmp/rolling-ready
k rollout restart deployment/logline-server
k rollout status deployment/logline-server --timeout=150s
# Exclude terminating instances before addressing both new replicas directly.
replaced(){
  [[ $(wc -w <<< "$fresh_rows") -eq 4 ]] &&
    awk 'NR==FNR {old[$1]=1; next} $1 in old {exit 1}' <(printf '%s\n' "$old_rows") <(printf '%s\n' "$fresh_rows")
}
for ((i=0; i<30; i++)); do
  fresh_rows=$(pods); replaced && break; sleep 1
done
replaced
fresh=$(awk '{print $2}' <<< "$fresh_rows")
printf '%s' "$fresh" | k exec -i "$probe" -- sh -c 'cat >/tmp/addresses && mv /tmp/addresses /tmp/rolling-new-pods'
wait "$worker"
