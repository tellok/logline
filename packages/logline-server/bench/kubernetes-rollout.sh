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
pods(){ k get pod -l app=logline-server -o 'jsonpath={range .items[?(@.status.phase=="Running")]}{.status.podIP}{" "}{end}'; }
old=$(pods); [[ $(wc -w <<< "$old") -eq 2 ]]
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
for ((i=0; i<30; i++)); do
  fresh=$(pods); [[ $(wc -w <<< "$fresh") -eq 2 ]] && break; sleep 1
done
[[ $(wc -w <<< "$fresh") -eq 2 ]]
printf '%s' "$fresh" | k exec -i "$probe" -- sh -c 'cat >/tmp/addresses && mv /tmp/addresses /tmp/rolling-new-pods'
wait "$worker"
