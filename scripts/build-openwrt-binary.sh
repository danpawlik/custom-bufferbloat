#!/usr/bin/env bash
# Cross-compile bufferbloat-test into bufferbloat-test/files/usr/bin/
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/bufferbloat-test/files/usr/bin"
mkdir -p "$OUT"

ARCH="${1:-arm64}"
case "$ARCH" in
  arm64|aarch64)
    export GOARCH=arm64
    unset GOARM GOMIPS
    ;;
  armv7|arm)
    export GOARCH=arm GOARM=7
    unset GOMIPS
    ;;
  mips|mips32)
    export GOARCH=mips GOMIPS=softfloat
    unset GOARM
    ;;
  mipsle|mipsel)
    export GOARCH=mipsle GOMIPS=softfloat
    unset GOARM
    ;;
  amd64|x86_64)
    export GOARCH=amd64
    unset GOARM GOMIPS
    ;;
  riscv64)
    export GOARCH=riscv64
    unset GOARM GOMIPS
    ;;
  *)
    echo "usage: $0 [arm64|armv7|mips|mipsle|amd64|riscv64]" >&2
    exit 1
    ;;
esac

export GOOS=linux CGO_ENABLED=0
go build -trimpath -buildvcs=false -ldflags="-s -w" -o "$OUT/bufferbloat-test" "$ROOT/cmd/server"
ls -lh "$OUT/bufferbloat-test"
echo "wrote $OUT/bufferbloat-test ($GOOS/$GOARCH${GOARM:+/GOARM=$GOARM}${GOMIPS:+/GOMIPS=$GOMIPS})"
