#!/usr/bin/env bash
# Export the registry's exact multi-platform OCI object rather than rebuilding for the attachment.
set -euo pipefail
: "${REPOSITORY:?}" "${IMAGE_DIGEST:?}" "${RELEASE_TAG:?}"
image="$REPOSITORY:$RELEASE_TAG"
[[ "$(oras resolve "$image")" == "$IMAGE_DIGEST" ]]
for arch in amd64 arm64; do
  docker buildx imagetools inspect --raw "$REPOSITORY@$IMAGE_DIGEST" | jq -e --arg arch "$arch" 'any(.manifests[]; .platform.os=="linux" and .platform.architecture==$arch)' >/dev/null
  docker pull --platform "linux/$arch" "$image"
done
[[ "$(oras resolve "$image")" == "$IMAGE_DIGEST" ]]
out=$(mktemp -d)
oras cp --recursive --to-oci-layout "$REPOSITORY@$IMAGE_DIGEST" "$out/image:$RELEASE_TAG"
jq -e --arg digest "$IMAGE_DIGEST" 'any(.manifests[]; .digest==$digest)' "$out/image/index.json" >/dev/null
# Stable archives also allow a partial release to be recovered without clobbering existing assets.
pack() { tar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0 --mode=u=rwX,go=rX -C "$1" -cf - . | gzip -n > "$2"; }
pack "$out/image" "$out/logline-server.oci.tar.gz"
mkdir -p "$out/deployment/docs"
cp -R deploy/kubernetes "$out/deployment/"
# Remove source-only build instructions; this bundle runs the registry image, pinned by digest.
sed -e '/^    build:$/,+2d' -e "s|\${LOGLINE_IMAGE:-logline-server:local}|$image@$IMAGE_DIGEST|" compose.yml > "$out/deployment/compose.yml"
sed -i "s|ghcr.io/tellok/logline-server:replace-with-release-tag|$image@$IMAGE_DIGEST|" "$out/deployment/kubernetes/server.yaml"
cp .env.example "$out/deployment/"
cp docs/server-*.md "$out/deployment/docs/"
pack "$out/deployment" "$out/logline-server-deployment.tar.gz"
(cd "$out" && sha256sum logline-server{.oci,-deployment}.tar.gz > logline-server.sha256)
assets=$(gh release view "$RELEASE_TAG" --json assets --jq .assets)
for name in logline-server.oci.tar.gz logline-server-deployment.tar.gz logline-server.sha256; do
  if jq -e --arg n "$name" 'any(.[]; .name==$n)' <<< "$assets" >/dev/null; then
    expected="sha256:$(sha256sum "$out/$name" | cut -d' ' -f1)"
    jq -e --arg n "$name" --arg d "$expected" 'any(.[]; .name==$n and .digest==$d)' <<< "$assets" >/dev/null
  else
    gh release upload "$RELEASE_TAG" "$out/$name"
  fi
done
gh release view "$RELEASE_TAG" --json body --jq .body > "$out/notes.md"
if ! grep -Fxq "docker pull $image" "$out/notes.md"; then
  printf '\n### Logline Server (linux/amd64 and linux/arm64)\n\n```sh\ndocker pull %s\n```\n' "$image" >> "$out/notes.md"
  gh release edit "$RELEASE_TAG" --notes-file "$out/notes.md"
fi
