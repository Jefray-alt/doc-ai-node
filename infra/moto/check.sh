#!/bin/sh
set -eu
umask 077
moto_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$moto_dir/compose.sh"

compose run --rm -T tools smoke

check_tmp=$(mktemp -d "${TMPDIR:-/tmp}/moto-check.XXXXXXXX")
key="moto-smoke/host-$(basename "$check_tmp")"
cleanup() {
  result=$?
  trap - EXIT
  if ! compose run --rm -T tools cleanup "$key"; then
    printf 'ERROR: cleanup failed; rerun setup and remove pdf-staging/%s.\n' "$key" >&2
    result=1
  fi
  rm -rf -- "$check_tmp"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose run --rm -T -v "$check_tmp:/output" tools sign-put "$key"
printf '%s\n' '%PDF-1.4' 'Moto smoke fixture' > "$check_tmp/fixture.pdf"
# The URL lives only in a private temporary curl config, never argv or output.
if ! curl --disable --config "$check_tmp/upload.curl" --request OPTIONS \
  --header 'Access-Control-Request-Method: PUT' \
  --header 'Access-Control-Request-Headers: content-type' \
  --dump-header "$check_tmp/preflight.headers" --output "$check_tmp/response"; then
  printf '%s\n' 'ERROR: host upload preflight failed.' >&2
  exit 1
fi
if ! curl --disable --config "$check_tmp/upload.curl" --upload-file "$check_tmp/fixture.pdf" \
  --dump-header "$check_tmp/upload.headers" --output "$check_tmp/response"; then
  printf '%s\n' 'ERROR: host signed PUT failed.' >&2
  exit 1
fi
compose run --rm -T -v "$check_tmp:/output:ro" tools verify-host "$key"
printf '%s\n' 'All local storage checks passed; removing host fixture.'
