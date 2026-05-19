#!/usr/bin/env bash
#
# Builds the patched FullNode.jar from docker/src and stages it at
# tre/FullNode.jar. The consumer's container config mounts that
# file over the image's stock jar so the container starts already
# patched — no in-flight restart, no race with pre-approve.
#
# Run this once after each change to docker/src/**/*.java. The
# output jar is gitignored.
#
# Strategy: spin up a TEMP `tronbox/tre:dev` container, use ITS
# Java toolchain (OpenJDK 8 + the unpatched FullNode.jar as
# classpath) to compile the patch, pull the resulting jar back to
# the host, tear the temp container down.
#
set -euo pipefail
cd "$(dirname "$0")/.."

TEMP="hardhat-tron-jar-build-$$"
OUT="tre/FullNode.jar"

cleanup() {
  docker rm -f "$TEMP" >/dev/null 2>&1 || true
  rm -rf /tmp/_hardhat-tron-build-staging /tmp/_hardhat-tron-upstream.jar /tmp/_hardhat-tron-patched.jar 2>/dev/null || true
}
trap cleanup EXIT

echo "→ Spinning up temp build container..."
docker run -d --name "$TEMP" --entrypoint sleep tronbox/tre:dev infinity >/dev/null

echo "→ Compiling patch sources..."
docker exec "$TEMP" rm -rf /tmp/src /tmp/build
docker cp docker/src "$TEMP:/tmp/src"
docker exec "$TEMP" sh -c '
  mkdir -p /tmp/build
  javac -encoding UTF-8 -classpath /tron/FullNode/FullNode.jar -d /tmp/build \
    /tmp/src/org/tron/consensus/dpos/DposSlot.java \
    /tmp/src/org/tron/core/capsule/TransactionCapsule.java \
    /tmp/src/org/tron/core/services/jsonrpc/tre/TreImpersonationRegistry.java \
    /tmp/src/org/tron/core/services/jsonrpc/tre/TreJsonRpc.java \
    /tmp/src/org/tron/core/services/jsonrpc/tre/TreJsonRpcImpl.java
'

echo "→ Repacking jar..."
docker cp "$TEMP:/tron/FullNode/FullNode.jar" /tmp/_hardhat-tron-upstream.jar
docker cp "$TEMP:/tmp/build" /tmp/_hardhat-tron-build-staging
python3 - <<'PY'
import os
import zipfile
src = "/tmp/_hardhat-tron-upstream.jar"
dst = "/tmp/_hardhat-tron-patched.jar"
staging = "/tmp/_hardhat-tron-build-staging"

# Glob every .class produced by the patch compile (top-level classes
# PLUS their nested inner classes — e.g. TreJsonRpcImpl$SnapshotEntry.class).
# Anything emitted into the staging tree replaces the corresponding
# entry in the upstream jar.
patches = {}
for root, _, files in os.walk(staging):
    for f in files:
        if not f.endswith(".class"):
            continue
        abs_path = os.path.join(root, f)
        rel_path = os.path.relpath(abs_path, staging)
        patches[rel_path] = abs_path
print(f"patching {len(patches)} class file(s):")
for k in sorted(patches):
    print(f"  {k}")

with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    seen = set()
    for item in zin.infolist():
        if item.filename in patches or item.filename in seen:
            continue
        seen.add(item.filename)
        zout.writestr(item, zin.read(item.filename))
    for name, path in patches.items():
        zout.writestr(name, open(path, "rb").read())
print("repack OK")
PY

mkdir -p "$(dirname "$OUT")"
mv /tmp/_hardhat-tron-patched.jar "$OUT"
echo ""
echo "Patched jar staged at: $OUT"
echo "Wire it into your hardhat config via tre.jarPath, then 'npx hardhat test'"
echo "starts a fresh container with the patch baked in."
