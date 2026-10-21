#!/bin/sh
set -eu
moto_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$moto_dir/compose.sh"

compose up -d moto
compose run --rm -T tools ready
printf '%s\n' 'S3 ready; provisioning buckets next.'
compose run --rm -T tools bootstrap
